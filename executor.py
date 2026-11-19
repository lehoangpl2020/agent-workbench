"""
Sandbox Executor — Component 2/3
Chạy code LLM sinh ra, trả về stdout/stderr/exit_code + artifacts.

3 executor, chung 1 interface `await executor.execute(code, workspace=..., iteration=..., timeout=...)`:
  - LocalExecutor             subprocess trên máy (dev/test, KHÔNG an toàn)
  - SandboxExecutor           mỗi lần chạy tạo 1 container Docker mới (ephemeral)
  - PersistentSandboxExecutor docker exec vào container chạy sẵn `agent-workbench-sandbox`

Logic chung nằm ở BaseExecutor.execute():
  1. Ghi code vào <run>/code/iter_NN.py
  2. Chạy (_run) với timeout thật; hết giờ → kill process
  3. Bị cancel (user bấm Stop) → kill process rồi mới raise CancelledError
  4. So sánh output/ trước/sau → artifacts của iteration + snapshot

Các lời gọi Docker SDK / subprocess đều là blocking → chạy trong thread
(asyncio.to_thread) để event loop vẫn nhận request khác (Stop, /health).
"""

import asyncio
import itertools
import logging
import os
import re
import subprocess
import sys
import tempfile
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Awaitable, Callable

from runlog import ERROR, INFO, WARN, LogFn, fmt_bytes, no_log
from schemas import ExecutionResult
from workspace import RunWorkspace

logger = logging.getLogger(__name__)

# Chờ thêm bao lâu (giây) sau timeout trước khi Python tự kill (phòng khi lệnh
# `timeout` trong container không kịp dừng process).
TIMEOUT_GRACE_SECONDS = 10
PIP_TIMEOUT_SECONDS = 120
MAX_STDOUT = 10_000
MAX_STDERR = 5_000
# Không truyền secret của server vào code do LLM sinh ra
_SECRET_ENV = re.compile(r"(KEY|TOKEN|SECRET|PASSWORD)", re.IGNORECASE)


# Báo tiến độ ra ngoài: progress(phase, text) — vd ("installing", "Installing 'seaborn'")
ProgressFn = Callable[[str, str], Awaitable[None]]


async def _notify(progress: ProgressFn | None, phase: str, text: str) -> None:
    if progress is not None:
        await progress(phase, text)


class SandboxUnavailable(RuntimeError):
    """Lỗi hạ tầng (Docker/sandbox không sẵn sàng) — LLM không tự sửa được."""


@dataclass
class RawRun:
    exit_code: int
    stdout: str
    stderr: str
    timed_out: bool = False


def _decode(data: bytes | None) -> str:
    return (data or b"").decode("utf-8", errors="replace")


