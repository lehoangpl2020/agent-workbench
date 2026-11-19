"""
FastAPI Server for Code Execution Agent (Agent Workbench).

Run API (used by the web UI):
  POST /api/runs                         — create a run, executes in the background → {run_id}   (409 if a run is active)
  GET  /api/runs                         — run history (SQLite)
  GET  /api/runs/{id}                    — run details + iterations + artifacts
  GET  /api/runs/{id}/events             — SSE progress of the running run
  POST /api/runs/{id}/stop               — stop the run (also kills the running code process)
  GET  /api/runs/{id}/artifacts          — files in the run's output
  GET  /api/runs/{id}/artifacts/{path}   — view/download one file (?iteration=N, ?download=1)
  GET  /api/config                       — defaults + limits for the form
  GET  /api/providers                    — provider/model catalog + readiness (model_catalog.py)

Legacy API (used by the CLI client.py, kept compatible):
  POST /api/execute                      — run the agent and wait for the result (sync)
  POST /api/execute/stream               — run the agent with SSE streaming
  GET  /api/sessions/{id}                — view a session
  GET  /health                           — health check

Both sync and SSE go through RunManager → CodeAgent.run() → the same single agent loop.
"""

import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import quote

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from agent import CodeAgent
from executor import BaseExecutor, LocalExecutor, PersistentSandboxExecutor, SandboxExecutor
from llm_providers import ProviderError, ProviderRegistry
from model_catalog import DEFAULT_MODEL, DEFAULT_PROVIDER, InvalidModelSelection, describe, resolve
from planner import LLMPlanner
from runs import RunBusyError, RunManager
from schemas import AgentRequest, AgentResponse
from store import RunStore
from workspace import ArtifactNotFound, RunWorkspace, guess_mime

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent

# ─── Config (read from env or defaults) ────────
USE_DOCKER = os.getenv("USE_DOCKER", "false").lower() in ("true", "1", "yes")
SANDBOX_MODE = os.getenv("SANDBOX_MODE", "ephemeral")  # ephemeral | persistent
SANDBOX_CONTAINER_NAME = os.getenv("SANDBOX_CONTAINER_NAME", "agent-workbench-sandbox")
SANDBOX_RUNS_DIR = os.getenv("SANDBOX_RUNS_DIR", "/workspace/runs")
MAX_ITERATIONS = int(os.getenv("MAX_ITERATIONS", "5"))
EXECUTION_TIMEOUT = int(os.getenv("EXECUTION_TIMEOUT", "30"))
DATA_DIR = Path(os.getenv("DATA_DIR", BASE_DIR / "data"))
DB_PATH = Path(os.getenv("DB_PATH", DATA_DIR / "agent.db"))
RUNS_DIR = Path(os.getenv("RUNS_DIR", DATA_DIR / "runs"))
STATIC_DIR = Path(os.getenv("STATIC_DIR", BASE_DIR / "static"))

