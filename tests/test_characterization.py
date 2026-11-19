"""
Characterization tests: pin what the agent sends to the model, the events and log entries it emits, what
is stored in SQLite and the shape of the API responses. They exist so that structural refactors can prove
they did not change behavior; they are not quality checks for any model.

Snapshots live in tests/snapshots/. After an INTENTIONAL behavior change, regenerate them with
    UPDATE_SNAPSHOTS=1 pytest tests/test_characterization.py
and review the diff: every changed line is a behavior change that belongs in its own commit.
"""

import asyncio
import json
import os
import re
import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from agent_workbench.core.agent import CodeAgent
from agent_workbench.execution import LocalExecutor
from agent_workbench.llm import ChatResult
from agent_workbench.llm.catalog import ModelSpec
from agent_workbench.core.planner import LLMPlanner
from agent_workbench.core.prompts import SYSTEM_PROMPT, build_messages
from agent_workbench.domain.schemas import AgentRequest, AgentState, CodeBlock, ExecutionResult
from tests.conftest import DONE, ScriptedPlanner, code
from tests.test_api import make_app, wait_finished

SNAPSHOTS = Path(__file__).parent / "snapshots"
UPDATE = os.getenv("UPDATE_SNAPSHOTS") == "1"


# ── Snapshot helpers ──────────────────────────────────────────────
_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
_WIN_PATH = re.compile(r"[A-Za-z]:[\\/][^\s\"',)]*")
_POSIX_PATH = re.compile(r"/[^\s\"',)]*/(?:runs|code|output)/[^\s\"',)]*")
_SECONDS = re.compile(r"\d+\.\d+s\b")
_TIME_KEYS = {"time_ms", "execution_time_ms", "elapsed_ms",
              # P1.1 (metrics.py): measured in the log of each model call and in the run summary
              "duration_ms", "first_token_ms", "first_token_ms_avg", "first_token_ms_max", "llm_ms", "sandbox_ms", "wall_ms"}


