"""
The agent's stop rules as pure functions of the run state: no model, no subprocess, instant.
The end-to-end behavior of the same rules is covered in test_agent_loop.py.
"""

import pytest

from agent_workbench.core.agent import Turn, best_answer, detect_false_success, done_outcome, intent_for, limit_outcome, next_turn
from agent_workbench.domain.schemas import AgentState, CodeBlock, ExecutionResult, ExecutionStatus


def state(*results: ExecutionResult, max_iterations=3, iteration=None) -> AgentState:
    s = AgentState(user_request="t", max_iterations=max_iterations, timeout_seconds=30)
    for r in results:
        s.generated_code.append(CodeBlock(code="x"))
        s.execution_results.append(r)
    s.current_iteration = len(results) if iteration is None else iteration
    return s


OK = ExecutionResult(stdout="out", exit_code=0)
FAIL = ExecutionResult(stderr="Traceback\nValueError: boom", exit_code=1)
TIMEOUT = ExecutionResult(stdout="partial", exit_code=124, timed_out=True)


def test_first_turn_writes():
    assert next_turn(state()) == Turn(1, 0, False, "write", "")


def test_turn_after_failure_fixes_with_the_error():
    turn = next_turn(state(FAIL))
    assert (turn.number, turn.intent, turn.detail, turn.final_review) == (2, "fix", "ValueError: boom", False)


def test_turn_after_timeout_fixes_with_the_timeout():
    assert next_turn(state(TIMEOUT)).detail == "execution timed out after 30s"


def test_turn_after_success_reviews():
    assert next_turn(state(OK)).intent == "review"


def test_limit_reached_after_success_gives_one_final_review_turn():
    turn = next_turn(state(OK, OK, OK, max_iterations=3))
    assert turn.final_review and turn.intent == "review" and turn.detail == "final review: no code runs left"
    assert turn.number == 4   # max_iterations code runs + 1 model call


@pytest.mark.parametrize("last", [FAIL, TIMEOUT])
def test_limit_reached_after_failure_gives_no_more_turns(last):
    assert next_turn(state(OK, OK, last, max_iterations=3)) is None


def test_done_needs_a_successful_run():
    assert done_outcome(state(OK))[0] == ExecutionStatus.SUCCESS
    assert done_outcome(state(FAIL, OK, FAIL))[0] == ExecutionStatus.SUCCESS   # any earlier success counts
    assert done_outcome(state(FAIL))[0] == ExecutionStatus.ERROR
    assert done_outcome(state())[0] == ExecutionStatus.ERROR


def test_limit_outcomes():
    assert limit_outcome(state(OK, TIMEOUT, max_iterations=2))[0] == ExecutionStatus.TIMEOUT
    status, message = limit_outcome(state(OK, FAIL, max_iterations=2))
    assert status == ExecutionStatus.MAX_RETRIES and "ValueError: boom" in message
    status, message = limit_outcome(state(FAIL, OK, max_iterations=2))
    assert status == ExecutionStatus.MAX_RETRIES and "partial result" in message


def test_best_answer_is_the_latest_successful_output():
    assert best_answer(state(ExecutionResult(stdout="one", exit_code=0), FAIL)) == "one"
    assert best_answer(state(FAIL)) == ""
    assert "printed nothing" in best_answer(state(ExecutionResult(exit_code=0)))


@pytest.mark.parametrize("stdout, expected", [
    ("Error: file not found", True),
    ("could not open the file", True),
    ("42", False),
    ("", False),
    ("x" * 300 + "\nError: late", False),   # long outputs are never flagged
])
def test_false_success_heuristic(stdout, expected):
    assert detect_false_success(stdout) is expected


def test_intent_for_a_fresh_run():
    assert intent_for(state()) == ("write", "")
