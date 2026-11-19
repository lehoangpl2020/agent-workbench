"""Legacy API used by scripts/client.py, kept compatible (AGENTS.md invariant 5). Same agent loop as the Run API."""

from fastapi import APIRouter, HTTPException, Request

from agent_workbench.api.deps import manager, run_detail, start_run
from agent_workbench.api.sse import drain, sse_response
from agent_workbench.domain.schemas import AgentRequest, AgentResponse

router = APIRouter()


@router.post("/api/execute", response_model=AgentResponse)
async def execute(request: Request, body: AgentRequest):
    """Runs the agent and waits for the final result. Same loop as SSE."""
    run_id, _ = await start_run(request, body)
    response = await manager(request).wait(run_id)
    if response is None:
        raise HTTPException(status_code=500, detail="Run finished without a response")
    return response


@router.post("/api/execute/stream")
async def execute_stream(request: Request, body: AgentRequest):
    """Runs the agent with SSE: session → iteration/code/result... → done."""
    run_id, queue = await start_run(request, body, subscribe=True)
    runs = manager(request)
    return sse_response(drain(queue), on_close=lambda: runs.unsubscribe(run_id, queue))


@router.get("/api/sessions/{session_id}")
async def get_session(request: Request, session_id: str):
    return run_detail(request, session_id)
