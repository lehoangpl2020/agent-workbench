"""
RunManager — chạy agent loop như một background task, độc lập với HTTP request.

Luồng:
    POST /api/runs ──► RunManager.start() ──► asyncio.Task(agent.run(..., emit))
                                                    │
                     emit(event, data) ◄────────────┘   (mỗi bước của loop)
                        │
                        ├─► RunStore (SQLite)      → refresh trang vẫn xem lại được
                        └─► queue của mỗi SSE client → UI cập nhật realtime

    POST /api/runs/{id}/stop ──► task.cancel()
        → CancelledError đi vào executor → kill process code đang chạy
        → agent.run() bắt CancelledError → status = stopped → emit("done")

MVP: chỉ 1 run chạy tại một thời điểm (sandbox persistent dùng chung).
Gọi start() khi đang có run → RunBusyError (API trả 409).

Tương đương .NET: giống một IHostedService giữ 1 Task + CancellationTokenSource,
còn emit() giống một event/IObserver mà cả repository và SSE hub cùng nghe.
"""

import asyncio
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path

from agent import CodeAgent
from runlog import WARN, make_entry
from schemas import AgentRequest, AgentResponse, ExecutionStatus
from store import (
    ITER_DONE,
    ITER_EXECUTING,
    ITER_FAILED,
    ITER_SUCCEEDED,
    ITER_TIMED_OUT,
    RunStore,
    now_iso,
)
from workspace import RunWorkspace

logger = logging.getLogger(__name__)
_SIZE_RE = re.compile(r"(\d+)")


class RunBusyError(Exception):
    def __init__(self, active_run_id: str):
        super().__init__(f"Another run is in progress: {active_run_id}")
        self.active_run_id = active_run_id


@dataclass
class ActiveRun:
    run_id: str
    task: asyncio.Task | None = None
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
        Tạo run mới và chạy nền. subscribe=True → nhận cả event 'session' đầu tiên.
        Provider/model đã resolve theo catalog được lưu ngay vào DB (đúng cái sẽ gọi).
        """
        if self.active_run_id:
            raise RunBusyError(self.active_run_id)

        state = self.agent.new_state(request)  # raise InvalidModelSelection nếu sai catalog
        workspace = RunWorkspace(self.runs_dir, state.session_id).create()
        self.store.create_run(
            state.session_id,
            request.message,
            state.max_iterations,
            state.timeout_seconds,
            state.model,
            self.agent.executor.describe(),
            provider=state.provider,
        )

        active = ActiveRun(run_id=state.session_id)
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
        """Lưu event vào SQLite (nếu cần) rồi đẩy ngay cho mọi SSE client đang nghe."""
        try:
            self._persist(active.run_id, event, data)
        except Exception:
            logger.exception(f"[{active.run_id}] Failed to persist event '{event}'")
        if event == "done":
            active.finished = True
        for q in list(active.subscribers):
            q.put_nowait((event, data))

    async def _run(self, request, state, workspace, active: ActiveRun) -> AgentResponse | None:
        async def emit(event: str, data: dict) -> None:
            self._publish(active, event, data)

        try:
            return await self.agent.run(request, state=state, workspace=workspace, emit=emit)
        finally:
            # Lưới an toàn: run đã kết thúc thì không bao giờ còn 'running' trong DB
            row = self.store.get_run(active.run_id)
            if row and row["status"] == ExecutionStatus.RUNNING.value:
                msg = "Run ended unexpectedly."
                self.store.finish_run(active.run_id, "error", "", msg, row["iteration_count"])
                await emit("done", {"session_id": active.run_id, "status": "error",
                                    "answer": msg, "message": msg, "iterations": row["iteration_count"]})
            active.finished = True
            if self._active is active:
                self._active = None

    # ── Event → SQLite ─────────────────────────────
    def _persist(self, run_id: str, event: str, data: dict) -> None:
        n = data.get("iteration")
        if event == "log":
            data["id"] = self.store.add_log(run_id, data)   # id dùng để client nối tiếp / khử trùng
        elif event == "iteration" and data.get("phase") == "planning":
            self.store.start_iteration(run_id, n, data.get("intent", "write"), data.get("detail", ""))
        elif event == "activity":
            data["at"] = self.store.set_activity(run_id, n, data["phase"], data["text"])
        elif event == "code_progress":
            # Code đang stream: lưu bản dở để UI (kể cả sau refresh) thấy ngay
            self.store.update_iteration(run_id, n, code=data["code"], explanation=data["explanation"])
            self.store.set_activity(
                run_id, n, "streaming", f"Model is writing code… {data['chars']:,} chars", touch=False
            )
        elif event == "iteration" and data.get("phase") == "executing":
            self.store.update_iteration(run_id, n, status=ITER_EXECUTING)
        elif event == "code":
            self.store.update_iteration(
                run_id, n, code=data["code"], language=data["language"], explanation=data["explanation"]
            )
        elif event == "model_done":
            self.store.update_iteration(
                run_id, n, status=ITER_DONE, explanation=data["explanation"], finished_at=now_iso()
            )
        elif event == "result":
            if data["timed_out"]:
                status = ITER_TIMED_OUT
            elif data["exit_code"] == 0:
                status = ITER_SUCCEEDED
            else:
                status = ITER_FAILED
            artifacts = [
                {"path": p, "size": int(_SIZE_RE.search(s).group(1)) if _SIZE_RE.search(s) else 0}
                for p, s in data["artifacts"].items()
            ]
            self.store.update_iteration(
                run_id,
                n,
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
        elif event == "done":
            self.store.finish_run(
                run_id, data["status"], data["answer"], data.get("message", ""), data["iterations"]
            )

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
        self._publish(active, "log", make_entry(None, WARN, "runtime", "Stop requested by user"))
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
