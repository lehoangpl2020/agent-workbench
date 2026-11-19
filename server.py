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
  POST /api/runs/{id}/tools/generate_image — called by the run's own code (IMAGE_TOOL=true): OpenAI image model → output/*.png

Legacy API (used by the CLI client.py, kept compatible):
  POST /api/execute                      — run the agent and wait for the result (sync)
  POST /api/execute/stream               — run the agent with SSE streaming
  GET  /api/sessions/{id}                — view a session
  GET  /health                           — health check

Both sync and SSE go through RunManager → CodeAgent.run() → the same single agent loop.
"""

import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

from agent import CodeAgent
from config import Settings
from events import Event
from executor import BaseExecutor, LocalExecutor, PersistentSandboxExecutor, SandboxExecutor
from image_tool import ImageRequest, ImageTool, ImageToolError
from llm_providers import ProviderError, ProviderRegistry
from model_catalog import DEFAULT_MODEL, DEFAULT_PROVIDER, InvalidModelSelection, describe, resolve
from planner import LLMPlanner
from run_detail import build_run_detail
from runlog import INFO, WARN, fmt_bytes, format_log_line
from runs import RunBusyError, RunManager
from sse import drain, sse_event, sse_response
from schemas import AgentRequest, AgentResponse
from store import RunStore
from workspace import ArtifactNotFound, RunWorkspace, guess_mime

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger(__name__)

# max_iterations = max number of CODE RUNS. Max model calls = max_iterations + 1
# (the last turn only lets the model review the output and answer DONE), not counting retries for malformed JSON.
LIMITS = {"max_iterations": [1, 20], "timeout_seconds": [1, 300]}


def build_executor(settings: Settings, runs_dir: Path) -> BaseExecutor:
    if settings.use_docker and settings.sandbox_mode == "persistent":
        logger.info(f"🐳 Using PersistentSandboxExecutor → container '{settings.sandbox_container_name}'")
        return PersistentSandboxExecutor(
            container_name=settings.sandbox_container_name,
            timeout=settings.execution_timeout,
            runs_dir=runs_dir,
            sandbox_runs_dir=settings.sandbox_runs_dir,
        )
    if settings.use_docker:
        logger.info("🐳 Using SandboxExecutor (ephemeral containers)")
        return SandboxExecutor(
            image="agent-workbench-sandbox:latest",
            timeout=settings.execution_timeout,
            memory_limit="256m",
            network_disabled=True,
            runs_dir=runs_dir,
        )
    logger.warning("⚠️  Using LocalExecutor (subprocess). Set USE_DOCKER=true for isolation.")
    return LocalExecutor(timeout=settings.execution_timeout, runs_dir=runs_dir, python=settings.local_python)


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


def create_app(
    settings: Settings | None = None,
    *,
    planner=None,
    providers: ProviderRegistry | None = None,
    executor: BaseExecutor | None = None,
    image_tool: ImageTool | None = None,
    db_path: str | Path | None = None,
    runs_dir: str | Path | None = None,
    static_dir: str | Path | None = None,
    max_iterations: int | None = None,
    default_timeout: int | None = None,
) -> FastAPI:
    """
    App factory: settings default to Settings.from_env(); tests inject a fake planner/executor/registry.
    With a fixed planner (tests) → every run uses that planner; otherwise each run creates a planner
    from the run's provider/model through ProviderRegistry.
    """
    settings = settings or Settings.from_env()
    for warning in settings.model_pricing_warnings:
        logger.warning(warning)
    runs_dir = Path(runs_dir or settings.runs_dir)
    db_path = Path(db_path or settings.db_path)
    static_dir = Path(static_dir or settings.static_dir)
    max_iterations = max_iterations or settings.max_iterations
    default_timeout = default_timeout or settings.execution_timeout

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        runs_dir.mkdir(parents=True, exist_ok=True)
        store = RunStore(db_path)
        interrupted = store.mark_interrupted()
        if interrupted:
            logger.warning(f"Marked {interrupted} interrupted run(s) as error")
        registry = providers or ProviderRegistry(settings.providers)
        run_executor = executor or build_executor(settings, runs_dir)
        tool = image_tool or build_image_tool(settings, run_executor)
        if tool is not None:
            run_executor.image_tool_url = settings.image_tool.url   # the code gets IMAGE_TOOL_URL for its own run
        agent = CodeAgent(
            planner=planner,
            planner_factory=lambda spec: LLMPlanner(spec, registry=registry,
                                                    max_output_tokens=settings.max_output_tokens,
                                                    image_tool_max=tool.max_per_run if tool else None),
            executor=run_executor,
            max_iterations=max_iterations,
            default_timeout=default_timeout,
        )
        app.state.store = store
        app.state.agent = agent
        app.state.image_tool = tool
        app.state.image_tool_problem = None if tool else image_tool_problem(settings, run_executor)
        app.state.providers = registry
        app.state.manager = RunManager(agent, store, runs_dir)
        app.state.runs_dir = runs_dir
        logger.info(f"✅ Agent Workbench initialized (db={db_path}, runs={runs_dir})")
        yield
        await app.state.manager.shutdown()
        if tool is not None:
            await tool.aclose()
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
        allow_origins=list(settings.cors_origins),
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
        if request.image_tool and app.state.image_tool is None:
            # Never start a run that expects a tool the server cannot provide
            raise HTTPException(status_code=400, detail={"code": "image_tool_unavailable",
                                                         "message": app.state.image_tool_problem})
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
        run = build_run_detail(store(), app.state.runs_dir, run_id, manager().active_run_id,
                               pricing=settings.model_pricing)
        if run is None:
            raise HTTPException(status_code=404, detail="Run not found")
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
            # What the "Image tool" checkbox needs: can the server offer it, and if not, why (no secrets here)
            "image_tool": {
                "available": app.state.image_tool is not None,
                "reason": app.state.image_tool_problem,
                # The numbers of the tool that will actually run, not of the settings it may differ from
                "model": (app.state.image_tool.settings if app.state.image_tool else settings.image_tool).model,
                "max_per_run": (app.state.image_tool.settings if app.state.image_tool
                                else settings.image_tool).max_per_run,
            },
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
                yield sse_event(Event.DONE, {"session_id": run_id, "status": run["status"],
                                    "answer": run["answer"], "message": run["message"],
                                    "iterations": run["iteration_count"]})
            return sse_response(finished())

        async def live():
            yield sse_event(Event.STATUS, {"session_id": run_id, "status": "running"})
            async for chunk in drain(queue):
                yield chunk
        return sse_response(live(), on_close=lambda: manager().unsubscribe(run_id, queue))

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

    @app.post("/api/runs/{run_id}/tools/generate_image")
    async def generate_image(run_id: str, request: ImageRequest):
        """Called by the code of the run itself (URL in IMAGE_TOOL_URL), never by the UI. The key stays on the server."""
        tool: ImageTool | None = app.state.image_tool
        if tool is None:
            raise HTTPException(status_code=404, detail="The image tool is not enabled on this server.")
        if run_id != manager().active_run_id:
            raise HTTPException(status_code=409, detail="Images can only be generated for the run that is running now.")
        if not manager().image_tool_enabled(run_id):
            # The server may offer the tool, but only a run whose user ticked "Image tool" may spend money on it
            raise HTTPException(status_code=403, detail="The image tool was not enabled for this run.")
        log = lambda level, message, **data: manager().log(run_id, level, "runtime", message, **data)  # noqa: E731
        log(INFO, f"Image tool: asking {tool.settings.model} for an image ({request.size}, {request.quality})",
            prompt=request.prompt[:300])
        started = time.monotonic()
        try:
            result = await tool.generate(RunWorkspace(app.state.runs_dir, run_id), request,
                                         still_active=lambda: manager().active_run_id == run_id)
        except ImageToolError as e:
            log(WARN, f"Image tool failed: {e.message}", http_status=e.status)
            raise HTTPException(status_code=e.status, detail=e.message)
        log(INFO, f"Image tool: saved {result['filename']} ({fmt_bytes(result['bytes'])}) "
                  f"in {time.monotonic() - started:.0f}s", requests_left=result["requests_left"])
        return result

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
        return sse_response(drain(queue), on_close=lambda: manager().unsubscribe(run_id, queue))

    @app.get("/api/sessions/{session_id}")
    async def get_session(session_id: str):
        return run_detail(session_id)

    @app.get("/health")
    @app.get("/api/health")
    async def health():
        agent: CodeAgent = app.state.agent
        return {
            "status": "ok",
            "docker": settings.use_docker,
            "sandbox_mode": settings.sandbox_mode if settings.use_docker else "local",
            "sandbox_container": settings.sandbox_container_name if settings.sandbox_mode == "persistent" else None,
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


app = create_app()


if __name__ == "__main__":
    import uvicorn

    settings = Settings.from_env()
    if settings.host not in ("127.0.0.1", "localhost", "::1"):
        logger.warning(f"⚠️  Listening on {settings.host}: other machines on the network can run code here. "
                       "There is no authentication.")
    uvicorn.run(app, host=settings.host, port=settings.port)
