"""
FastAPI Server for Code Execution Agent (Agent Workbench): the app factory.

Endpoints live in api/routes/, one module per group:
  routes/runs.py    Run API (used by the web UI)
    POST /api/runs                         — create a run, executes in the background → {run_id}   (409 if a run is active)
    GET  /api/runs                         — run history (SQLite)
    GET  /api/runs/{id}                    — run details + iterations + artifacts
    GET  /api/runs/{id}/events             — SSE progress of the running run
    POST /api/runs/{id}/stop               — stop the run (also kills the running code process)
    GET  /api/runs/{id}/logs[/download]    — the stored activity log
    GET  /api/runs/{id}/artifacts          — files in the run's output
    GET  /api/runs/{id}/artifacts/{path}   — view/download one file (?iteration=N, ?download=1)
  routes/system.py
    GET  /api/config                       — defaults + limits for the form
    GET  /api/providers                    — provider/model catalog + readiness (llm/catalog.py)
    GET  /health, /api/health              — health check
  routes/tools.py
    POST /api/runs/{id}/tools/generate_image — called by the run's own code (IMAGE_TOOL=true): OpenAI image model → output/*.png
  routes/legacy.py  Legacy API (used by scripts/client.py, kept compatible)
    POST /api/execute                      — run the agent and wait for the result (sync)
    POST /api/execute/stream               — run the agent with SSE streaming
    GET  /api/sessions/{id}                — view a session

Both sync and SSE go through RunManager → CodeAgent.run() → the same single agent loop.
The services are built in api/bootstrap.py (the composition root) and kept on app.state.
"""

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from agent_workbench.api.bootstrap import build_runtime
from agent_workbench.api.routes import legacy, runs, system, tools
from agent_workbench.config import Settings
from agent_workbench.execution import BaseExecutor
from agent_workbench.llm import ProviderRegistry
from agent_workbench.tools.image import ImageTool

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger(__name__)


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
        runtime = build_runtime(
            settings, runs_dir=runs_dir, db_path=db_path, max_iterations=max_iterations,
            default_timeout=default_timeout, planner=planner, providers=providers, executor=executor,
            image_tool=image_tool,
        )
        app.state.store = runtime.store
        app.state.agent = runtime.agent
        app.state.image_tool = runtime.image_tool
        app.state.image_tool_problem = runtime.image_tool_problem
        app.state.providers = runtime.providers
        app.state.manager = runtime.manager
        app.state.runs_dir = runtime.runs_dir
        logger.info(f"✅ Agent Workbench initialized (db={db_path}, runs={runs_dir})")
        yield
        await runtime.aclose()

    app = FastAPI(
        title="Code Execution Agent",
        description="LLM-powered agent that writes and runs code",
        version="0.2.0",
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.cors_origins),
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type"],
    )
    for module in (system, runs, tools, legacy):
        app.include_router(module.router)

    # ─── Web UI (build output of web/), registered last: its catch-all route must not shadow the API ──
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
