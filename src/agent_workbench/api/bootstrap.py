"""
The composition root: the ONE place that knows the concrete classes and wires them together.

Everything below this layer depends on contracts (BaseExecutor, ChatClient, a planner with generate_code());
this module picks the implementations from Settings and connects them. Tests skip it by passing their own
planner/executor/registry to create_app().
"""

import logging
from dataclasses import dataclass
from pathlib import Path

from agent_workbench.config import Settings
from agent_workbench.core.agent import CodeAgent
from agent_workbench.core.planner import LLMPlanner
from agent_workbench.execution import BaseExecutor, LocalExecutor, PersistentSandboxExecutor, SandboxExecutor
from agent_workbench.llm import ProviderRegistry
from agent_workbench.runs.manager import RunManager
from agent_workbench.storage.run_store import RunStore
from agent_workbench.tools.image import ImageTool

logger = logging.getLogger(__name__)


def _local(settings: Settings, runs_dir: Path) -> BaseExecutor:
    logger.warning("⚠️  Using LocalExecutor (subprocess). Set USE_DOCKER=true for isolation.")
    return LocalExecutor(timeout=settings.execution_timeout, runs_dir=runs_dir, python=settings.local_python)


def _ephemeral(settings: Settings, runs_dir: Path) -> BaseExecutor:
    logger.info("🐳 Using SandboxExecutor (ephemeral containers)")
    return SandboxExecutor(
        image="agent-workbench-sandbox:latest",
        timeout=settings.execution_timeout,
        memory_limit="256m",
        network_disabled=True,
        runs_dir=runs_dir,
    )


def _persistent(settings: Settings, runs_dir: Path) -> BaseExecutor:
    logger.info(f"🐳 Using PersistentSandboxExecutor → container '{settings.sandbox_container_name}'")
    return PersistentSandboxExecutor(
        container_name=settings.sandbox_container_name,
        timeout=settings.execution_timeout,
        runs_dir=runs_dir,
        sandbox_runs_dir=settings.sandbox_runs_dir,
    )


# SANDBOX_MODE -> executor factory (used when USE_DOCKER=true). A new sandbox kind is one function and one entry
# here (open/closed principle). An unknown mode keeps the old behavior: an ephemeral container.
SANDBOX_EXECUTORS = {"ephemeral": _ephemeral, "persistent": _persistent}


def build_executor(settings: Settings, runs_dir: Path) -> BaseExecutor:
    if not settings.use_docker:
        return _local(settings, runs_dir)
    return SANDBOX_EXECUTORS.get(settings.sandbox_mode, _ephemeral)(settings, runs_dir)


def image_tool_problem(settings: Settings, executor: BaseExecutor) -> str | None:
    """Why the server cannot offer the image tool (shown to the user), or None when it can."""
    if not settings.image_tool.enabled:
        return "The image tool is not enabled on this server. Set IMAGE_TOOL=true and OPENAI_API_KEY, then restart."
    if not settings.providers.openai_api_key:
        return "OPENAI_API_KEY is not set on the server."
    if isinstance(executor, SandboxExecutor):
        return ("Ephemeral sandbox containers have no network. "
                "Use SANDBOX_MODE=persistent or USE_DOCKER=false.")
    return None


def build_image_tool(settings: Settings, executor: BaseExecutor) -> ImageTool | None:
    """The image tool when the server can offer it. A reason is logged when the operator asked for it but it cannot work."""
    problem = image_tool_problem(settings, executor)
    if problem:
        if settings.image_tool.enabled:
            logger.warning(f"IMAGE_TOOL=true but the image tool is off: {problem}")
        return None
    logger.info(f"🖼️  Image tool on: {settings.image_tool.model}, at most {settings.image_tool.max_per_run} "
                f"requests per run (billed by OpenAI)")
    return ImageTool(settings.image_tool, settings.providers.openai_api_key, settings.providers.openai_base_url)


@dataclass
class Runtime:
    """The long-lived services of one app instance; the routes read them from app.state."""

    store: RunStore
    agent: CodeAgent
    providers: ProviderRegistry
    manager: RunManager
    image_tool: ImageTool | None
    image_tool_problem: str | None
    runs_dir: Path

    async def aclose(self) -> None:
        await self.manager.shutdown()
        if self.image_tool is not None:
            await self.image_tool.aclose()
        await self.providers.aclose()
        self.store.close()


def build_runtime(
    settings: Settings,
    *,
    runs_dir: Path,
    db_path: Path,
    max_iterations: int,
    default_timeout: int,
    planner=None,
    providers: ProviderRegistry | None = None,
    executor: BaseExecutor | None = None,
    image_tool: ImageTool | None = None,
) -> Runtime:
    """Creates the services. Anything passed in (tests) is used as is; the rest is built from settings."""
    runs_dir.mkdir(parents=True, exist_ok=True)
    store = RunStore(db_path)
    interrupted = store.mark_interrupted()
    if interrupted:
        logger.warning(f"Marked {interrupted} interrupted run(s) as error")
    registry = providers or ProviderRegistry(settings.providers)
    run_executor = executor or build_executor(settings, runs_dir)
    tool = image_tool or build_image_tool(settings, run_executor)
    if tool is not None:
        run_executor.env_providers.append(tool.sandbox_env)   # the code gets IMAGE_TOOL_URL for its own run
    agent = CodeAgent(
        planner=planner,
        planner_factory=lambda spec: LLMPlanner(spec, registry=registry,
                                                max_output_tokens=settings.max_output_tokens,
                                                image_tool_max=tool.max_per_run if tool else None),
        executor=run_executor,
        max_iterations=max_iterations,
        default_timeout=default_timeout,
    )
    return Runtime(
        store=store,
        agent=agent,
        providers=registry,
        manager=RunManager(agent, store, runs_dir),
        image_tool=tool,
        image_tool_problem=None if tool else image_tool_problem(settings, run_executor),
        runs_dir=runs_dir,
    )
