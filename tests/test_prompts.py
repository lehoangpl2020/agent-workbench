"""Behavior of the context sent back to the model (the full conversation shapes are pinned in test_characterization)."""

from prompts import MAX_STDERR_CHARS, TRUNCATION_NOTE, build_messages
from schemas import AgentState, CodeBlock, ExecutionResult


def failed_state(stderr: str) -> AgentState:
    state = AgentState(user_request="task", max_iterations=3)
    state.generated_code.append(CodeBlock(code="x", explanation="e"))
    state.execution_results.append(ExecutionResult(stderr=stderr, exit_code=1))
    return state


def test_a_long_traceback_keeps_the_line_that_names_the_error():
    stderr = "Traceback (most recent call last):\n" + "  File 'x.py', line 1, in f\n" * 400 + "ValueError: the real cause"
    assert len(stderr) > MAX_STDERR_CHARS
    feedback = build_messages(failed_state(stderr))[-1]["content"]
    assert "ValueError: the real cause" in feedback
    assert TRUNCATION_NOTE in feedback
    assert stderr[:50] not in feedback   # the start is what gets cut


def test_a_short_stderr_is_sent_whole_and_unmarked():
    feedback = build_messages(failed_state("NameError: x"))[-1]["content"]
    assert "NameError: x" in feedback and TRUNCATION_NOTE not in feedback
