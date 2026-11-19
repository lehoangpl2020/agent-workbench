"""Tool endpoints called by a run's own code from the sandbox (never by the UI). The API key stays on the server."""

import time

from fastapi import APIRouter, HTTPException, Request

from agent_workbench.api.deps import manager
from agent_workbench.observability.runlog import INFO, WARN, fmt_bytes
from agent_workbench.storage.workspace import RunWorkspace
from agent_workbench.tools.image import ImageRequest, ImageTool, ImageToolError

router = APIRouter(prefix="/api/runs/{run_id}/tools")


@router.post("/generate_image")
async def generate_image(request: Request, run_id: str, body: ImageRequest):
    """Called by the code of the run itself (URL in IMAGE_TOOL_URL), never by the UI. The key stays on the server."""
    tool: ImageTool | None = request.app.state.image_tool
    runs = manager(request)
    if tool is None:
        raise HTTPException(status_code=404, detail="The image tool is not enabled on this server.")
    if run_id != runs.active_run_id:
        raise HTTPException(status_code=409, detail="Images can only be generated for the run that is running now.")
    if not runs.image_tool_enabled(run_id):
        # The server may offer the tool, but only a run whose user ticked "Image tool" may spend money on it
        raise HTTPException(status_code=403, detail="The image tool was not enabled for this run.")
    log = lambda level, message, **data: runs.log(run_id, level, "runtime", message, **data)  # noqa: E731
    log(INFO, f"Image tool: asking {tool.settings.model} for an image ({body.size}, {body.quality})",
        prompt=body.prompt[:300])
    started = time.monotonic()
    try:
        result = await tool.generate(RunWorkspace(request.app.state.runs_dir, run_id), body,
                                     still_active=lambda: runs.active_run_id == run_id)
    except ImageToolError as e:
        log(WARN, f"Image tool failed: {e.message}", http_status=e.status)
        raise HTTPException(status_code=e.status, detail=e.message)
    log(INFO, f"Image tool: saved {result['filename']} ({fmt_bytes(result['bytes'])}) "
              f"in {time.monotonic() - started:.0f}s", requests_left=result["requests_left"])
    return result
