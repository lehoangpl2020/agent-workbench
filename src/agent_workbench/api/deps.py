"""Helpers shared by the route modules: access to the app's services and the checks every run start goes through."""

from fastapi import HTTPException, Request

from agent_workbench.config import Settings
from agent_workbench.domain.schemas import AgentRequest
from agent_workbench.llm import ProviderError
from agent_workbench.llm.catalog import InvalidModelSelection, resolve
from agent_workbench.runs.detail import build_run_detail
from agent_workbench.runs.manager import RunBusyError, RunManager
from agent_workbench.storage.run_store import RunStore


def settings(request: Request) -> Settings:
    return request.app.state.settings


def manager(request: Request) -> RunManager:
    return request.app.state.manager


def store(request: Request) -> RunStore:
    return request.app.state.store


def busy_409(active_run_id: str) -> HTTPException:
    return HTTPException(
        status_code=409,
        detail={"message": "Another run is in progress. Stop it or wait.",
                "active_run_id": active_run_id},
    )


def require_run(request: Request, run_id: str) -> dict:
    run = store(request).get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    return run


async def start_run(request: Request, body: AgentRequest, subscribe: bool = False):
    """
    Validates provider/model against the catalog (422) → one run at a time (409) → checks provider
    readiness (400: missing key, Ollama unreachable, model not pulled). No fallback.
    """
    state = request.app.state
    try:
        spec = resolve(body.provider, body.model)
    except InvalidModelSelection as e:
        raise HTTPException(status_code=422, detail={"code": e.code, "message": str(e)})
    if body.image_tool and state.image_tool is None:
        # Never start a run that expects a tool the server cannot provide
        raise HTTPException(status_code=400, detail={"code": "image_tool_unavailable",
                                                     "message": state.image_tool_problem})
    if manager(request).active_run_id:
        raise busy_409(manager(request).active_run_id)
    try:
        await state.providers.preflight(spec)
    except ProviderError as e:
        raise HTTPException(status_code=400, detail={
            "code": e.kind, "message": str(e), "provider": spec.provider, "model": spec.id})
    try:
        return manager(request).start(body, subscribe=subscribe)
    except RunBusyError as e:
        raise busy_409(e.active_run_id)


def run_detail(request: Request, run_id: str) -> dict:
    run = build_run_detail(store(request), request.app.state.runs_dir, run_id, manager(request).active_run_id,
                           pricing=settings(request).model_pricing)
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found")
    return run
