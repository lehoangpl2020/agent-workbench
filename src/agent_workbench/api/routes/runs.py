"""Run API (used by the web UI): create, list, inspect, stop, stream, logs and artifacts of a run."""

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, PlainTextResponse

from agent_workbench.api.deps import manager, require_run, run_detail, start_run, store
from agent_workbench.api.sse import drain, sse_event, sse_response
from agent_workbench.domain.events import Event
from agent_workbench.domain.schemas import AgentRequest
from agent_workbench.llm.catalog import describe
from agent_workbench.observability.runlog import format_log_line
from agent_workbench.storage.workspace import ArtifactNotFound, RunWorkspace, guess_mime

router = APIRouter(prefix="/api/runs")


@router.post("", status_code=201)
async def create_run(request: Request, body: AgentRequest):
    run_id, _ = await start_run(request, body)
    return run_detail(request, run_id)


@router.get("")
async def list_runs(request: Request, limit: int = 100):
    runs = store(request).list_runs(limit=min(max(limit, 1), 500))
    for r in runs:
        r.update(describe(r.get("provider"), r.get("model")))
    return {"runs": runs, "active_run_id": manager(request).active_run_id}


@router.get("/{run_id}")
async def get_run(request: Request, run_id: str):
    return run_detail(request, run_id)


@router.post("/{run_id}/stop")
async def stop_run(request: Request, run_id: str):
    require_run(request, run_id)
    stopped = await manager(request).stop(run_id)
    if not stopped:
        raise HTTPException(status_code=409, detail={"message": "Run is not running."})
    return run_detail(request, run_id)


@router.get("/{run_id}/events")
async def run_events(request: Request, run_id: str):
    run = require_run(request, run_id)
    runs = manager(request)
    queue = runs.subscribe(run_id)
    if queue is None:
        # The run already finished → send the final state, then close the stream
        async def finished():
            yield sse_event(Event.DONE, {"session_id": run_id, "status": run["status"],
                                         "answer": run["answer"], "message": run["message"],
                                         "iterations": run["iteration_count"]})
        return sse_response(finished())

    async def live():
        yield sse_event(Event.STATUS, {"session_id": run_id, "status": "running"})
        async for chunk in drain(queue):
            yield chunk
    return sse_response(live(), on_close=lambda: runs.unsubscribe(run_id, queue))


@router.get("/{run_id}/logs")
async def get_logs(request: Request, run_id: str, after: int = 0, iteration: int | None = None):
    """The stored activity log. after=<last id the client has> returns only the new part."""
    require_run(request, run_id)
    return {"logs": store(request).list_logs(run_id, after_id=after, iteration=iteration)}


@router.get("/{run_id}/logs/download")
async def download_logs(request: Request, run_id: str, iteration: int | None = None):
    run = require_run(request, run_id)
    lines = [f"# Run {run_id} — {run['status']}",
             f"# Model: {run.get('provider') or 'provider not recorded'} / {run.get('model') or '-'}",
             f"# Prompt: {run['prompt']}", ""]
    for e in store(request).list_logs(run_id, iteration=iteration, limit=100_000):
        lines.append(format_log_line(e))
    suffix = f"-iter{iteration}" if iteration else ""
    return PlainTextResponse(
        "\n".join(lines) + "\n",
        headers={"Content-Disposition": f'attachment; filename="run-{run_id[:8]}{suffix}.log"'},
    )


@router.get("/{run_id}/artifacts")
async def list_artifacts(request: Request, run_id: str):
    return {"artifacts": run_detail(request, run_id)["artifacts"]}


@router.get("/{run_id}/artifacts/{path:path}")
async def get_artifact(request: Request, run_id: str, path: str, iteration: int | None = None,
                       download: bool = False):
    require_run(request, run_id)
    try:
        file = RunWorkspace(request.app.state.runs_dir, run_id).resolve_artifact(path, iteration)
    except (ArtifactNotFound, ValueError):
        raise HTTPException(status_code=404, detail="Artifact not found")
    return FileResponse(
        file,
        media_type=guess_mime(file.name),
        filename=file.name if download else None,
        content_disposition_type="attachment" if download else "inline",
        # Files produced by LLM-generated code: do not let scripts run in the app's origin
        headers={"X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox"},
    )
