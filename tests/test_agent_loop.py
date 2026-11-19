"""
Agent loop: every way of finishing must end in the right status.
Mock planner + LocalExecutor running a real subprocess.
"""

import asyncio
import time

from agent import CodeAgent
from executor import BaseExecutor, LocalExecutor
from prompts import build_messages
from schemas import AgentRequest, ExecutionResult, ExecutionStatus
from tests.conftest import DONE, Hang, ScriptedPlanner, code


def make_agent(tmp_path, steps, max_iterations=5, timeout=10):
    planner = ScriptedPlanner(steps)
    executor = LocalExecutor(timeout=timeout, runs_dir=tmp_path / "runs")
    return CodeAgent(planner=planner, executor=executor, max_iterations=max_iterations), planner


def run(agent, prompt="task", **kw):
    return asyncio.run(agent.run(AgentRequest(message=prompt, **kw)))


def test_done_after_success_is_completed(tmp_path):
    agent, _ = make_agent(tmp_path, [code("print(2 + 2)"), DONE])
    resp = run(agent)
    assert resp.status == ExecutionStatus.SUCCESS
    assert resp.answer.strip() == "4"
    assert resp.iterations == 2


def test_success_without_done_hits_run_limit_and_keeps_partial(tmp_path):
    steps = [code("print('step 1')"), code("print('step 2')"),
             code("open('/workspace/output/never.txt','w').write('x')\nprint('step 3')")]
    agent, _ = make_agent(tmp_path, steps, max_iterations=2)
    resp = run(agent)
    # A successful run does NOT mean it is done: the model reviews the output one last time and has not said DONE
    assert resp.status == ExecutionStatus.MAX_RETRIES
    assert resp.answer.strip() == "step 2"  # the partial result is kept
    assert "code run limit" in resp.message.lower()
    # 2 code runs + 1 final review turn; the code of the final review turn must NOT be run
    assert resp.iterations == 3 and len(resp.execution_results) == 2
    assert not list((tmp_path / "runs").glob("*/output/never.txt"))
    assert not list((tmp_path / "runs").glob("*/code/iter_03.py"))


# ─── Stop conditions: max_iterations = number of CODE RUNS ─────────────────
def test_single_code_run_can_still_succeed(tmp_path):
    agent, planner = make_agent(tmp_path, [code("print(2 + 2)"), DONE], max_iterations=1)
    resp = run(agent)
    assert resp.status == ExecutionStatus.SUCCESS
    assert resp.answer.strip() == "4"
    assert len(resp.execution_results) == 1 and resp.iterations == 2
    # The final review turn is reported as having no run turns left
    review = build_messages(planner.seen_states[1])[-1]["content"]
    assert "last allowed code run" in review


def test_success_on_last_run_gets_final_review(tmp_path):
    agent, _ = make_agent(
        tmp_path, [code("raise ValueError('boom')"), code("print('fixed')"), DONE], max_iterations=2
    )
    resp = run(agent)
    assert resp.status == ExecutionStatus.SUCCESS
    assert resp.answer.strip() == "fixed"
    assert resp.iterations == 3


def test_failed_last_run_stops_without_extra_model_call(tmp_path):
    agent, planner = make_agent(tmp_path, [code("raise RuntimeError('still broken')")], max_iterations=2)
    resp = run(agent)
    assert resp.status == ExecutionStatus.MAX_RETRIES
    # No run turn left to fix anything → the model is not called again
    assert len(planner.seen_states) == 2 and resp.iterations == 2


def test_review_before_limit_still_allows_next_step(tmp_path):
    agent, planner = make_agent(
        tmp_path, [code("print('step 1')"), code("print('step 2')"), DONE], max_iterations=3
    )
    resp = run(agent)
    assert resp.status == ExecutionStatus.SUCCESS
    assert resp.answer.strip() == "step 2"
    first_review = build_messages(planner.seen_states[1])[-1]["content"]
    assert "generate code for the next step" in first_review
    assert "last allowed code run" not in first_review


def test_error_is_fed_back_then_fixed(tmp_path):
    agent, planner = make_agent(
        tmp_path, [code("raise ValueError('boom')"), code("print('fixed')"), DONE]
    )
    resp = run(agent)
    assert resp.status == ExecutionStatus.SUCCESS
    assert resp.answer.strip() == "fixed"
    # The 2nd model call must see the 1st run's stderr in its messages
    messages = build_messages(planner.seen_states[1])
    assert "boom" in messages[-1]["content"] and "FAILED" in messages[-1]["content"]


def test_errors_until_limit(tmp_path):
    agent, _ = make_agent(tmp_path, [code("raise RuntimeError('still broken')")], max_iterations=2)
    resp = run(agent)
    assert resp.status == ExecutionStatus.MAX_RETRIES
    assert "still broken" in resp.message
    assert [r.exit_code != 0 for r in resp.execution_results] == [True, True]