class BaseExecutor:
    name = "base"

    def __init__(self, timeout: int = 30, runs_dir: str | Path | None = None):
        self.timeout = timeout
        self.runs_dir = Path(runs_dir or Path(tempfile.gettempdir()) / "agent-workbench-runs")
        self._counter = itertools.count(1)

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
        # Gọi kiểu cũ (không có workspace) → tạo workspace tạm riêng
        workspace = workspace or RunWorkspace(self.runs_dir, str(uuid.uuid4())).create()
        iteration = iteration or next(self._counter)
        timeout = int(timeout or self.timeout)

        async def report(phase: str, text: str) -> None:
            # Tiến độ từ subclass (cài package, chạy lại...) → vừa là "current action" vừa là log
            await _notify(progress, phase, text)
            if phase in ("installing", "rerunning", "install_failed"):
                await log(WARN if phase == "install_failed" else INFO, "sandbox", text, flow=phase)

        code_path = workspace.write_code(
            iteration, self.prepare_code(code, workspace), _extension(language)
        )
        await log(INFO, "sandbox", f"Wrote code to code/{code_path.name}",
                  lines=len(code.splitlines()), chars=len(code))
        before = workspace.scan()
        await log(INFO, "sandbox", f"Starting execution ({self.describe()}, timeout {timeout}s)", flow="executing")
        start = time.monotonic()

        try:
            raw = await asyncio.wait_for(
                self._run(workspace, code_path, language, timeout, report),
                timeout=self._guard_seconds(timeout),
            )
        except asyncio.CancelledError:
            # User bấm Stop → phải dừng process thật, không chỉ bỏ chờ
            logger.info(f"[{workspace.run_id}] Execution cancelled → killing process")
            await log(WARN, "sandbox", "Execution cancelled — killing the running process")
            await self._kill_safely(workspace)
            await log(WARN, "sandbox", f"Process killed after {time.monotonic() - start:.1f}s")
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
        # 124 = mã thoát chuẩn của lệnh `timeout`; 137 = bị SIGKILL
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
                      exit_code=exit_code, time_ms=round(elapsed_ms))
        else:
            await log(INFO if exit_code == 0 else WARN, "sandbox",
                      f"Execution finished: exit code {exit_code} in {elapsed_ms / 1000:.2f}s",
                      exit_code=exit_code, time_ms=round(elapsed_ms),
                      stdout_bytes=len(raw.stdout), stderr_bytes=len(stderr))

        await _notify(progress, "collecting", "Collecting files from /workspace/output")
        changed = workspace.changed_files(before, workspace.scan())
        workspace.snapshot(iteration, changed)
        sizes = workspace.scan()
        artifacts = {p: f"<file: {sizes[p][0]} bytes>" for p in changed if p in sizes}
        if artifacts:
            listing = ", ".join(f"{p} ({fmt_bytes(sizes[p][0])})" for p in artifacts)
            await log(INFO, "sandbox", f"Collected {len(artifacts)} new/changed file(s): {listing}",
                      flow="artifacts", files={p: sizes[p][0] for p in artifacts})
        else:
            await log(INFO, "sandbox", "No new or changed files in /workspace/output")

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

    def describe(self) -> str:
        return self.name

    def _guard_seconds(self, timeout: int) -> float:
        """Thời gian tối đa Python chờ trước khi tự kill (lưới an toàn sau timeout thật)."""
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


# ═══════════════════════════════════════════════════
# LocalExecutor — subprocess, không Docker
# ═══════════════════════════════════════════════════
class LocalExecutor(BaseExecutor):
    """
    Chạy code bằng subprocess trên chính máy chạy server.
    Dùng cho dev/test. KHÔNG an toàn: code có toàn quyền như user đang chạy server.
    """

    name = "local"

    def __init__(self, timeout: int = 30, runs_dir=None, python: str | None = None):
        super().__init__(timeout=timeout, runs_dir=runs_dir)
        self.python = python or os.getenv("LOCAL_PYTHON") or sys.executable
        self._procs: dict[str, subprocess.Popen] = {}

    def prepare_code(self, code: str, workspace: RunWorkspace) -> str:
        # Prompt dặn model lưu file vào /workspace/output → map sang output/ của run
        return code.replace("/workspace/output", workspace.output_dir.resolve().as_posix())

    async def _run(self, workspace, code_path, language, timeout, progress=None) -> RawRun:
        env = {k: v for k, v in os.environ.items() if not _SECRET_ENV.search(k)}
        env.update(
            OUTPUT_DIR=str(workspace.output_dir.resolve()),
            MPLBACKEND="Agg",
            PYTHONIOENCODING="utf-8",
        )
        proc = subprocess.Popen(
            [self.python, str(code_path.resolve())],
            cwd=workspace.output_dir,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )
        self._procs[workspace.run_id] = proc
        try:
            return await asyncio.to_thread(self._communicate, proc, timeout)
        finally:
            # Bị cancel (Stop) hoặc timeout guard → process vẫn chạy → kill ngay
            if proc.poll() is None:
                proc.kill()
            self._procs.pop(workspace.run_id, None)

    @staticmethod
    def _communicate(proc: subprocess.Popen, timeout: int) -> RawRun:
        try:
            out, err = proc.communicate(timeout=timeout)
            return RawRun(proc.returncode, _decode(out), _decode(err))
        except subprocess.TimeoutExpired:
            proc.kill()
            out, err = proc.communicate()
            return RawRun(124, _decode(out), _decode(err), timed_out=True)

    async def _kill(self, workspace) -> None:
        proc = self._procs.get(workspace.run_id)
        if proc and proc.poll() is None:
            proc.kill()


