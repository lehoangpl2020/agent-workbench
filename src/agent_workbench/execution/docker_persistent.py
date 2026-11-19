"""PersistentSandboxExecutor: `docker exec` into the long-running sandbox container (docker compose service)."""

import asyncio
import logging
import re

from agent_workbench.execution.base import (
    PIP_TIMEOUT_SECONDS,
    TIMEOUT_GRACE_SECONDS,
    BaseExecutor,
    ProgressFn,
    RawRun,
    SandboxUnavailable,
    decode_output,
    interpreter_for,
    notify_progress,
)
from agent_workbench.storage.workspace import RunWorkspace

logger = logging.getLogger(__name__)


# Runs INSIDE the sandbox to kill every process of one run (the slim image has no pkill).
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
    Uses the already-running sandbox container (docker compose service `sandbox`) and runs
    code with `docker exec`.

    The server and the sandbox mount one shared volume that holds the run directories:
        server:  <RUNS_DIR>/<run_id>/...           (vd /data/runs/...)
        sandbox: <SANDBOX_RUNS_DIR>/<run_id>/...   (vd /workspace/runs/...)
    → the server writes the code, the sandbox runs it, and the server reads artifacts directly from disk.

    On each run, /workspace/output is symlinked to the current run's output/,
    so the "save to /workspace/output" prompt stays valid and files from different runs do not mix.
    The timeout uses coreutils `timeout` inside the container; Stop uses _KILL_SNIPPET.
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
        # Each auto-install attempt: pip (up to 120s) + re-run the code (up to `timeout`)
        retries = self.max_install_retries if self.auto_install else 0
        return (timeout + TIMEOUT_GRACE_SECONDS) * (1 + retries) + PIP_TIMEOUT_SECONDS * retries

    def _marker(self, workspace: RunWorkspace) -> str:
        return f"{self.sandbox_runs_dir}/{workspace.run_id}/"

    async def _run(self, workspace, code_path, language, timeout, progress=None) -> RawRun:
        container = await asyncio.to_thread(self._get_container)
        run_dir = f"{self.sandbox_runs_dir}/{workspace.run_id}"
        code_in_sandbox = f"{run_dir}/code/{code_path.name}"
        out_in_sandbox = f"{run_dir}/output"

        # The sandbox must be able to see the code file the server just wrote (shared volume)
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
            f"exec timeout -k 2 {timeout} {interpreter_for(language)} {code_in_sandbox}"
        )
        return await self._run_with_auto_install(
            container, ["sh", "-c", script], workspace.run_id, progress, extra_env=self.tool_env(workspace)
        )

    def _exec(self, container, cmd, extra_env: dict[str, str] | None = None) -> RawRun:
        exit_code, output = container.exec_run(
            cmd=cmd,
            stdout=True,
            stderr=True,
            demux=True,
            user="sandbox",
            workdir="/workspace",
            environment={"OUTPUT_DIR": "/workspace/output", "MPLBACKEND": "Agg", **(extra_env or {})},
        )
        stdout, stderr = output if output else (b"", b"")
        return RawRun(exit_code, decode_output(stdout), decode_output(stderr))

    async def _run_with_auto_install(
        self, container, cmd, run_id: str, progress: ProgressFn | None = None,
        extra_env: dict[str, str] | None = None,
    ) -> RawRun:
        """Runs the code; on ModuleNotFoundError, pip-installs the module and re-runs (reporting each step)."""
        installed: set[str] = set()
        raw = await asyncio.to_thread(self._exec, container, cmd, extra_env)
        for _ in range(self.max_install_retries):
            if raw.exit_code == 0 or not self.auto_install:
                break
            missing = self._extract_missing_module(raw.stderr)
            if not missing or missing in installed:
                break
            pip_name = self.PIP_NAME_MAP.get(missing, missing)
            await notify_progress(progress, "installing", f"Installing missing package '{pip_name}'")
            if not await asyncio.to_thread(self._pip_install, container, missing):
                await notify_progress(progress, "install_failed", f"Could not install '{pip_name}'")
                break
            installed.add(missing)
            logger.info(f"[{run_id}] Retrying after installing '{missing}'")
            await notify_progress(progress, "rerunning", f"Re-running the code after installing '{pip_name}'")
            raw = await asyncio.to_thread(self._exec, container, cmd, extra_env)
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
            logger.warning(f"[auto-install] Failed to install '{pip_name}': {decode_output(output[1])[:200]}")
        return exit_code == 0

    async def _kill(self, workspace) -> None:
        container = await asyncio.to_thread(self._get_container)
        marker = self._marker(workspace)
        # Kill twice: the process may have just been exec'd when the first kill ran
        for _ in range(2):
            await asyncio.to_thread(
                container.exec_run, ["python", "-c", _KILL_SNIPPET, marker], user="sandbox"
            )
            await asyncio.sleep(0.3)
