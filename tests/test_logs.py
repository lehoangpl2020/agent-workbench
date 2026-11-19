"""
Activity log: real entries from the backend, stored in SQLite, available while a run is in progress,
filterable by iteration, downloadable, never leaking secrets. The real planner is tested with a fake client.
"""

import asyncio
import json
import time
from types import SimpleNamespace

from fastapi.testclient import TestClient

from llm_providers import AnthropicChat
from model_catalog import ModelSpec
from planner import LLMPlanner
from schemas import AgentState
from tests.conftest import DONE, ScriptedPlanner, code, wait_until
from tests.test_api import make_app, wait_finished

FIX_SCRIPT = [
    code("print(undefined_name)", "Print a value"),
    code("open('/workspace/output/out.txt','w').write('hello')\nprint('ok')", "Write a file"),
    DONE,
]


def messages(logs):
    return [e["message"] for e in logs]


def test_full_run_is_logged_in_order(data_dir):
    with TestClient(make_app(data_dir, FIX_SCRIPT)) as client:
        run_id = client.post("/api/execute", json={"message": "x"}).json()["session_id"]
        logs = client.get(f"/api/runs/{run_id}/logs").json()["logs"]

    msgs = messages(logs)
    assert msgs[0] == "Run started"
    assert logs[0]["data"]["max_iterations"] == 5 and "executor" in logs[0]["data"]
    assert msgs[-1].startswith("Run finished: success")
    # every entry has all fields, ids increase
    assert all({"id", "ts", "iteration", "source", "level", "message", "data"} <= e.keys() for e in logs)
    assert [e["id"] for e in logs] == sorted(e["id"] for e in logs)
    # the MODEL's explanation is separate from runtime/sandbox actions
    model_msgs = [e["message"] for e in logs if e["source"] == "model"]
    assert "Print a value" in model_msgs and "Write a file" in model_msgs
    assert any(m.startswith("Model replied DONE") for m in model_msgs)

    joined = "\n".join(msgs)
    for expected in [
        "Iteration 1 started (code run 1/5)",
        "Wrote code to code/iter_01.py",
        "Starting execution",
        "Execution finished: exit code 1",
        "Sending the error back to the model to fix: NameError",
        "Collected 1 new/changed file(s): out.txt (5 B)",
        "Sending the execution output back to the model",
    ]:
        assert expected in joined, expected
    failed = next(e for e in logs if e["message"].startswith("Execution finished: exit code 1"))
    assert failed["level"] == "WARN" and failed["iteration"] == 1 and failed["source"] == "sandbox"

    # Replay uses these ordered, compact milestones without parsing log prose.
    steps = [e for e in logs if "flow" in e["data"]]
    assert [e["data"]["flow"] for e in steps] == [
        "started", "write", "code", "executing", "checking", "result",
        "fix", "code", "executing", "artifacts", "checking", "result",
        "review", "done_reply", "finished",
    ]
    results = [e["data"] for e in steps if e["data"]["flow"] == "result"]
    assert "NameError" in results[0]["error"] and "error" not in results[1]
    assert all("code" not in e["data"] for e in steps)


def test_logs_arrive_while_running_and_filter_by_iteration(data_dir):
    steps = [code("import time\ntime.sleep(2)\nprint('a')"), code("print('b')"), DONE]
    with TestClient(make_app(data_dir, steps)) as client:
        run_id = client.post("/api/runs", json={"message": "slow"}).json()["id"]
        # The "Starting execution" log must exist WHILE the code is still running
        live = wait_until(lambda: (l := client.get(f"/api/runs/{run_id}/logs").json()["logs"])
                          and any(m.startswith("Starting execution") for m in messages(l)) and l)
        assert client.get(f"/api/runs/{run_id}").json()["status"] == "running"
        assert not any(m.startswith("Run finished") for m in messages(live))
        # after=<id> returns only the new part
        last_id = live[-1]["id"]
        wait_finished(client, run_id)
        newer = client.get(f"/api/runs/{run_id}/logs?after={last_id}").json()["logs"]
        assert newer and all(e["id"] > last_id for e in newer)

        it2 = client.get(f"/api/runs/{run_id}/logs?iteration=2").json()["logs"]
        assert it2 and all(e["iteration"] == 2 for e in it2)

        dl = client.get(f"/api/runs/{run_id}/logs/download")
        assert "attachment" in dl.headers["content-disposition"]
        assert "Run started" in dl.text and "INFO" in dl.text