# ═══════════════════════════════════════════════════
# SandboxExecutor — container mới cho mỗi lần chạy
# ═══════════════════════════════════════════════════
class SandboxExecutor(BaseExecutor):
    """
    Mỗi lần chạy tạo 1 container mới, mount:
      code file (read-only) → /workspace/code.py
      output/ của run       → /workspace/output
    Giới hạn memory, CPU, network, non-root, drop capabilities.

    Lưu ý: bind mount dùng path trên máy host → dùng khi server chạy trực tiếp
    trên host (không phải trong container).
    """

    name = "docker-ephemeral"

    def __init__(
        self,
        image: str = "agent-workbench-sandbox:latest",
        timeout: int = 30,
        memory_limit: str = "256m",
        cpu_count: float = 1.0,
        network_disabled: bool = True,
        runs_dir=None,
    ):
        super().__init__(timeout=timeout, runs_dir=runs_dir)
        import docker

        self._docker = docker
        self.client = docker.from_env()
        self.image = image
        self.memory_limit = memory_limit
        self.cpu_count = cpu_count
        self.network_disabled = network_disabled
        self._containers: dict[str, object] = {}
        try:
            self.client.images.get(self.image)
            logger.info(f"Sandbox image '{self.image}' found")
        except docker.errors.ImageNotFound:
            logger.warning(
                f"Image '{self.image}' not found. "
                "Build it with: docker build -t agent-workbench-sandbox -f Dockerfile.sandbox ."
            )

    async def _run(self, workspace, code_path, language, timeout, progress=None) -> RawRun:
        script = (
            "cd /workspace/output && "
            f"exec timeout -k 2 {timeout} {_interpreter(language)} /workspace/code{_dot_ext(language)}"
        )

        def start():
            try:
                return self.client.containers.run(
                    image=self.image,
                    command=["sh", "-c", script],
                    volumes={
                        str(code_path.resolve()): {
                            "bind": f"/workspace/code{_dot_ext(language)}",
                            "mode": "ro",
                        },
                        str(workspace.output_dir.resolve()): {
                            "bind": "/workspace/output",
                            "mode": "rw",
                        },
                    },
                    environment={"OUTPUT_DIR": "/workspace/output", "MPLBACKEND": "Agg"},
                    mem_limit=self.memory_limit,
                    nano_cpus=int(self.cpu_count * 1e9),
                    network_disabled=self.network_disabled,
                    detach=True,
                    security_opt=["no-new-privileges"],
                    cap_drop=["ALL"],
                    tmpfs={"/tmp": "size=50m"},
                )
            except self._docker.errors.ImageNotFound as e:
                raise SandboxUnavailable(
                    f"Sandbox image '{self.image}' not found. "
                    "Run: docker build -t agent-workbench-sandbox -f Dockerfile.sandbox ."
                ) from e
            except self._docker.errors.DockerException as e:
                raise SandboxUnavailable(f"Docker error: {e}") from e

        container = await asyncio.to_thread(start)
        self._containers[workspace.run_id] = container
        try:
            status = await asyncio.to_thread(container.wait)
            stdout = await asyncio.to_thread(container.logs, stdout=True, stderr=False)
            stderr = await asyncio.to_thread(container.logs, stdout=False, stderr=True)
            return RawRun(status.get("StatusCode", -1), _decode(stdout), _decode(stderr))
        finally:
            self._containers.pop(workspace.run_id, None)
            # remove(force=True) cũng kill container nếu còn chạy (vd khi bị cancel)
            await asyncio.to_thread(_quiet, container.remove, force=True)

    async def _kill(self, workspace) -> None:
        container = self._containers.get(workspace.run_id)
        if container is not None:
            await asyncio.to_thread(_quiet, container.kill)


# ═══════════════════════════════════════════════════
# PersistentSandboxExecutor — docker exec vào container chạy sẵn
# ═══════════════════════════════════════════════════

