"""Server-level endpoints: form defaults and limits, the provider catalog with readiness, and health."""

from fastapi import APIRouter, Request

from agent_workbench.api.deps import manager, settings
from agent_workbench.core.agent import CodeAgent
from agent_workbench.execution import LocalExecutor
from agent_workbench.llm.catalog import DEFAULT_MODEL, DEFAULT_PROVIDER

router = APIRouter()

# max_iterations = max number of CODE RUNS. Max model calls = max_iterations + 1
# (the last turn only lets the model review the output and answer DONE), not counting retries for malformed JSON.
LIMITS = {"max_iterations": [1, 20], "timeout_seconds": [1, 300]}


@router.get("/api/config")
async def get_config(request: Request):
    state = request.app.state
    agent: CodeAgent = state.agent
    image_tool_settings = (state.image_tool.settings if state.image_tool else settings(request).image_tool)
    return {
        "defaults": {"max_iterations": agent.max_iterations, "timeout_seconds": agent.default_timeout,
                     "provider": DEFAULT_PROVIDER, "model": DEFAULT_MODEL},
        "limits": LIMITS,
        "executor": agent.executor.describe(),
        # False = LocalExecutor: model code runs directly on the machine running the server, not isolated
        "sandboxed": not isinstance(agent.executor, LocalExecutor),
        "model": DEFAULT_MODEL,   # kept for older clients: the default model
        "llm_configured": state.providers.configured(DEFAULT_PROVIDER),
        "active_run_id": manager(request).active_run_id,
        # What the "Image tool" checkbox needs: can the server offer it, and if not, why (no secrets here)
        "image_tool": {
            "available": state.image_tool is not None,
            "reason": state.image_tool_problem,
            # The numbers of the tool that will actually run, not of the settings it may differ from
            "model": image_tool_settings.model,
            "max_per_run": image_tool_settings.max_per_run,
        },
    }


@router.get("/api/providers")
async def list_providers(request: Request):
    """Catalog (llm/catalog.py) + status. Ollama is probed via /api/tags; cloud providers only check that a key exists."""
    return {"default": {"provider": DEFAULT_PROVIDER, "model": DEFAULT_MODEL},
            "providers": await request.app.state.providers.status()}


@router.get("/health")
@router.get("/api/health")
async def health(request: Request):
    agent: CodeAgent = request.app.state.agent
    s = settings(request)
    return {
        "status": "ok",
        "docker": s.use_docker,
        "sandbox_mode": s.sandbox_mode if s.use_docker else "local",
        "sandbox_container": s.sandbox_container_name if s.sandbox_mode == "persistent" else None,
        "executor": agent.executor.describe(),
        "active_run_id": manager(request).active_run_id,
    }
