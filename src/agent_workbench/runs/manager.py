"""
RunManager — runs the agent loop as a background task, independent of the HTTP request.

Flow:
    POST /api/runs ──► RunManager.start() ──► asyncio.Task(agent.run(..., emit))
                                                    │
                     emit(event, data) ◄────────────┘   (every step of the loop)
                        │
                        ├─► RunStore (SQLite)      → refreshing the page still shows the run
                        └─► queue of each SSE client → the UI updates in real time

    POST /api/runs/{id}/stop ──► task.cancel()
        → CancelledError reaches the executor → kills the running code process
        → agent.run() catches CancelledError → status = stopped → emit("done")

MVP: only one run at a time (the persistent sandbox is shared).
Calling start() while a run is active → RunBusyError (the API returns 409).
"""

import asyncio
import logging
from dataclasses import dataclass, field
from pathlib import Path

from agent_workbench.core.agent import CodeAgent
from agent_workbench.domain.events import Event, Flow, artifact_size
from agent_workbench.observability.runlog import WARN, make_entry
from agent_workbench.domain.schemas import AgentRequest, AgentResponse, AgentState, ExecutionStatus
from agent_workbench.storage.run_store import (
    ITER_DONE,
    ITER_EXECUTING,
    ITER_FAILED,
    ITER_SUCCEEDED,
    ITER_TIMED_OUT,
    RunStore,
    now_iso,
)
from agent_workbench.storage.workspace import RunWorkspace

logger = logging.getLogger(__name__)


class RunBusyError(Exception):
    def __init__(self, active_run_id: str):
        super().__init__(f"Another run is in progress: {active_run_id}")
        self.active_run_id = active_run_id


@dataclass
class ActiveRun:
    run_id: str
    task: asyncio.Task | None = None
    state: AgentState | None = None     # lets log() tag an entry with the iteration that is running now
    subscribers: list[asyncio.Queue] = field(default_factory=list)
    finished: bool = False
    stop_requested: bool = False