# Chạy BÊN TRONG sandbox để kill mọi process của 1 run (image slim không có pkill).
_KILL_SNIPPET = r"""
import os, signal, sys
marker, me = sys.argv[1], os.getpid()
for pid in os.listdir('/proc'):
    if not pid.isdigit() or int(pid) == me:
        continue
    try:
        with open(f'/proc/{pid}/cmdline', 'rb') as f:
            cmd = f.read().decode('utf-8', 'ignore')
    except OSError:
        continue
    if marker in cmd:
        try:
            os.kill(int(pid), signal.SIGKILL)
            print('killed', pid)
        except OSError:
            pass
"""


class PersistentSandboxExecutor(BaseExecutor):
    """
    Dùng container sandbox chạy sẵn (docker compose service `sandbox`), chạy code
    bằng `docker exec`.

    Server và sandbox cùng mount 1 volume chứa thư mục run:
        server:  <RUNS_DIR>/<run_id>/...           (vd /data/runs/...)
        sandbox: <SANDBOX_RUNS_DIR>/<run_id>/...   (vd /workspace/runs/...)
    → server ghi code, sandbox chạy, server đọc artifacts trực tiếp trên disk.

    Mỗi lần chạy: /workspace/output được trỏ (symlink) vào output/ của run hiện tại,
    nên prompt "save to /workspace/output" vẫn đúng mà không lẫn file giữa các run.
    Timeout dùng lệnh `timeout` của coreutils trong container; Stop dùng _KILL_SNIPPET.
    """

    name = "docker-persistent"

    PIP_NAME_MAP = {
        "cv2": "opencv-python",
        "sklearn": "scikit-learn",
        "bs4": "beautifulsoup4",
        "PIL": "Pillow",
        "yaml": "pyyaml",
        "docx": "python-docx",
        "pptx": "python-pptx",
        "dotenv": "python-dotenv",
        "jose": "python-jose",
        "magic": "python-magic",
        "gi": "PyGObject",
        "attr": "attrs",
        "dateutil": "python-dateutil",
        "lxml": "lxml",
    }

    def __init__(
        self,
        container_name: str = "agent-workbench-sandbox",
        timeout: int = 30,
        auto_install: bool = True,
        max_install_retries: int = 2,
        runs_dir=None,
        sandbox_runs_dir: str = "/workspace/runs",
    ):
        super().__init__(timeout=timeout, runs_dir=runs_dir)
        import docker

        self._docker = docker
        self.client = docker.from_env()
        self.container_name = container_name
        self.auto_install = auto_install
        self.max_install_retries = max_install_retries
        self.sandbox_runs_dir = sandbox_runs_dir.rstrip("/")

    def describe(self) -> str:
        return f"{self.name} ({self.container_name})"

    def _get_container(self):
        try:
            container = self.client.containers.get(self.container_name)
        except self._docker.errors.NotFound as e:
            raise SandboxUnavailable(
                f"Container '{self.container_name}' not found. "
                "Run: docker compose up sandbox -d"
            ) from e
        except self._docker.errors.DockerException as e:
            raise SandboxUnavailable(f"Docker error: {e}") from e
        if container.status != "running":
            logger.warning(f"Container '{self.container_name}' status={container.status}. Starting...")
            container.start()
        return container

    def _guard_seconds(self, timeout: int) -> float:
        # Mỗi lần auto-install: pip (tối đa 120s) + chạy lại code (tối đa `timeout`)
        retries = self.max_install_retries if self.auto_install else 0
        return (timeout + TIMEOUT_GRACE_SECONDS) * (1 + retries) + PIP_TIMEOUT_SECONDS * retries

    def _marker(self, workspace: RunWorkspace) -> str:
        return f"{self.sandbox_runs_dir}/{workspace.run_id}/"

    async def _run(self, workspace, code_path, language, timeout, progress=None) -> RawRun:
        container = await asyncio.to_thread(self._get_container)
        run_dir = f"{self.sandbox_runs_dir}/{workspace.run_id}"
        code_in_sandbox = f"{run_dir}/code/{code_path.name}"
        out_in_sandbox = f"{run_dir}/output"

        # Sandbox phải thấy được file code server vừa ghi (shared volume)
        check = await asyncio.to_thread(
            container.exec_run, ["test", "-f", code_in_sandbox], user="sandbox"
        )
        if check.exit_code != 0:
            raise SandboxUnavailable(
                f"Sandbox cannot see {code_in_sandbox}. Server RUNS_DIR and sandbox "
                f"{self.sandbox_runs_dir} must be the same volume (see docker-compose.yml)."
            )

        script = (
            f"rm -rf /workspace/output 2>/dev/null; "
            f"ln -sfn {out_in_sandbox} /workspace/output 2>/dev/null; "
            f"cd {out_in_sandbox} && "
            f"exec timeout -k 2 {timeout} {_interpreter(language)} {code_in_sandbox}"
        )
        return await self._run_with_auto_install(
            container, ["sh", "-c", script], workspace.run_id, progress
        )

    def _exec(self, container, cmd) -> RawRun:
        exit_code, output = container.exec_run(
            cmd=cmd,
            stdout=True,
            stderr=True,
            demux=True,
            user="sandbox",
            workdir="/workspace",
            environment={"OUTPUT_DIR": "/workspace/output", "MPLBACKEND": "Agg"},
        )
        stdout, stderr = output if output else (b"", b"")
        return RawRun(exit_code, _decode(stdout), _decode(stderr))

    async def _run_with_auto_install(
        self, container, cmd, run_id: str, progress: ProgressFn | None = None
    ) -> RawRun:
        """Chạy code; gặp ModuleNotFoundError thì pip install rồi chạy lại (báo tiến độ từng bước)."""
        installed: set[str] = set()
        raw = await asyncio.to_thread(self._exec, container, cmd)
        for _ in range(self.max_install_retries):
            if raw.exit_code == 0 or not self.auto_install:
                break
            missing = self._extract_missing_module(raw.stderr)
            if not missing or missing in installed:
                break
            pip_name = self.PIP_NAME_MAP.get(missing, missing)
            await _notify(progress, "installing", f"Installing missing package '{pip_name}'")
            if not await asyncio.to_thread(self._pip_install, container, missing):
                await _notify(progress, "install_failed", f"Could not install '{pip_name}'")
                break
            installed.add(missing)
            logger.info(f"[{run_id}] Retrying after installing '{missing}'")
            await _notify(progress, "rerunning", f"Re-running the code after installing '{pip_name}'")
            raw = await asyncio.to_thread(self._exec, container, cmd)
        return raw

    @staticmethod
    def _extract_missing_module(stderr: str) -> str | None:
        match = re.search(r"ModuleNotFoundError: No module named ['\"]([^'\"]+)['\"]", stderr)
        return match.group(1).split(".")[0] if match else None

    def _pip_install(self, container, module_name: str) -> bool:
        pip_name = self.PIP_NAME_MAP.get(module_name, module_name)
        logger.info(f"[auto-install] Installing '{pip_name}' (import name: '{module_name}')...")
        exit_code, output = container.exec_run(
            cmd=["timeout", str(PIP_TIMEOUT_SECONDS), "pip", "install", "--quiet", pip_name],
            demux=True,
            user="sandbox",
        )
        if exit_code != 0:
            logger.warning(f"[auto-install] Failed to install '{pip_name}': {_decode(output[1])[:200]}")
        return exit_code == 0

    async def _kill(self, workspace) -> None:
        container = await asyncio.to_thread(self._get_container)
        marker = self._marker(workspace)
        # Kill 2 lần: phòng trường hợp process vừa mới được exec khi lệnh kill đầu chạy
        for _ in range(2):
            await asyncio.to_thread(
                container.exec_run, ["python", "-c", _KILL_SNIPPET, marker], user="sandbox"
            )
            await asyncio.sleep(0.3)


# ─── helpers ──────────────────────────────────────
def _extension(language: str) -> str:
    return {"python": "py", "javascript": "js", "bash": "sh"}.get(language, "py")


def _dot_ext(language: str) -> str:
    return "." + _extension(language)


def _interpreter(language: str) -> str:
    return {"python": "python", "javascript": "node", "bash": "bash"}.get(language, "python")


def _quiet(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except Exception:
        return None
