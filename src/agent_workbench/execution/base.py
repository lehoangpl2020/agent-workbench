"""
Executor contract — Component 2/3
Runs the code the LLM generated and returns stdout/stderr/exit_code + artifacts.

Three executors (local.py, docker_ephemeral.py, docker_persistent.py) share one interface: `await executor.execute(code, workspace=..., iteration=..., timeout=...)`:
  - LocalExecutor             subprocess on the host (dev/test only, NOT safe)
  - SandboxExecutor           one new Docker container per run (ephemeral)
  - PersistentSandboxExecutor `docker exec` into the already-running `agent-workbench-sandbox` container

Shared logic lives in BaseExecutor.execute():
  1. Write the code to <run>/code/iter_NN.py
  2. Run it (_run) with a real timeout; on timeout → kill the process
  3. On cancel (the user pressed Stop) → kill the process, then raise CancelledError
  4. Compare output/ before/after → artifacts of the iteration + snapshot

All Docker SDK / subprocess calls are blocking, so they run in a thread
(asyncio.to_thread) and the event loop can keep serving other requests (Stop, /health).
"""

import asyncio
import itertools
import logging
import tempfile
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Awaitable, Callable

from agent_workbench.domain.events import Flow, artifact_label
from agent_workbench.domain.schemas import ExecutionResult
from agent_workbench.observability.runlog import ERROR, INFO, WARN, LogFn, fmt_bytes, no_log
from agent_workbench.storage.workspace import RunWorkspace
from agent_workbench.tools.image import tool_url

logger = logging.getLogger(__name__)

# Extra grace period (seconds) after the timeout before Python kills the process itself
# (in case the `timeout` command inside the container did not stop it in time).
TIMEOUT_GRACE_SECONDS = 10
PIP_TIMEOUT_SECONDS = 120
MAX_STDOUT = 10_000
MAX_STDERR = 5_000


# Reports progress outward: progress(phase, text), e.g. ("installing", "Installing 'seaborn'")
ProgressFn = Callable[[str, str], Awaitable[None]]


async def notify_progress(progress: ProgressFn | None, phase: str, text: str) -> None:
    if progress is not None:
        await progress(phase, text)


class SandboxUnavailable(RuntimeError):
    """Infrastructure error (Docker/sandbox unavailable): the LLM cannot fix it by itself."""


@dataclass
class RawRun:
    exit_code: int
    stdout: str
    stderr: str
    timed_out: bool = False


def decode_output(data: bytes | None) -> str:
    return (data or b"").decode("utf-8", errors="replace")