# By default listen on this machine only. The server runs code written by a model and has no auth:
# exposing it to the LAN (0.0.0.0) lets other machines run code and spend your API keys.
HOST = os.getenv("HOST", "127.0.0.1")
# Origins allowed to call the API from a browser. The built UI is served from the same origin as the API, so it needs no CORS;
# only the Vite dev server (:5173) does. The Vite proxy calls server-side so it would not need it either, but it is kept to be safe.
CORS_ORIGINS = [
    o.strip()
    for o in os.getenv("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",")
    if o.strip()
]

# max_iterations = max number of CODE RUNS. Max model calls = max_iterations + 1
# (the last turn only lets the model review the output and answer DONE), not counting retries for malformed JSON.
LIMITS = {"max_iterations": [1, 20], "timeout_seconds": [1, 300]}
SSE_PING_SECONDS = 15


def build_executor(runs_dir: Path) -> BaseExecutor:
    if USE_DOCKER and SANDBOX_MODE == "persistent":
        logger.info(f"🐳 Using PersistentSandboxExecutor → container '{SANDBOX_CONTAINER_NAME}'")
        return PersistentSandboxExecutor(
            container_name=SANDBOX_CONTAINER_NAME,
            timeout=EXECUTION_TIMEOUT,
            runs_dir=runs_dir,
            sandbox_runs_dir=SANDBOX_RUNS_DIR,
        )
    if USE_DOCKER:
        logger.info("🐳 Using SandboxExecutor (ephemeral containers)")
        return SandboxExecutor(
            image="agent-workbench-sandbox:latest",
            timeout=EXECUTION_TIMEOUT,
            memory_limit="256m",
            network_disabled=True,
            runs_dir=runs_dir,
        )
    logger.warning("⚠️  Using LocalExecutor (subprocess). Set USE_DOCKER=true for isolation.")
    return LocalExecutor(timeout=EXECUTION_TIMEOUT, runs_dir=runs_dir)


def create_app(
    *,
    planner=None,
    providers: ProviderRegistry | None = None,
    executor: BaseExecutor | None = None,
    db_path: str | Path | None = None,
    runs_dir: str | Path | None = None,
    static_dir: str | Path | None = None,
    max_iterations: int = MAX_ITERATIONS,
    default_timeout: int = EXECUTION_TIMEOUT,
) -> FastAPI:
    """
    App factory: production uses defaults from env; tests inject a fake planner/executor/registry.
    With a fixed planner (tests) → every run uses that planner; otherwise each run creates a planner
    from the run's provider/model through ProviderRegistry.
    """
    runs_dir = Path(runs_dir or RUNS_DIR)
    db_path = Path(db_path or DB_PATH)
    static_dir = Path(static_dir or STATIC_DIR)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        runs_dir.mkdir(parents=True, exist_ok=True)
        store = RunStore(db_path)
        interrupted = store.mark_interrupted()
        if interrupted:
            logger.warning(f"Marked {interrupted} interrupted run(s) as error")
        registry = providers or ProviderRegistry()
        agent = CodeAgent(
            planner=planner,
            planner_factory=lambda spec: LLMPlanner(spec, registry=registry),
            executor=executor or build_executor(runs_dir),
            max_iterations=max_iterations,
            default_timeout=default_timeout,
        )
        app.state.store = store
        app.state.agent = agent
        app.state.providers = registry
        app.state.manager = RunManager(agent, store, runs_dir)
        app.state.runs_dir = runs_dir
        logger.info(f"✅ Agent Workbench initialized (db={db_path}, runs={runs_dir})")
        yield
        await app.state.manager.shutdown()
        await registry.aclose()
        store.close()

    app = FastAPI(
        title="Code Execution Agent",
        description="LLM-powered agent that writes and runs code",
        version="0.2.0",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=CORS_ORIGINS,
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type"],
    )

    def manager() -> RunManager:
        return app.state.manager

    def store() -> RunStore:
        return app.state.store

    def busy_409(active_run_id: str):
        return HTTPException(
            status_code=409,
            detail={"message": "Another run is in progress. Stop it or wait.",
                    "active_run_id": active_run_id},
        )

    async def start_run(request: AgentRequest, subscribe: bool = False):
        """
        Validates provider/model against the catalog (422) → one run at a time (409) → checks provider
        readiness (400: missing key, Ollama unreachable, model not pulled). No fallback.
        """
        try:
            spec = resolve(request.provider, request.model)
        except InvalidModelSelection as e:
            raise HTTPException(status_code=422, detail={"code": e.code, "message": str(e)})
        if manager().active_run_id:
            raise busy_409(manager().active_run_id)
        try:
            await app.state.providers.preflight(spec)
        except ProviderError as e:
            raise HTTPException(status_code=400, detail={
                "code": e.kind, "message": str(e), "provider": spec.provider, "model": spec.id})
        try:
            return manager().start(request, subscribe=subscribe)
        except RunBusyError as e:
            raise busy_409(e.active_run_id)

    def run_detail(run_id: str) -> dict:
        run = store().get_run(run_id)
        if not run:
            raise HTTPException(status_code=404, detail="Run not found")
        base = f"/api/runs/{run_id}/artifacts"
        workspace = RunWorkspace(app.state.runs_dir, run_id)
        last_changed: dict[str, int] = {}
        for it in run["iterations"]:
            for a in it["artifacts"]:
                last_changed[a["path"]] = it["number"]
                a["mime"] = guess_mime(a["path"])
                a["url"] = f"{base}/{quote(a['path'])}?iteration={it['number']}"
                try:
                    workspace.resolve_artifact(a["path"], iteration=it["number"])
                    a["snapshot_available"] = True
                except ArtifactNotFound:
                    a["snapshot_available"] = False
        run["artifacts"] = [
            {
                **a,
                "iteration": last_changed.get(a["path"]),
                "url": f"{base}/{quote(a['path'])}",
                "download_url": f"{base}/{quote(a['path'])}?download=1",
            }
            for a in workspace.list_artifacts()
        ]
        run["active"] = manager().active_run_id == run_id
        run.update(describe(run.get("provider"), run.get("model")))
        return run

    # ─── Run API ───────────────────────────────
    @app.get("/api/config")
    async def get_config():
        agent: CodeAgent = app.state.agent
        return {
            "defaults": {"max_iterations": agent.max_iterations, "timeout_seconds": agent.default_timeout,
                         "provider": DEFAULT_PROVIDER, "model": DEFAULT_MODEL},
            "limits": LIMITS,
            "executor": agent.executor.describe(),
            # False = LocalExecutor: model code runs directly on the machine running the server, not isolated
            "sandboxed": not isinstance(agent.executor, LocalExecutor),
            "model": DEFAULT_MODEL,   # kept for older clients: the default model
            "llm_configured": app.state.providers.configured(DEFAULT_PROVIDER),
            "active_run_id": manager().active_run_id,
        }

    @app.get("/api/providers")
    async def list_providers():
        """Catalog (model_catalog.py) + status. Ollama is probed via /api/tags; cloud providers only check that a key exists."""
        return {"default": {"provider": DEFAULT_PROVIDER, "model": DEFAULT_MODEL},
                "providers": await app.state.providers.status()}

    @app.post("/api/runs", status_code=201)
    async def create_run(request: AgentRequest):
        run_id, _ = await start_run(request)
        return run_detail(run_id)

    @app.get("/api/runs")
    async def list_runs(limit: int = 100):
        runs = store().list_runs(limit=min(max(limit, 1), 500))
        for r in runs:
            r.update(describe(r.get("provider"), r.get("model")))
        return {"runs": runs, "active_run_id": manager().active_run_id}

    @app.get("/api/runs/{run_id}")
    async def get_run(run_id: str):
        return run_detail(run_id)

    @app.post("/api/runs/{run_id}/stop")
    async def stop_run(run_id: str):
        if not store().get_run(run_id):
            raise HTTPException(status_code=404, detail="Run not found")
        stopped = await manager().stop(run_id)
        if not stopped:
            raise HTTPException(status_code=409, detail={"message": "Run is not running."})
        return run_detail(run_id)

    @app.get("/api/runs/{run_id}/events")
    async def run_events(run_id: str):
        run = store().get_run(run_id)
        if not run:
            raise HTTPException(status_code=404, detail="Run not found")
        queue = manager().subscribe(run_id)
        if queue is None:
            # The run already finished → send the final state, then close the stream
            async def finished():
                yield _sse("done", {"session_id": run_id, "status": run["status"],
                                    "answer": run["answer"], "message": run["message"],
                                    "iterations": run["iteration_count"]})
            return _sse_response(finished())

        async def live():
            yield _sse("status", {"session_id": run_id, "status": "running"})
            async for chunk in _drain(queue):
                yield chunk
        return _sse_response(live(), on_close=lambda: manager().unsubscribe(run_id, queue))

    @app.get("/api/runs/{run_id}/logs")
    async def get_logs(run_id: str, after: int = 0, iteration: int | None = None):
        """The stored activity log. after=<last id the client has> returns only the new part."""
        if not store().get_run(run_id):
            raise HTTPException(status_code=404, detail="Run not found")
        return {"logs": store().list_logs(run_id, after_id=after, iteration=iteration)}

    @app.get("/api/runs/{run_id}/logs/download")
    async def download_logs(run_id: str, iteration: int | None = None):
        run = store().get_run(run_id)
        if not run:
            raise HTTPException(status_code=404, detail="Run not found")
        lines = [f"# Run {run_id} — {run['status']}",
                 f"# Model: {run.get('provider') or 'provider not recorded'} / {run.get('model') or '-'}",
                 f"# Prompt: {run['prompt']}", ""]
        for e in store().list_logs(run_id, iteration=iteration, limit=100_000):
            lines.append(format_log_line(e))
        suffix = f"-iter{iteration}" if iteration else ""
        return PlainTextResponse(
            "\n".join(lines) + "\n",
            headers={"Content-Disposition": f'attachment; filename="run-{run_id[:8]}{suffix}.log"'},
        )

    @app.get("/api/runs/{run_id}/artifacts")
    async def list_artifacts(run_id: str):
        return {"artifacts": run_detail(run_id)["artifacts"]}

    @app.get("/api/runs/{run_id}/artifacts/{path:path}")
    async def get_artifact(run_id: str, path: str, iteration: int | None = None, download: bool = False):
        if not store().get_run(run_id):
            raise HTTPException(status_code=404, detail="Run not found")
        try:
            file = RunWorkspace(app.state.runs_dir, run_id).resolve_artifact(path, iteration)
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

    # ─── Legacy API (kept compatible) ──────────
    @app.post("/api/execute", response_model=AgentResponse)
    async def execute(request: AgentRequest):
        """Runs the agent and waits for the final result. Same loop as SSE."""
        run_id, _ = await start_run(request)
        response = await manager().wait(run_id)
        if response is None:
            raise HTTPException(status_code=500, detail="Run finished without a response")
        return response

    @app.post("/api/execute/stream")
    async def execute_stream(request: AgentRequest):
        """Runs the agent with SSE: session → iteration/code/result... → done."""
        run_id, queue = await start_run(request, subscribe=True)
        return _sse_response(_drain(queue), on_close=lambda: manager().unsubscribe(run_id, queue))

    @app.get("/api/sessions/{session_id}")
    async def get_session(session_id: str):
        return run_detail(session_id)

    @app.get("/health")
    @app.get("/api/health")
    async def health():
        agent: CodeAgent = app.state.agent
        return {
            "status": "ok",
            "docker": USE_DOCKER,
            "sandbox_mode": SANDBOX_MODE if USE_DOCKER else "local",
            "sandbox_container": SANDBOX_CONTAINER_NAME if SANDBOX_MODE == "persistent" else None,
            "executor": agent.executor.describe(),
            "active_run_id": manager().active_run_id,
        }

    # ─── Web UI (build output of web/) ─────────
    if (static_dir / "index.html").exists():
        if (static_dir / "assets").exists():
            app.mount("/assets", StaticFiles(directory=static_dir / "assets"), name="assets")
        root = static_dir.resolve()

        @app.get("/{full_path:path}", include_in_schema=False)
        async def spa(full_path: str):
            if full_path.startswith("api/"):
                return JSONResponse({"detail": "Not Found"}, status_code=404)
            candidate = (root / full_path).resolve()
            if full_path and candidate.is_file() and candidate.is_relative_to(root):
                return FileResponse(candidate)
            return FileResponse(root / "index.html")

    return app


def format_log_line(e: dict) -> str:
    """One log line as text: time, iteration, level, source, message, data."""
    it = f"iter {e['iteration']}" if e.get("iteration") else "run"
    data = " ".join(f"{k}={v}" for k, v in (e.get("data") or {}).items())
    return f"{e['ts']}  {it:<7} {e['level']:<5} {e['source']:<7} {e['message']}" + (f"  [{data}]" if data else "")


# ─── SSE helpers ───────────────────────────────
def _sse(event: str, data: dict) -> str:
    """Format Server-Sent Event."""
    return f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n"


async def _drain(queue: asyncio.Queue):
    """Reads events from the queue until 'done'; sends pings so the connection is not closed."""
    while True:
        try:
            event, data = await asyncio.wait_for(queue.get(), timeout=SSE_PING_SECONDS)
        except asyncio.TimeoutError:
            yield ": ping\n\n"
            continue
        yield _sse(event, data)
        if event == "done":
            return


def _sse_response(gen, on_close=None) -> StreamingResponse:
    async def wrapped():
        try:
            async for chunk in gen:
                yield chunk
        finally:
            # The client closed the stream: only unsubscribe, the run keeps going (only Stop stops the run)
            if on_close:
                on_close()

    return StreamingResponse(
        wrapped(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


app = create_app()


if __name__ == "__main__":
    import uvicorn

    if HOST not in ("127.0.0.1", "localhost", "::1"):
        logger.warning(f"⚠️  Listening on {HOST}: other machines on the network can run code here. "
                       "There is no authentication.")
    uvicorn.run(app, host=HOST, port=int(os.getenv("PORT", "8000")))