def test_execution_timeout_kills_code(tmp_path):
    agent, _ = make_agent(tmp_path, [code("import time\ntime.sleep(30)\nprint('never')")], max_iterations=1)
    start = time.monotonic()
    resp = run(agent, timeout_seconds=1)
    assert time.monotonic() - start < 8
    assert resp.status == ExecutionStatus.TIMEOUT
    result = resp.execution_results[0]
    assert result.timed_out and result.exit_code == 124
    assert "timed out after 1s" in result.stderr


def test_timeout_is_fed_back_and_model_can_recover(tmp_path):
    agent, planner = make_agent(
        tmp_path, [code("import time\ntime.sleep(30)"), code("print('fast')"), DONE]
    )
    resp = run(agent, timeout_seconds=1)
    assert resp.status == ExecutionStatus.SUCCESS
    messages = build_messages(planner.seen_states[1])
    assert "TIMED OUT" in messages[-1]["content"]


def test_stop_during_execution_kills_process(tmp_path):
    src = (
        "import time, pathlib\n"
        "print('started', flush=True)\n"
        "time.sleep(3)\n"
        "pathlib.Path('after_sleep.txt').write_text('should not exist')\n"
    )
    agent, _ = make_agent(tmp_path, [code(src)])
    events = []

    async def emit(event, data):
        events.append((event, data))

    async def scenario():
        task = asyncio.create_task(agent.run(AgentRequest(message="t"), emit=emit))
        while not any(e == "iteration" and d.get("phase") == "executing" for e, d in events):
            await asyncio.sleep(0.05)
        await asyncio.sleep(0.5)  # the process is already running
        task.cancel()
        return await task

    resp = asyncio.run(scenario())
    assert resp.status == ExecutionStatus.STOPPED
    assert events[-1][0] == "done" and events[-1][1]["status"] == "stopped"
    time.sleep(3.5)
    outputs = list((tmp_path / "runs").glob("*/output/after_sleep.txt"))
    assert outputs == [], "process kept running after Stop"


def test_stop_during_planning(tmp_path):
    agent, _ = make_agent(tmp_path, [Hang()])

    async def scenario():
        task = asyncio.create_task(agent.run(AgentRequest(message="t")))
        await asyncio.sleep(0.2)
        task.cancel()
        return await task

    start = time.monotonic()
    resp = asyncio.run(scenario())
    assert resp.status == ExecutionStatus.STOPPED
    assert time.monotonic() - start < 3


def test_planner_error_is_failed(tmp_path):
    agent, _ = make_agent(tmp_path, [RuntimeError("API down")])
    resp = run(agent)
    assert resp.status == ExecutionStatus.ERROR
    assert "API down" in resp.message


def test_done_without_any_success_is_failed(tmp_path):
    agent, _ = make_agent(tmp_path, [DONE])
    resp = run(agent)
    assert resp.status == ExecutionStatus.ERROR


def test_false_success_is_treated_as_error(tmp_path):
    agent, _ = make_agent(tmp_path, [code("print('Error: file not found')"), code("print('ok')"), DONE])
    resp = run(agent)
    assert resp.status == ExecutionStatus.SUCCESS
    assert resp.execution_results[0].false_success
    assert resp.execution_results[0].exit_code == 1


class BrokenSandbox(BaseExecutor):
    name = "broken"

    async def execute(self, code, language="python", **kw):
        return ExecutionResult(stderr="Container 'agent-workbench-sandbox' not found", system_error=True)


def test_sandbox_system_error_stops_loop(tmp_path):
    planner = ScriptedPlanner([code("print(1)")])
    agent = CodeAgent(planner=planner, executor=BrokenSandbox(runs_dir=tmp_path), max_iterations=5)
    resp = run(agent)
    assert resp.status == ExecutionStatus.ERROR
    assert resp.iterations == 1
    assert "not found" in resp.message


def test_file_scanning_and_snapshots_do_not_block_the_event_loop(tmp_path, monkeypatch):
    """Invariant 2: directory walks and snapshot copies run in a worker thread, not on the event loop."""
    import threading
    from workspace import RunWorkspace

    seen: dict[str, set[int]] = {"scan": set(), "snapshot": set()}
    scan, snapshot = RunWorkspace.scan, RunWorkspace.snapshot

    def spy_scan(self):
        seen["scan"].add(threading.get_ident())
        return scan(self)

    def spy_snapshot(self, iteration, paths):
        seen["snapshot"].add(threading.get_ident())
        return snapshot(self, iteration, paths)

    monkeypatch.setattr(RunWorkspace, "scan", spy_scan)
    monkeypatch.setattr(RunWorkspace, "snapshot", spy_snapshot)

    async def scenario():
        loop_thread = threading.get_ident()
        agent, _ = make_agent(tmp_path, [code("open('/workspace/output/a.txt','w').write('A')\nprint(1)"), DONE])
        resp = await agent.run(AgentRequest(message="t"))
        return loop_thread, resp

    loop_thread, resp = asyncio.run(scenario())
    assert resp.status == ExecutionStatus.SUCCESS
    assert seen["scan"] and seen["snapshot"]
    assert loop_thread not in seen["scan"] | seen["snapshot"]