class RunManager:
    def __init__(self, agent: CodeAgent, store: RunStore, runs_dir: str | Path):
        self.agent = agent
        self.store = store
        self.runs_dir = Path(runs_dir)
        self._active: ActiveRun | None = None

    @property
    def active_run_id(self) -> str | None:
        if self._active and not self._active.finished:
            return self._active.run_id
        return None

    # ── Start ──────────────────────────────────────
    def start(self, request: AgentRequest, subscribe: bool = False) -> tuple[str, asyncio.Queue | None]:
        """
        Creates a new run and runs it in the background. subscribe=True → also receives the first 'session' event.
        The provider/model resolved from the catalog is stored in the DB right away (exactly what will be called).
        """
        if self.active_run_id:
            raise RunBusyError(self.active_run_id)

        state = self.agent.new_state(request)  # raises InvalidModelSelection if not in the catalog
        workspace = RunWorkspace(self.runs_dir, state.session_id).create()
        self.store.create_run(
            state.session_id,
            request.message,
            state.max_iterations,
            state.timeout_seconds,
            state.model,
            self.agent.executor.describe(),
            provider=state.provider,
            image_tool=state.image_tool,
        )

        active = ActiveRun(run_id=state.session_id, state=state)
        queue = None
        if subscribe:
            queue = asyncio.Queue()
            active.subscribers.append(queue)
        self._active = active
        active.task = asyncio.create_task(
            self._run(request, state, workspace, active), name=f"run-{state.session_id}"
        )
        return state.session_id, queue

    def _publish(self, active: ActiveRun, event: str, data: dict) -> None:
        """Saves the event to SQLite (if needed), then immediately pushes it to every listening SSE client."""
        try:
            self._persist(active.run_id, event, data)
        except Exception:
            logger.exception(f"[{active.run_id}] Failed to persist event '{event}'")
        if event == Event.DONE:
            active.finished = True
        for q in list(active.subscribers):
            q.put_nowait((event, data))

    def image_tool_enabled(self, run_id: str) -> bool:
        """Whether the ACTIVE run `run_id` was started with the image tool ticked."""
        active = self._active
        return bool(active and active.run_id == run_id and not active.finished
                    and active.state and active.state.image_tool)

    def log(self, run_id: str, level: str, source: str, message: str, **data) -> bool:
        """Adds an entry to the activity log of the ACTIVE run, for code that acts outside the loop (the image tool).
        Returns False when `run_id` is not the active run."""
        active = self._active
        if not active or active.run_id != run_id or active.finished:
            return False
        iteration = active.state.current_iteration if active.state else 0
        self._publish(active, Event.LOG, make_entry(iteration or None, level, source, message, **data))
        return True

    async def _run(self, request, state, workspace, active: ActiveRun) -> AgentResponse | None:
        async def emit(event: str, data: dict) -> None:
            self._publish(active, event, data)

        try:
            return await self.agent.run(request, state=state, workspace=workspace, emit=emit)
        finally:
            # Safety net: a finished run must never remain 'running' in the DB
            row = self.store.get_run(active.run_id)
            if row and row["status"] == ExecutionStatus.RUNNING.value:
                msg = "Run ended unexpectedly."
                self.store.finish_run(active.run_id, "error", "", msg, row["iteration_count"])
                await emit(Event.DONE, {"session_id": active.run_id, "status": "error",
                                    "answer": msg, "message": msg, "iterations": row["iteration_count"]})
            active.finished = True
            if self._active is active:
                self._active = None

    # ── Event → SQLite ─────────────────────────────
    def _persist(self, run_id: str, event: str, data: dict) -> None:
        """
        Projects one event onto the stored history. Some handlers ADD a field to `data` (the log entry's
        `id`, the activity's `at`): the SSE clients receive the same dict, so they see the stored values.
        Events with no handler (session, status, error) are not stored.
        """
        handler = self._PERSIST.get(event)
        if handler:
            handler(self, run_id, data)

    def _on_log(self, run_id: str, data: dict) -> None:
        data["id"] = self.store.add_log(run_id, data)   # id lets the client continue / de-duplicate

    def _on_iteration(self, run_id: str, data: dict) -> None:
        if data.get("phase") == "planning":
            self.store.start_iteration(run_id, data["iteration"], data.get("intent", "write"), data.get("detail", ""))
        elif data.get("phase") == "executing":
            self.store.update_iteration(run_id, data["iteration"], status=ITER_EXECUTING)

    def _on_activity(self, run_id: str, data: dict) -> None:
        data["at"] = self.store.set_activity(run_id, data.get("iteration"), data["phase"], data["text"])

    def _on_code_progress(self, run_id: str, data: dict) -> None:
        # Code is streaming: store the partial version so the UI (even after a refresh) sees it right away
        n = data["iteration"]
        self.store.update_iteration(run_id, n, code=data["code"], explanation=data["explanation"])
        self.store.set_activity(
            run_id, n, "streaming", f"Model is writing code… {data['chars']:,} chars", touch=False
        )

    def _on_code(self, run_id: str, data: dict) -> None:
        self.store.update_iteration(
            run_id, data["iteration"], code=data["code"], language=data["language"], explanation=data["explanation"]
        )

    def _on_model_done(self, run_id: str, data: dict) -> None:
        self.store.update_iteration(
            run_id, data["iteration"], status=ITER_DONE, explanation=data["explanation"], finished_at=now_iso()
        )

    def _on_result(self, run_id: str, data: dict) -> None:
        if data["timed_out"]:
            status = ITER_TIMED_OUT
        elif data["exit_code"] == 0:
            status = ITER_SUCCEEDED
        else:
            status = ITER_FAILED
        artifacts = [{"path": p, "size": artifact_size(label)} for p, label in data["artifacts"].items()]
        self.store.update_iteration(
            run_id,
            data["iteration"],
            status=status,
            stdout=data["stdout"],
            stderr=data["stderr"],
            exit_code=data["exit_code"],
            execution_time_ms=data["time_ms"],
            timed_out=data["timed_out"],
            false_success=data["false_success"],
            artifacts=artifacts,
            finished_at=now_iso(),
        )

    def _on_done(self, run_id: str, data: dict) -> None:
        self.store.finish_run(run_id, data["status"], data["answer"], data.get("message", ""), data["iterations"])

    _PERSIST = {
        Event.LOG: _on_log,
        Event.ITERATION: _on_iteration,
        Event.ACTIVITY: _on_activity,
        Event.CODE_PROGRESS: _on_code_progress,
        Event.CODE: _on_code,
        Event.MODEL_DONE: _on_model_done,
        Event.RESULT: _on_result,
        Event.DONE: _on_done,
    }

    # ── Wait / Stop / Subscribe ────────────────────
    async def wait(self, run_id: str) -> AgentResponse | None:
        active = self._active
        if active and active.run_id == run_id and active.task:
            return await asyncio.shield(active.task)
        return None

    async def stop(self, run_id: str, wait_seconds: float = 15) -> bool:
        active = self._active
        if not active or active.run_id != run_id or active.finished or not active.task:
            return False
        logger.info(f"[{run_id}] Stop requested")
        self._publish(active, Event.LOG, make_entry(None, WARN, "runtime", "Stop requested by user", flow=Flow.STOP))
        active.stop_requested = True
        active.task.cancel()
        await asyncio.wait({active.task}, timeout=wait_seconds)
        return True

    def subscribe(self, run_id: str) -> asyncio.Queue | None:
        active = self._active
        if not active or active.run_id != run_id or active.finished:
            return None
        q: asyncio.Queue = asyncio.Queue()
        active.subscribers.append(q)
        return q

    def unsubscribe(self, run_id: str, q: asyncio.Queue) -> None:
        active = self._active
        if active and active.run_id == run_id and q in active.subscribers:
            active.subscribers.remove(q)

    async def shutdown(self) -> None:
        if self.active_run_id:
            await self.stop(self.active_run_id, wait_seconds=10)