def norm(value, key=None):
    """Removes everything that differs between machines and runs: ids, paths, timings, Python-version tracebacks."""
    if key in _TIME_KEYS and isinstance(value, (int, float)):
        return "<n>"
    if isinstance(value, str):
        value = _UUID.sub("<uuid>", value)
        value = _WIN_PATH.sub("<path>", value)
        value = _POSIX_PATH.sub("<path>", value)
        value = _SECONDS.sub("<t>s", value)
        if "Traceback" in value:
            value = value.strip().splitlines()[-1]   # traceback layout differs between Python versions
        if "Last error:" in value:
            value = value.split("Last error:")[0] + "Last error: <error>"
        return value
    if isinstance(value, dict):
        return {k: norm(v, k) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [norm(v) for v in value]
    return value


def assert_snapshot(name: str, actual) -> None:
    path = SNAPSHOTS / f"{name}.json"
    text = json.dumps(actual, indent=2, ensure_ascii=False, sort_keys=True) + "\n"
    if UPDATE or not path.exists():
        SNAPSHOTS.mkdir(exist_ok=True)
        path.write_text(text, encoding="utf-8", newline="\n")
        if not UPDATE:
            pytest.fail(f"snapshot {path.name} did not exist and was created; review and commit it")
        return
    assert text == path.read_text(encoding="utf-8"), f"{path.name} differs; see the module docstring"


# ── 1. What the model is sent ─────────────────────────────────────
def _state(pairs, max_iterations=5, timeout=30) -> AgentState:
    state = AgentState(user_request="Task: compute something", max_iterations=max_iterations,
                       timeout_seconds=timeout)
    for block, result in pairs:
        state.generated_code.append(block)
        state.execution_results.append(result)
    return state


BLOCK = CodeBlock(code="print(1)", explanation="Print one")
FAILED = ExecutionResult(stdout="partial", stderr="Traceback...\nNameError: name 'y' is not defined", exit_code=1)
TIMED_OUT = ExecutionResult(stdout="so far", stderr="Execution timed out after 30s", exit_code=124, timed_out=True)
OK = ExecutionResult(stdout="42\n", exit_code=0, artifacts={"chart.png": "<file: 1234 bytes>"})
OK_NO_FILES = ExecutionResult(stdout="42\n", exit_code=0)


def prompt_cases() -> dict[str, AgentState]:
    return {
        "fresh": _state([]),
        "after_failure": _state([(BLOCK, FAILED)]),
        "after_timeout": _state([(BLOCK, TIMED_OUT)]),
        "after_success_with_files": _state([(BLOCK, OK)]),
        "after_success_last_run": _state([(BLOCK, OK_NO_FILES)], max_iterations=1),
        "fix_then_review": _state([(BLOCK, FAILED), (CodeBlock(code="print(2)", explanation="Fix"), OK)]),
    }


def test_context_sent_to_the_model_is_unchanged():
    actual = {"system_prompt": SYSTEM_PROMPT,
              "messages": {name: build_messages(s) for name, s in prompt_cases().items()}}
    assert_snapshot("prompt_messages", actual)


class RecordingChat:
    """ChatClient that records exactly what the planner sends and returns scripted texts."""

    def __init__(self, texts):
        self.texts, self.calls = list(texts), []

    async def stream(self, system, messages, max_tokens, on_text):
        self.calls.append({"system": system, "messages": messages, "max_tokens": max_tokens})
        text = self.texts.pop(0)
        await on_text(text)
        return ChatResult(text, "end", "stop", {})


def test_format_retry_request_is_unchanged():
    good = json.dumps({"thinking": "Print", "code": "print(1)", "language": "python"})
    chat = RecordingChat(["not json", good])
    spec = ModelSpec("ollama", "fake:1b", "Fake", max_output_tokens=1234)
    planner = LLMPlanner(spec, chat=chat)
    block = asyncio.run(planner.generate_code(_state([(BLOCK, FAILED)])))
    assert block.code == "print(1)"
    assert_snapshot("format_retry_calls", {"calls": chat.calls})


# ── 2. Events and log entries emitted by the loop ────────────────
def _run_scenario(tmp_path, steps, max_iterations=5, timeout=10):
    agent = CodeAgent(planner=ScriptedPlanner(steps), executor=LocalExecutor(timeout=timeout, runs_dir=tmp_path / "runs"),
                      max_iterations=max_iterations)
    events: list[tuple[str, dict]] = []

    async def emit(event, data):
        events.append((event, json.loads(json.dumps(data, default=str))))

    response = asyncio.run(agent.run(AgentRequest(message="task", timeout_seconds=timeout), emit=emit))
    trace = []
    for event, data in events:
        entry = {"event": event, "keys": sorted(data)}
        if event == "log":
            entry.update(level=data["level"], source=data["source"], iteration=data["iteration"],
                         message=norm(data["message"]), data=norm(data["data"]))
        else:
            entry["data"] = norm({k: v for k, v in data.items() if k != "session_id"})
        trace.append(entry)
    return {"status": response.status.value, "iterations": response.iterations, "events": trace}


SCENARIOS = {
    "success": ([code("print(2 + 2)", "Add"), DONE], {}),
    "fix_then_done": ([code("print(undefined_name)", "Print a value"),
                       code("open('/workspace/output/out.txt','w').write('hello')\nprint('ok')", "Write a file"),
                       DONE], {}),
    "final_review_rejected": ([code("print('step 1')", "One"), code("print('step 2')", "Two"),
                               code("print('step 3')", "Three")], {"max_iterations": 2}),
    "failed_at_limit": ([code("raise RuntimeError('still broken')", "Break")], {"max_iterations": 2}),
    "timeout": ([code("import time\ntime.sleep(30)", "Sleep")], {"max_iterations": 1, "timeout": 1}),
    "planner_error": ([RuntimeError("API down")], {}),
    "false_success": ([code("print('Error: file not found')", "Oops"), code("print('ok')", "Fine"), DONE], {}),
    "done_without_success": ([DONE], {}),
}


@pytest.mark.parametrize("name", list(SCENARIOS))
def test_loop_events_and_logs_are_unchanged(tmp_path, name):
    steps, kwargs = SCENARIOS[name]
    assert_snapshot(f"loop_{name}", _run_scenario(tmp_path, steps, **kwargs))


# ── 3. What is stored and what the API returns ───────────────────
def _dump_db(path: Path) -> dict:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    skip = {"created_at", "finished_at", "started_at", "ts", "activity_at", "id"}

    def rows(sql):
        out = []
        for r in conn.execute(sql):
            d = {k: norm(r[k], k) for k in r.keys() if k not in skip}
            for k in ("data", "artifacts"):
                if k in d and isinstance(d[k], str):
                    d[k] = json.loads(d[k])
            out.append(norm(d))
        return out

    dump = {"runs": rows("SELECT * FROM runs"), "iterations": rows("SELECT * FROM iterations ORDER BY number"),
            "run_logs": rows("SELECT * FROM run_logs ORDER BY id")}
    conn.close()
    return dump


def _shape(value):
    """Key structure of a JSON value (values are ignored)."""
    if isinstance(value, dict):
        return {k: _shape(v) for k, v in sorted(value.items())}
    if isinstance(value, list):
        return [_shape(value[0])] if value else []
    return type(value).__name__


def test_stored_history_and_api_shape_are_unchanged(data_dir):
    steps = [code("open('/workspace/output/a.txt','w').write('A')\nprint(undefined_name)", "Write then fail"),
             code("open('/workspace/output/a.txt','w').write('B')\nprint('ok')", "Fix"), DONE]
    with TestClient(make_app(data_dir, steps)) as client:
        run_id = client.post("/api/runs", json={"message": "persist me", "max_iterations": 4}).json()["id"]
        detail = wait_finished(client, run_id)
        logs = client.get(f"/api/runs/{run_id}/logs").json()
        listing = client.get("/api/runs").json()
        config = client.get("/api/config").json()
        health = client.get("/health").json()
    shapes = {"run_detail": _shape(detail), "logs": _shape(logs), "run_list": _shape(listing),
              "config": _shape(config), "health": _shape(health)}
    assert_snapshot("api_shapes", shapes)
    assert_snapshot("stored_history", _dump_db(data_dir / "agent.db"))
