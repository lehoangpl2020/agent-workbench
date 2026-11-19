"""SandboxExecutor: a new, locked-down Docker container for every code run."""

import asyncio
import logging

from agent_workbench.execution.base import (
    BaseExecutor,
    RawRun,
    SandboxUnavailable,
    call_quietly,
    decode_output,
    dot_extension,
    interpreter_for,
)

logger = logging.getLogger(__name__)


class SandboxExecutor(BaseExecutor):
    """
    Creates a new container for every run, with these mounts:
      code file (read-only) → /workspace/code.py
      output/ of the run    → /workspace/output
    Limits memory, CPU and network; non-root user; capabilities dropped.

    Note: the bind mount uses a path on the host, so use this only when the server runs
    directly on the host (not inside a container).
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
                "Build it with: docker build -t agent-workbench-sandbox -f docker/sandbox.Dockerfile ."
            )

    async def _run(self, workspace, code_path, language, timeout, progress=None) -> RawRun:
        script = (
            "cd /workspace/output && "
            f"exec timeout -k 2 {timeout} {interpreter_for(language)} /workspace/code{dot_extension(language)}"
        )

        def start():
            try:
                return self.client.containers.run(
                    image=self.image,
                    command=["sh", "-c", script],
                    volumes={
                        str(code_path.resolve()): {
                            "bind": f"/workspace/code{dot_extension(language)}",
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
                    "Run: docker build -t agent-workbench-sandbox -f docker/sandbox.Dockerfile ."
                ) from e
            except self._docker.errors.DockerException as e:
                raise SandboxUnavailable(f"Docker error: {e}") from e

        container = await asyncio.to_thread(start)
        self._containers[workspace.run_id] = container
        try:
            status = await asyncio.to_thread(container.wait)
            stdout = await asyncio.to_thread(container.logs, stdout=True, stderr=False)
            stderr = await asyncio.to_thread(container.logs, stdout=False, stderr=True)
            return RawRun(status.get("StatusCode", -1), decode_output(stdout), decode_output(stderr))
        finally:
            self._containers.pop(workspace.run_id, None)
            # remove(force=True) also kills the container if it is still running (e.g. on cancel)
            await asyncio.to_thread(call_quietly, container.remove, force=True)

    async def _kill(self, workspace) -> None:
        container = self._containers.get(workspace.run_id)
        if container is not None:
            await asyncio.to_thread(call_quietly, container.kill)