def test_live_log_events_on_sse(data_dir):
    with TestClient(make_app(data_dir, [code("print(1)"), DONE])) as client:
        with client.stream("POST", "/api/execute/stream", json={"message": "x"}) as resp:
            body = resp.read().decode()
    log_events = [json.loads(block.split("data: ", 1)[1]) for block in body.split("\n\n")
                  if block.startswith("event: log")]
    assert log_events and all("id" in e and "level" in e for e in log_events)


def test_stop_is_logged(data_dir):
    with TestClient(make_app(data_dir, [code("import time\ntime.sleep(10)")])) as client:
        run_id = client.post("/api/runs", json={"message": "x"}).json()["id"]
        wait_until(lambda: any(m.startswith("Starting execution")
                               for m in messages(client.get(f"/api/runs/{run_id}/logs").json()["logs"])))
        client.post(f"/api/runs/{run_id}/stop")
        msgs = messages(client.get(f"/api/runs/{run_id}/logs").json()["logs"])
    joined = "\n".join(msgs)
    for expected in ["Stop requested by user", "Execution cancelled", "Process killed", "Run finished: stopped"]:
        assert expected in joined, expected


def test_secrets_are_redacted(data_dir, monkeypatch):
    secret = "sk-ant-api03-SUPERSECRETVALUE1234567890"
    monkeypatch.setenv("MY_SERVICE_TOKEN", "tok_live_ABCDEFGH12345")
    steps = [RuntimeError(f"auth failed for key {secret} and tok_live_ABCDEFGH12345")]
    with TestClient(make_app(data_dir, steps)) as client:
        run_id = client.post("/api/execute", json={"message": "x"}).json()["session_id"]
        raw = client.get(f"/api/runs/{run_id}/logs").text
        dl = client.get(f"/api/runs/{run_id}/logs/download").text
    assert "Planner failed" in raw
    for text in (raw, dl):
        assert secret not in text and "SUPERSECRET" not in text and "tok_live_ABCDEFGH12345" not in text


# ── Real planner + fake Anthropic client (no API calls) ──────────
class FakeStream:
    def __init__(self, text, usage):
        self.text, self.usage = text, usage

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    @property
    async def text_stream(self):
        for i in range(0, len(self.text), 7):
            await asyncio.sleep(0)
            yield self.text[i:i + 7]

    async def get_final_message(self):
        return SimpleNamespace(content=[SimpleNamespace(type="text", text=self.text)],
                               stop_reason="end_turn", usage=self.usage)


def fake_planner(text, usage):
    spec = ModelSpec("anthropic", "fake-model", "Fake")
    client = SimpleNamespace(messages=SimpleNamespace(stream=lambda **kw: FakeStream(text, usage)))
    return LLMPlanner(spec, chat=AnthropicChat(spec, client))


def run_planner(planner):
    logs = []

    async def on_log(level, source, message, **data):
        logs.append((level, source, message, data))

    asyncio.run(planner.generate_code(AgentState(user_request="x"), on_log=on_log))
    return logs


GOOD = json.dumps({"thinking": "Print it", "code": "print(1)", "language": "python"})


def test_llm_call_logs_with_tokens_when_provided():
    usage = SimpleNamespace(input_tokens=120, output_tokens=45, cache_read_input_tokens=0)
    logs = run_planner(fake_planner(GOOD, usage))
    msgs = [m for _, _, m, _ in logs]
    assert msgs[0] == "Calling fake-model" and msgs[1].startswith("First token after")
    received = next(d for _, _, m, d in logs if m.startswith("Response received in"))
    assert received["input_tokens"] == 120 and received["output_tokens"] == 45
    assert "cache_read_input_tokens" not in received  # 0 → not shown
    assert msgs[-1].startswith("Parsed response: python code, 1 lines")
    assert all(src == "llm" for _, src, _, _ in logs)


def test_llm_logs_have_no_tokens_when_provider_omits_usage():
    logs = run_planner(fake_planner(GOOD, None))
    received = next(d for _, _, m, d in logs if m.startswith("Response received in"))
    assert not any("tokens" in k for k in received)


def test_parse_error_is_logged_then_retried():
    texts = iter(["not json at all", GOOD])
    planner = fake_planner(GOOD, None)
    planner.chat.client = SimpleNamespace(messages=SimpleNamespace(
        stream=lambda **kw: FakeStream(next(texts), None)))
    logs = run_planner(planner)
    warn = [m for lvl, _, m, _ in logs if lvl == "WARN"]
    assert warn and warn[0].startswith("Could not parse response")
    assert any(m == "Calling fake-model (format retry)" for _, _, m, _ in logs)
