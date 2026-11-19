"""
The stop rules of the agent loop: pure functions of the run state.

They decide whether the model gets another turn, what that turn is for, and the final status. No model call,
no subprocess, no I/O — so tests/integration/test_agent_loop.py can check them directly. agent.py applies them.
"""

from dataclasses import dataclass

from agent_workbench.domain.schemas import AgentState, ExecutionResult, ExecutionStatus

# Code that exits 0 but prints nothing is still a success, not "No result".
NO_STDOUT_NOTE = "(code ran successfully but printed nothing to stdout)"

@dataclass(frozen=True)
class Turn:
    """One model call. `final_review`: the code-run limit is reached, so this call may only answer DONE."""

    number: int
    runs_done: int
    final_review: bool
    intent: str     # write | fix | review: what the model is called for
    detail: str     # for "fix": the error being fixed


def next_turn(state: AgentState) -> Turn | None:
    """
    Whether the model gets another turn.
      - max_iterations = max number of CODE RUNS (not the number of model calls).
      - Limit reached and the last run SUCCEEDED → one extra "final review" turn: the model looks at the
        output and may answer DONE; the code it returns in that turn is NOT run.
      - Limit reached and the last run failed/timed out → None: stop now, the model would have no turn
        left to fix anything.
    So the number of model calls is ≤ max_iterations + 1 (not counting retries for malformed JSON).
    """
    runs_done = len(state.execution_results)
    final_review = runs_done >= state.max_iterations
    if final_review and not last_run_succeeded(state):
        return None
    intent, detail = intent_for(state)
    if final_review:
        detail = "final review: no code runs left"
    return Turn(state.current_iteration + 1, runs_done, final_review, intent, detail)


def done_outcome(state: AgentState) -> tuple[ExecutionStatus, str]:
    """The model said DONE: only accepted if at least one run has succeeded."""
    if last_success(state):
        return ExecutionStatus.SUCCESS, "The model confirmed the task is complete."
    return ExecutionStatus.ERROR, "The model reported DONE but no code ran successfully."


def limit_outcome(state: AgentState) -> tuple[ExecutionStatus, str]:
    """The run limit was reached and the model has not said DONE."""
    last = state.execution_results[-1] if state.execution_results else None
    if last and last.timed_out:
        return ExecutionStatus.TIMEOUT, (
            f"Code run limit reached ({state.max_iterations}); the last execution "
            f"timed out after {state.timeout_seconds}s."
        )
    msg = (
        f"Reached the code run limit ({state.max_iterations}) before the model "
        "confirmed the task was done."
    )
    if last and last.exit_code != 0:
        msg += f" Last error: {last.stderr[:300]}"
    elif last_success(state):
        msg += (" The model reviewed the last output and asked for another step. "
                "Showing the latest successful output as a partial result.")
    return ExecutionStatus.MAX_RETRIES, msg


def intent_for(state: AgentState) -> tuple[str, str]:
    """What is the next model call for? ('write' | 'fix' | 'review', short detail)."""
    if not state.execution_results:
        return "write", ""
    last = state.execution_results[-1]
    if last.exit_code == 0:
        return "review", ""
    if last.timed_out:
        return "fix", f"execution timed out after {state.timeout_seconds}s"
    return "fix", short_error(last.stderr)


def last_run_succeeded(state: AgentState) -> bool:
    """Whether the LAST run (not just any run) exited with code 0."""
    return bool(state.execution_results) and state.execution_results[-1].exit_code == 0


def last_success(state: AgentState) -> ExecutionResult | None:
    for r in reversed(state.execution_results):
        if r.exit_code == 0:
            return r
    return None


def best_answer(state: AgentState) -> str:
    """The latest successful output, kept as a partial result even if the run did not finish."""
    r = last_success(state)
    if r is None:
        return ""
    return r.stdout or NO_STDOUT_NOTE


def detect_false_success(stdout: str) -> bool:
    """
    Detects code that exits 0 but whose output is actually an error.
    E.g. the LLM wraps the code in try/except and then prints("Error: file not found").
    This is a heuristic and can misfire.
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


def short_error(stderr: str, limit: int = 160) -> str:
    """The last meaningful error line, e.g. "NameError: name 'x' is not defined"."""
    lines = [l.strip() for l in stderr.strip().splitlines() if l.strip()]
    if not lines:
        return "the previous execution failed"
    # Python traceback: the last line is "XxxError: message"
    line = lines[-1]
    for candidate in reversed(lines):
        if "Error" in candidate or "Exception" in candidate:
            line = candidate
            break
    return line if len(line) <= limit else line[: limit - 1] + "…"
