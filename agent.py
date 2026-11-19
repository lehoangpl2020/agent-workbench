"""
Agent Orchestrator — Component 3/3 (Feedback Loop)
Điều phối vòng lặp: Plan → Execute → Evaluate → Retry/Done.

Đây là agent loop DUY NHẤT. Sync API, SSE API, CLI và example.py đều gọi
CodeAgent.run(). Tiến độ được báo ra ngoài qua callback `emit(event, data)`;
RunManager (runs.py) dùng callback đó để lưu SQLite và đẩy SSE.

Ai quyết định gì:
  - Model (planner) quyết định: viết code gì, và khi nào trả lời DONE.
  - Application (file này) quyết định: chạy code, khi nào dừng
    (DONE / hết iteration / lỗi hạ tầng / Stop), trạng thái cuối là gì.
"""

import asyncio
import logging
from typing import Awaitable, Callable

from schemas import (
    AgentRequest,
    AgentResponse,
    AgentState,
    ExecutionResult,
    ExecutionStatus,
)
from model_catalog import ModelSpec, resolve
from planner import LLMPlanner
from executor import BaseExecutor, LocalExecutor
from workspace import RunWorkspace
from runlog import ERROR, INFO, WARN, make_entry

logger = logging.getLogger(__name__)

# Code chạy OK (exit_code=0) nhưng không print gì: vẫn là thành công, không phải "No result".
NO_STDOUT_NOTE = "(code ran successfully but printed nothing to stdout)"

EmitFn = Callable[[str, dict], Awaitable[None]]
# Tạo planner cho đúng provider/model của 1 run
PlannerFactory = Callable[[ModelSpec], LLMPlanner]


async def _no_emit(event: str, data: dict) -> None:
    return None