class BaseExecutor:
    name = "base"

    def __init__(self, timeout: int = 30, runs_dir: str | Path | None = None):
        self.timeout = timeout
        self.runs_dir = Path(runs_dir or Path(tempfile.gettempdir()) / "agent-workbench-runs")
        self._counter = itertools.count(1)
        # The server as the SANDBOX reaches it. Set by api/app.py only when the image tool is on; None = not offered.
        self.image_tool_url: str | None = None

    def tool_env(self, workspace: RunWorkspace) -> dict[str, str]:
        """Environment variables that tell the code which tools it may call. Never secrets: only a URL for this run."""
        if not self.image_tool_url:
            return {}
        return {"IMAGE_TOOL_URL": tool_url(self.image_tool_url, workspace.run_id)}

    # ── Public API ─────────────────────────────────
    async def execute(
        self,
        code: str,
        language: str = "python",
        *,
        workspace: RunWorkspace | None = None,
        iteration: int | None = None,
        timeout: int | None = None,
        progress: ProgressFn | None = None,
        log: LogFn | None = None,
    ) -> ExecutionResult:
        log = log or no_log
        # Legacy call style (no workspace) → create a private temporary workspace
        workspace = workspace or RunWorkspace(self.runs_dir, str(uuid.uuid4())).create()
        iteration = iteration or next(self._counter)
        timeout = int(timeout or self.timeout)

        async def report(phase: str, text: str) -> None:
            # Progress from a subclass (package install, re-run...) → both the "current action" and a log entry
            await notify_progress(progress, phase, text)
            if phase in (Flow.INSTALLING, Flow.RERUNNING, Flow.INSTALL_FAILED):
                await log(WARN if phase == Flow.INSTALL_FAILED else INFO, "sandbox", text, flow=phase)

        code_path = workspace.write_code(
            iteration, self.prepare_code(code, workspace), code_extension(language)
        )
        await log(INFO, "sandbox", f"Wrote code to code/{code_path.name}",
                  lines=len(code.splitlines()), chars=len(code), flow=Flow.HANDOFF)
        # Directory walks and snapshot copies (files up to 20 MB) are blocking I/O: keep them off the event loop
        before = await asyncio.to_thread(workspace.scan)
        await log(INFO, "sandbox", f"Starting execution ({self.describe()}, timeout {timeout}s)", flow=Flow.EXECUTING)
        start = time.monotonic()

        try:
            raw = await asyncio.wait_for(
                self._run(workspace, code_path, language, timeout, report),
                timeout=self._guard_seconds(timeout),
            )
        except asyncio.CancelledError:
            # The user pressed Stop → the real process must be stopped, not just abandoned
            logger.info(f"[{workspace.run_id}] Execution cancelled → killing process")
            await log(WARN, "sandbox", "Execution cancelled — killing the running process", flow=Flow.KILLED)
            await self._kill_safely(workspace)
            await log(WARN, "sandbox", f"Process killed after {time.monotonic() - start:.1f}s", flow=Flow.KILLED)
            raise
        except asyncio.TimeoutError:
            logger.warning(f"[{workspace.run_id}] Timeout guard fired → killing process")
            await self._kill_safely(workspace)
            raw = RawRun(124, "", "", timed_out=True)
        except SandboxUnavailable as e:
            await log(ERROR, "sandbox", f"Sandbox unavailable: {e}")
            return ExecutionResult(
                stderr=str(e),
                exit_code=-1,
                system_error=True,
                execution_time_ms=(time.monotonic() - start) * 1000,
            )
        except Exception as e:
            logger.exception(f"[{workspace.run_id}] Unexpected executor error")
            await log(ERROR, "sandbox", f"Executor error: {type(e).__name__}: {e}")
            return ExecutionResult(
                stderr=f"{self.name} executor error: {type(e).__name__}: {e}",
                exit_code=-1,
                system_error=True,
                execution_time_ms=(time.monotonic() - start) * 1000,
            )

        elapsed_ms = (time.monotonic() - start) * 1000
        stderr = raw.stderr
        exit_code = raw.exit_code
        # 124 = standard exit code of the `timeout` command; 137 = killed by SIGKILL
        timed_out = raw.timed_out or exit_code == 124 or (
            exit_code == 137 and elapsed_ms >= timeout * 1000
        )
        if timed_out:
            exit_code = 124
            stderr = (stderr.rstrip() + "\n" if stderr.strip() else "") + (
                f"Execution timed out after {timeout}s — the process was killed."
            )
        elif exit_code == 137:
            stderr += "\nProcess was killed (exit 137) — possibly out of memory."

        if timed_out:
            await log(WARN, "sandbox", f"Execution timed out after {timeout}s — process killed",
                      exit_code=exit_code, time_ms=round(elapsed_ms), flow=Flow.EXITED)
        else:
            await log(INFO if exit_code == 0 else WARN, "sandbox",
                      f"Execution finished: exit code {exit_code} in {elapsed_ms / 1000:.2f}s",
                      exit_code=exit_code, time_ms=round(elapsed_ms),
                      stdout_bytes=len(raw.stdout), stderr_bytes=len(stderr), flow=Flow.EXITED)

        await notify_progress(progress, "collecting", "Collecting files from /workspace/output")
        changed, sizes = await asyncio.to_thread(self._collect, workspace, before, iteration)
        artifacts = {p: artifact_label(sizes[p][0]) for p in changed if p in sizes}
        if artifacts:
            listing = ", ".join(f"{p} ({fmt_bytes(sizes[p][0])})" for p in artifacts)
            await log(INFO, "sandbox", f"Collected {len(artifacts)} new/changed file(s): {listing}",
                      flow=Flow.ARTIFACTS, files={p: sizes[p][0] for p in artifacts})
        else:
            await log(INFO, "sandbox", "No new or changed files in /workspace/output", flow=Flow.NO_FILES)

        logger.info(
            f"[{workspace.run_id}] iter {iteration}: exit_code={exit_code}, "
            f"time={elapsed_ms:.0f}ms, timed_out={timed_out}, artifacts={len(artifacts)}"
        )
        return ExecutionResult(
            stdout=raw.stdout[:MAX_STDOUT],
            stderr=stderr[-MAX_STDERR:],
            exit_code=exit_code,
            execution_time_ms=elapsed_ms,
            artifacts=artifacts,
            timed_out=timed_out,
        )

    @staticmethod
    def _collect(workspace: RunWorkspace, before: dict, iteration: int):
        """Files created/changed by this run (snapshotted per iteration) and the current size of every file."""
        after = workspace.scan()
        changed = workspace.changed_files(before, after)
        workspace.snapshot(iteration, changed)
        return changed, after

    def describe(self) -> str:
        return self.name

    def _guard_seconds(self, timeout: int) -> float:
        """Maximum time Python waits before killing the process itself (safety net after the real timeout)."""
        return timeout + TIMEOUT_GRACE_SECONDS

    # ── Subclass hooks ─────────────────────────────
    def prepare_code(self, code: str, workspace: RunWorkspace) -> str:
        return code

    async def _run(
        self,
        workspace: RunWorkspace,
        code_path: Path,
        language: str,
        timeout: int,
        progress: ProgressFn | None = None,
    ) -> RawRun:
        raise NotImplementedError

    async def _kill(self, workspace: RunWorkspace) -> None:
        raise NotImplementedError

    async def _kill_safely(self, workspace: RunWorkspace) -> None:
        try:
            await self._kill(workspace)
        except Exception:
            logger.exception(f"[{workspace.run_id}] Kill failed")


# ─── helpers ──────────────────────────────────────
def code_extension(language: str) -> str:
    return {"python": "py", "javascript": "js", "bash": "sh"}.get(language, "py")


def dot_extension(language: str) -> str:
    return "." + code_extension(language)


def interpreter_for(language: str) -> str:
    return {"python": "python", "javascript": "node", "bash": "bash"}.get(language, "python")


def call_quietly(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except Exception:
        return None