class CodeAgent:
    """
    Main agent loop (mỗi iteration = 1 lần gọi model; max_iterations = số lần CHẠY CODE tối đa):

    1. Planner sinh code (hoặc trả lời DONE nếu output trước đã đủ)
    2. Executor chạy code trong sandbox, có timeout thật
    3. Evaluate:
       - model báo DONE                      → SUCCESS (Completed)
       - code lỗi / timeout                  → iteration sau, kèm error context
       - code chạy OK                        → iteration sau, model xem output rồi quyết định DONE
       - lỗi hạ tầng / planner               → ERROR (Failed)
       - hết lượt chạy, lần cuối chạy OK     → thêm 1 lượt "final review" (không chạy code nữa):
                                               DONE → SUCCESS, không DONE → MAX_RETRIES
       - hết lượt chạy, lần cuối lỗi/timeout → MAX_RETRIES / TIMEOUT ngay, giữ kết quả tạm
       - task bị cancel (Stop)               → STOPPED
    """

    def __init__(
        self,
        planner: LLMPlanner | None = None,
        executor: BaseExecutor | None = None,
        max_iterations: int = 5,
        default_timeout: int = 30,
        planner_factory: PlannerFactory | None = None,
    ):
        # planner cố định (test / example.py) hoặc factory tạo planner theo model của từng run
        self.planner = planner
        self.planner_factory = planner_factory or (lambda spec: LLMPlanner(spec))
        self.executor = executor or LocalExecutor()
        self.max_iterations = max_iterations
        self.default_timeout = default_timeout
        self.sessions: dict[str, AgentState] = {}

    def new_state(self, request: AgentRequest) -> AgentState:
        """Raise InvalidModelSelection nếu provider/model không có trong catalog."""
        spec = resolve(request.provider, request.model)
        return AgentState(
            user_request=request.message,
            max_iterations=request.max_iterations or self.max_iterations,
            timeout_seconds=request.timeout_seconds or self.default_timeout,
            provider=spec.provider,
            model=spec.id,
        )

    def planner_for(self, state: AgentState):
        """Planner dùng cho CẢ run — tạo 1 lần, không đổi giữa các iteration."""
        if self.planner is not None:
            return self.planner
        return self.planner_factory(resolve(state.provider, state.model))

    async def run(
        self,
        request: AgentRequest,
        *,
        state: AgentState | None = None,
        workspace: RunWorkspace | None = None,
        emit: EmitFn | None = None,
    ) -> AgentResponse:
        state = state or self.new_state(request)
        workspace = workspace or RunWorkspace(self.executor.runs_dir, state.session_id).create()
        emit = emit or _no_emit
        self.sessions[state.session_id] = state
        state.status = ExecutionStatus.RUNNING
        if not state.model:
            spec = resolve(request.provider, request.model)
            state.provider, state.model = spec.provider, spec.id

        logger.info(f"[{state.session_id}] Starting agent for: '{request.message[:80]}'")
        await emit(
            "session",
            {
                "session_id": state.session_id,
                "max_iterations": state.max_iterations,
                "timeout_seconds": state.timeout_seconds,
                "provider": state.provider,
                "model": state.model,
            },
        )

        log = self._logger(emit, None)
        await log(
            INFO, "runtime", "Run started",
            flow="started", provider=state.provider, model=state.model,
            executor=self.executor.describe(),
            max_iterations=state.max_iterations,
            timeout_seconds=state.timeout_seconds,
        )

        try:
            try:
                planner = self.planner_for(state)
            except Exception as e:
                # vd thiếu API key: dừng ngay, KHÔNG chuyển sang provider khác
                await log(ERROR, "runtime", f"Cannot create the model client: {e}",
                          error_kind=getattr(e, "kind", None))
                self._finish(state, ExecutionStatus.ERROR, f"Cannot use {state.provider}/{state.model}: {e}")
            else:
                await self._loop(state, workspace, emit, planner)
        except asyncio.CancelledError:
            # User bấm Stop → RunManager cancel task này. Executor đã kill process.
            task = asyncio.current_task()
            if task is not None:
                task.uncancel()
            state.status = ExecutionStatus.STOPPED
            state.message = "Stopped by user."
            state.final_answer = self._best_answer(state) or state.message
        except Exception as e:  # lưới an toàn: không bao giờ để run kẹt ở RUNNING
            logger.exception(f"[{state.session_id}] Unexpected agent error")
            state.status = ExecutionStatus.ERROR
            state.message = f"Unexpected error: {type(e).__name__}: {e}"
            state.final_answer = self._best_answer(state) or state.message

        level = {ExecutionStatus.SUCCESS: INFO, ExecutionStatus.ERROR: ERROR}.get(state.status, WARN)
        await self._logger(emit, state.current_iteration or None)(
            level, "runtime", f"Run finished: {state.status.value} — {state.message}",
            flow="finished", iterations=state.current_iteration,
        )

        logger.info(
            f"[{state.session_id}] Finished: status={state.status.value}, "
            f"iterations={state.current_iteration}"
        )
        response = AgentResponse(
            session_id=state.session_id,
            status=state.status,
            answer=state.final_answer,
            message=state.message,
            code_blocks=state.generated_code,
            execution_results=state.execution_results,
            iterations=state.current_iteration,
            provider=state.provider,
            model=state.model,
        )
        if state.status == ExecutionStatus.ERROR:
            await emit("error", {"message": state.message})
        await emit("done", response.model_dump(mode="json"))
        return response

    # ═══════════════════════════════════════════
    # FEEDBACK LOOP: Plan → Execute → Evaluate
    # ═══════════════════════════════════════════
    async def _loop(self, state: AgentState, workspace: RunWorkspace, emit: EmitFn, planner) -> None:
        """
        Điều kiện dừng (application quyết định, trừ DONE là model quyết định):
          - max_iterations = số lần CHẠY CODE tối đa (không phải số lần gọi model).
          - Hết lượt chạy mà lần chạy cuối THÀNH CÔNG → gọi model thêm 1 lượt "final review"
            chỉ để xem output và trả DONE; code trả về ở lượt này KHÔNG được chạy.
          - Hết lượt chạy mà lần chạy cuối lỗi/timeout → dừng ngay, không gọi model nữa
            (model không còn lượt nào để sửa).
        Vì vậy số lần gọi model ≤ max_iterations + 1 (chưa tính retry do JSON sai format).
        """
        while True:
            runs_done = len(state.execution_results)
            final_review = runs_done >= state.max_iterations
            if final_review and not self._last_run_succeeded(state):
                break

            state.current_iteration += 1
            n = state.current_iteration
            logger.info(f"[{state.session_id}] ━━━ Iteration {n} (code runs {runs_done}/{state.max_iterations}) ━━━")

            log = self._logger(emit, n)

            # ── Step 1: Plan — model sinh code ─────
            # intent cho biết model được gọi để làm gì: viết mới / sửa lỗi / xem kết quả
            intent, detail = self._intent(state)
            if final_review:
                detail = "final review: no code runs left"
            await emit("iteration", {"iteration": n, "phase": "planning", "intent": intent, "detail": detail})
            action = {
                "write": "Asking the model to write code",
                "fix": f"Asking the model to fix: {detail}",
                "review": "Waiting for the model to decide: DONE or another step",
            }[intent]
            if final_review:
                action = "Final review: waiting for the model to confirm DONE (no code runs left)"
            await emit("activity", {"iteration": n, "phase": intent, "text": action})
            started = (f"Iteration {n} started: final review (code run limit {state.max_iterations} reached)"
                       if final_review else
                       f"Iteration {n} started (code run {runs_done + 1}/{state.max_iterations})")
            await log(INFO, "runtime", started, intent=intent, final_review=final_review or None,
                      flow="write" if intent == "write" else None)
            if intent == "fix":
                await log(WARN, "runtime", f"Sending the error back to the model to fix: {detail}", flow="fix")
            elif intent == "review":
                prev = state.execution_results[-1]
                ask = ("Sending the last output back to the model for a final review: DONE or not "
                       "(no more code will run)") if final_review else (
                       "Sending the execution output back to the model to decide: DONE or another step")
                await log(INFO, "runtime", ask,
                          flow="review", stdout_chars=len(prev.stdout), files=list(prev.artifacts) or None)

            async def on_progress(partial_code: str, partial_explanation: str) -> None:
                await emit("code_progress", {
                    "iteration": n,
                    "code": partial_code,
                    "explanation": partial_explanation,
                    "chars": len(partial_code),
                })

            try:
                block = await planner.generate_code(
                    state, on_progress=on_progress, on_log=log
                )
            except Exception as e:
                logger.error(f"[{state.session_id}] Planner error: {e}")
                await log(ERROR, "runtime", f"Planner failed: {e}")
                self._finish(state, ExecutionStatus.ERROR, f"Failed to generate code: {e}")
                return
            state.generated_code.append(block)

            # Model báo DONE: chỉ chấp nhận nếu đã có ít nhất 1 lần chạy thành công
            if block.is_done:
                await emit("model_done", {"iteration": n, "explanation": block.explanation})
                await log(INFO, "model", "Model replied DONE: the output satisfies the request", flow="done_reply")
                if self._last_success(state):
                    self._finish(
                        state, ExecutionStatus.SUCCESS, "The model confirmed the task is complete."
                    )
                else:
                    self._finish(
                        state,
                        ExecutionStatus.ERROR,
                        "The model reported DONE but no code ran successfully.",
                    )
                return

            if final_review:
                # Model chưa hài lòng nhưng đã hết lượt chạy: lưu lại code để xem, KHÔNG chạy.
                await emit("code", {"iteration": n, "language": block.language, "code": block.code,
                                    "code_preview": block.code[:300], "explanation": block.explanation})
                if block.explanation:
                    await log(INFO, "model", block.explanation)
                await log(WARN, "runtime", f"Model asked for another step, but the code run limit "
                          f"({state.max_iterations}) is reached — this code was not executed")
                break

            await emit(
                "code",
                {
                    "iteration": n,
                    "language": block.language,
                    "code": block.code,
                    "code_preview": block.code[:300],
                    "explanation": block.explanation,
                },
            )

            if block.explanation:
                await log(INFO, "model", block.explanation, flow="code")
            else:
                await log(INFO, "runtime", "Received code from the model", flow="code")

            # ── Step 2: Execute — chạy code ────────
            await emit("iteration", {"iteration": n, "phase": "executing"})
            await emit("activity", {"iteration": n, "phase": "executing", "text":
                f"Running iter_{n:02d}.py in the sandbox (timeout {state.timeout_seconds}s)"})

            async def on_exec_progress(phase: str, text: str) -> None:
                await emit("activity", {"iteration": n, "phase": phase, "text": text})

            try:
                result = await self.executor.execute(
                    block.code,
                    block.language,
                    workspace=workspace,
                    iteration=n,
                    timeout=state.timeout_seconds,
                    progress=on_exec_progress,
                    log=log,
                )
            except Exception as e:
                logger.exception(f"[{state.session_id}] Executor error")
                result = ExecutionResult(stderr=f"Executor error: {e}", system_error=True)

            # ── Step 3: Evaluate (runtime tự kiểm tra, CHƯA hỏi model) ──
            checking = f"Runtime checking the result (exit code {result.exit_code})"
            await emit("activity", {"iteration": n, "phase": "checking", "text": checking})
            await log(INFO, "runtime", checking, flow="checking")
            if result.exit_code == 0 and self._detect_false_success(result.stdout):
                logger.warning(f"[{state.session_id}] False success: '{result.stdout[:100].strip()}'")
                await log(WARN, "runtime", "Exit code 0 but the output looks like an error — "
                          "treating this run as failed")
                result.false_success = True
                result.exit_code = 1
                result.stderr = (
                    f"Code ran but output indicates failure:\n{result.stdout}\n"
                    "Do NOT use try/except to hide errors. "
                    "If a file doesn't exist, create sample data and proceed."
                )
            state.execution_results.append(result)

            await emit(
                "result",
                {
                    "iteration": n,
                    "exit_code": result.exit_code,
                    "stdout": result.stdout,
                    "stderr": result.stderr,
                    "stdout_preview": result.stdout[:500],
                    "stderr_preview": result.stderr[:300],
                    "time_ms": result.execution_time_ms,
                    "timed_out": result.timed_out,
                    "false_success": result.false_success,
                    "artifacts": result.artifacts,
                },
            )

            await log(INFO if result.exit_code == 0 else WARN, "runtime", "Execution result recorded",
                      flow="result", exit_code=result.exit_code,
                      error=_short_error(result.stderr) if result.exit_code != 0 else None)

            if result.system_error:
                await log(ERROR, "runtime", "System error in the sandbox — stopping the loop "
                          "(the model cannot fix infrastructure problems)")
                self._finish(state, ExecutionStatus.ERROR, f"Sandbox error: {result.stderr[:500]}")
                return
            # Thành công hay lỗi đều lặp tiếp: model xem output/lỗi rồi quyết định.

        # ── Hết lượt chạy code mà model chưa báo DONE ─────
        await self._logger(emit, state.current_iteration or None)(
            WARN, "runtime", f"Code run limit reached ({state.max_iterations}) without DONE from the model"
        )
        last = state.execution_results[-1] if state.execution_results else None
        if last and last.timed_out:
            self._finish(
                state,
                ExecutionStatus.TIMEOUT,
                f"Code run limit reached ({state.max_iterations}); the last execution "
                f"timed out after {state.timeout_seconds}s.",
            )
        else:
            msg = (
                f"Reached the code run limit ({state.max_iterations}) before the model "
                "confirmed the task was done."
            )
            if last and last.exit_code != 0:
                msg += f" Last error: {last.stderr[:300]}"
            elif self._last_success(state):
                msg += (" The model reviewed the last output and asked for another step. "
                        "Showing the latest successful output as a partial result.")
            self._finish(state, ExecutionStatus.MAX_RETRIES, msg)

    # ─── helpers ──────────────────────────────────
    @staticmethod
    def _logger(emit: EmitFn, iteration: int | None):
        """log(level, source, message, **data) gắn sẵn iteration → phát event "log"."""
        async def log(level: str, source: str, message: str, **data) -> None:
            await emit("log", make_entry(iteration, level, source, message, **data))
        return log

    @staticmethod
    def _intent(state: AgentState) -> tuple[str, str]:
        """Lần gọi model này để làm gì? ('write' | 'fix' | 'review', chi tiết ngắn)."""
        if not state.execution_results:
            return "write", ""
        last = state.execution_results[-1]
        if last.exit_code == 0:
            return "review", ""
        if last.timed_out:
            return "fix", f"execution timed out after {state.timeout_seconds}s"
        return "fix", _short_error(last.stderr)

    def _finish(self, state: AgentState, status: ExecutionStatus, message: str) -> None:
        state.status = status
        state.message = message
        # Giữ kết quả tạm (output thành công gần nhất) kể cả khi chưa xong
        state.final_answer = self._best_answer(state) or message

    @staticmethod
    def _last_run_succeeded(state: AgentState) -> bool:
        """Lần chạy CUỐI CÙNG (không phải bất kỳ lần nào) có exit code 0 không."""
        return bool(state.execution_results) and state.execution_results[-1].exit_code == 0

    @staticmethod
    def _last_success(state: AgentState) -> ExecutionResult | None:
        for r in reversed(state.execution_results):
            if r.exit_code == 0:
                return r
        return None

    def _best_answer(self, state: AgentState) -> str:
        r = self._last_success(state)
        if r is None:
            return ""
        return r.stdout or NO_STDOUT_NOTE

    @staticmethod
    def _detect_false_success(stdout: str) -> bool:
        """
        Detect khi code exit_code=0 nhưng output thực chất là error.
        VD: LLM bọc try/except rồi print("Error: file not found").
        """
        if not stdout.strip():
            return False
        first_line = stdout.strip().lower().split("\n")[0]
        error_patterns = [
            "error:",
            "not found",
            "does not exist",
            "no such file",
            "failed to",
            "could not",
            "permission denied",
            "file not found",
        ]
        if len(stdout.strip()) < 200:
            return any(p in first_line for p in error_patterns)
        return False

    def get_session(self, session_id: str) -> AgentState | None:
        return self.sessions.get(session_id)


def _short_error(stderr: str, limit: int = 160) -> str:
    """Dòng lỗi có ý nghĩa cuối cùng, vd "NameError: name 'x' is not defined"."""
    lines = [l.strip() for l in stderr.strip().splitlines() if l.strip()]
    if not lines:
        return "the previous execution failed"
    # Traceback Python: dòng cuối là "XxxError: message"
    line = lines[-1]
    for candidate in reversed(lines):
        if "Error" in candidate or "Exception" in candidate:
            line = candidate
            break
    return line if len(line) <= limit else line[: limit - 1] + "…"
