"""
The image tool (image_tool.py + POST /api/runs/{id}/tools/generate_image).
OpenAI is a httpx.MockTransport: no key is used and nothing paid is called.
"""

import asyncio
import base64
import json
import os
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from agent_workbench.config import Settings
from agent_workbench.execution.executors import LocalExecutor
from agent_workbench.tools.image import DEFAULT_MODEL, ImageRequest, ImageTool, ImageToolError, ImageToolSettings, tool_url
from agent_workbench.core.prompts import SYSTEM_PROMPT, system_prompt
from agent_workbench.api.app import build_image_tool, create_app
from tests.conftest import ScriptedPlanner, code, fake_registry, wait_until
from agent_workbench.storage.workspace import RunWorkspace

PNG = b"\x89PNG\r\n\x1a\n" + b"fake image bytes"
SLOW = code("import time\ntime.sleep(5)\nprint('x')")   # keeps the run active while the test calls the tool


def openai_transport(calls: list, *, status=200, body=None):
    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if status != 200:
            return httpx.Response(status, json=body or {"error": {"message": "nope"}})
        return httpx.Response(200, json={"data": [{"b64_json": base64.b64encode(PNG).decode()}]})
    return httpx.MockTransport(handler)


def make_tool(calls, *, max_per_run=2, **kw):
    cfg = ImageToolSettings(enabled=True, max_per_run=max_per_run)
    return ImageTool(cfg, "test-openai-key", "https://openai.test/v1", transport=openai_transport(calls, **kw))


def make_app(data_dir, tool):
    return create_app(
        planner=ScriptedPlanner([SLOW]),
        executor=LocalExecutor(timeout=10, runs_dir=data_dir / "runs"),
        db_path=data_dir / "agent.db", runs_dir=data_dir / "runs", static_dir=data_dir / "no-static",
        providers=fake_registry(), image_tool=tool,
    )


def start_run(client, image_tool: bool = True) -> str:
    run_id = client.post("/api/runs", json={"message": "draw", "image_tool": image_tool}).json()["id"]
    wait_until(lambda: client.get(f"/api/runs/{run_id}").json()["iterations"][-1:]
               and client.get(f"/api/runs/{run_id}").json()["iterations"][-1]["status"] == "executing")
    return run_id


def url(run_id: str) -> str:
    return f"/api/runs/{run_id}/tools/generate_image"


# ─── settings and prompt ──────────────────────────────
def test_settings_default_to_off_and_to_this_machine():
    s = Settings.from_env({}, base_dir=Path("/app")).image_tool
    assert s.enabled is False and s.model == DEFAULT_MODEL == "gpt-image-1-mini" and s.max_per_run == 4
    assert s.url == "http://127.0.0.1:8668"


def test_settings_overrides():
    s = Settings.from_env({"IMAGE_TOOL": "true", "IMAGE_MODEL": "m", "IMAGE_TOOL_URL": "http://agent-server:8000/",
                           "IMAGE_MAX_PER_RUN": "7", "PORT": "9000"}, base_dir=Path("/app")).image_tool
    assert (s.enabled, s.model, s.url, s.max_per_run) == (True, "m", "http://agent-server:8000", 7)
    assert Settings.from_env({"PORT": "9000"}, base_dir=Path("/app")).image_tool.url == "http://127.0.0.1:9000"


def test_prompt_is_unchanged_when_the_tool_is_off():
    assert system_prompt() == SYSTEM_PROMPT
    assert system_prompt(timeout_seconds=300) == SYSTEM_PROMPT


def test_prompt_describes_the_tool_with_the_run_limits():
    p = system_prompt(image_tool_max=3, timeout_seconds=45)
    assert p.startswith(SYSTEM_PROMPT)
    assert "IMAGE_TOOL_URL" in p and "at most 3 requests" in p and "timeout is 45s" in p
    assert "sk-" not in p and "OPENAI_API_KEY" not in p


def test_build_image_tool_explains_why_it_is_off(caplog):
    base = {"IMAGE_TOOL": "true", "OPENAI_API_KEY": "k"}
    cfg = lambda **env: Settings.from_env({**base, **env}, base_dir=Path("/app"))  # noqa: E731
    local = LocalExecutor()
    assert build_image_tool(cfg(IMAGE_TOOL="false"), local) is None
    assert build_image_tool(cfg(OPENAI_API_KEY=""), local) is None
    assert "OPENAI_API_KEY is not set" in caplog.text
    assert build_image_tool(cfg(), local) is not None


# ─── what the sandbox is given ────────────────────────
def test_the_code_gets_only_a_url_for_its_own_run(tmp_path):
    ex = LocalExecutor(runs_dir=tmp_path)
    ws = RunWorkspace(tmp_path, "11111111-1111-1111-1111-111111111111").create()
    assert ex.tool_env(ws) == {}
    ex.image_tool_url = "http://agent-server:8000"
    env = ex.tool_env(ws)
    assert env == {"IMAGE_TOOL_URL": tool_url("http://agent-server:8000", ws.run_id)}
    assert env["IMAGE_TOOL_URL"].endswith("/api/runs/11111111-1111-1111-1111-111111111111/tools/generate_image")


def test_the_api_key_never_reaches_the_code(data_dir, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-should-never-be-visible-1234567890")
    check = code("import os\nprint(sorted(k for k in os.environ if 'KEY' in k or 'TOKEN' in k), os.environ['IMAGE_TOOL_URL'])")
    app = create_app(
        planner=ScriptedPlanner([check]), executor=LocalExecutor(timeout=10, runs_dir=data_dir / "runs"),
        db_path=data_dir / "agent.db", runs_dir=data_dir / "runs", static_dir=data_dir / "no-static",
        providers=fake_registry(), image_tool=make_tool([]),
    )
    with TestClient(app) as client:
        done = client.post("/api/execute", json={"message": "env", "max_iterations": 1}).json()
    out = done["execution_results"][0]["stdout"]
    assert out.startswith("[]") and "sk-test" not in out
    assert f"/api/runs/{done['session_id']}/tools/generate_image" in out


# ─── the endpoint ─────────────────────────────────────
def test_generates_a_png_into_the_run_output_and_lists_it_as_an_artifact(data_dir):
    calls: list[httpx.Request] = []
    with TestClient(make_app(data_dir, make_tool(calls))) as client:
        run_id = start_run(client)
        r = client.post(url(run_id), json={"prompt": "a red fox, studio light", "size": "1536x1024",
                                           "quality": "low", "filename": "fox"})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["path"] == "/workspace/output/fox.png" and body["bytes"] == len(PNG)
        assert body["requests_left"] == 1

        saved = data_dir / "runs" / run_id / "output" / "fox.png"
        assert saved.read_bytes() == PNG
        assert not list(saved.parent.glob(".*.tmp")), "temporary file left behind"
        assert client.get(f"/api/runs/{run_id}/artifacts/fox.png").content == PNG

        logs = client.get(f"/api/runs/{run_id}/logs").json()["logs"]
        assert any("Image tool: saved fox.png" in e["message"] for e in logs)
        client.post(f"/api/runs/{run_id}/stop")

    sent = calls[0]
    assert sent.url == "https://openai.test/v1/images/generations"
    assert sent.headers["authorization"] == "Bearer test-openai-key"
    assert json.loads(sent.content) == {"model": DEFAULT_MODEL, "prompt": "a red fox, studio light",
                                        "size": "1536x1024", "quality": "low", "background": "auto",
                                        "output_format": "png", "n": 1}


def test_the_key_and_provider_internals_are_not_in_the_log(data_dir):
    with TestClient(make_app(data_dir, make_tool([], status=401))) as client:
        run_id = start_run(client)
        client.post(url(run_id), json={"prompt": "x"})
        text = json.dumps(client.get(f"/api/runs/{run_id}/logs").json())
        client.post(f"/api/runs/{run_id}/stop")
    assert "test-openai-key" not in text and "Image tool failed" in text


def test_only_the_active_run_may_use_the_tool(data_dir):
    with TestClient(make_app(data_dir, make_tool([]))) as client:
        other = "22222222-2222-2222-2222-222222222222"
        assert client.post(url(other), json={"prompt": "x"}).status_code == 409
        run_id = start_run(client)
        client.post(f"/api/runs/{run_id}/stop")
        # A finished run can no longer add files or spend money
        assert client.post(url(run_id), json={"prompt": "x"}).status_code == 409


def test_disabled_tool_answers_404_and_calls_nobody(data_dir):
    with TestClient(make_app(data_dir, None)) as client:
        run_id = start_run(client, image_tool=False)
        assert client.post(url(run_id), json={"prompt": "x"}).status_code == 404
        client.post(f"/api/runs/{run_id}/stop")


# ─── the per-run checkbox ─────────────────────────────
def test_a_run_that_did_not_tick_the_tool_cannot_use_it_even_when_the_server_offers_it(data_dir):
    calls: list = []
    with TestClient(make_app(data_dir, make_tool(calls))) as client:
        run_id = start_run(client, image_tool=False)
        r = client.post(url(run_id), json={"prompt": "x"})
        client.post(f"/api/runs/{run_id}/stop")
    assert r.status_code == 403 and "not enabled for this run" in r.json()["detail"]
    assert calls == [], "OpenAI must not be called for a run that did not opt in"


def test_asking_for_a_tool_the_server_cannot_offer_is_refused_with_the_reason(data_dir):
    with TestClient(make_app(data_dir, None)) as client:
        r = client.post("/api/runs", json={"message": "draw", "image_tool": True})
        assert r.status_code == 400
        assert r.json()["detail"]["code"] == "image_tool_unavailable"
        assert "IMAGE_TOOL=true" in r.json()["detail"]["message"]
        assert client.get("/api/runs").json()["runs"] == [], "no run may be created"
        # Not ticking it still works
        assert client.post("/api/runs", json={"message": "draw"}).status_code == 201


def test_config_tells_the_ui_whether_the_checkbox_can_be_used(data_dir):
    with TestClient(make_app(data_dir, None)) as client:
        off = client.get("/api/config").json()["image_tool"]
    assert off["available"] is False and "IMAGE_TOOL=true" in off["reason"]
    with TestClient(make_app(data_dir, make_tool([], max_per_run=3))) as client:
        on = client.get("/api/config").json()["image_tool"]
    assert on == {"available": True, "reason": None, "model": DEFAULT_MODEL, "max_per_run": 3}


def test_the_choice_is_stored_and_survives_a_restart(data_dir):
    with TestClient(make_app(data_dir, make_tool([]))) as client:
        ticked = start_run(client, image_tool=True)
        client.post(f"/api/runs/{ticked}/stop")
        plain = start_run(client, image_tool=False)
        client.post(f"/api/runs/{plain}/stop")
    with TestClient(make_app(data_dir, make_tool([]))) as client:   # a new server on the same database
        assert client.get(f"/api/runs/{ticked}").json()["image_tool"] is True
        assert client.get(f"/api/runs/{plain}").json()["image_tool"] is False
        listing = {r["id"]: r["image_tool"] for r in client.get("/api/runs").json()["runs"]}
    assert listing == {ticked: True, plain: False}


def test_runs_stored_before_the_column_existed_read_as_not_using_the_tool(data_dir):
    import sqlite3
    conn = sqlite3.connect(data_dir / "agent.db")
    conn.executescript(
        "CREATE TABLE runs (id TEXT PRIMARY KEY, prompt TEXT NOT NULL, status TEXT NOT NULL, "
        "max_iterations INTEGER NOT NULL, timeout_seconds INTEGER NOT NULL, model TEXT DEFAULT '', "
        "executor TEXT DEFAULT '', answer TEXT DEFAULT '', message TEXT DEFAULT '', "
        "iteration_count INTEGER DEFAULT 0, created_at TEXT NOT NULL, finished_at TEXT);"
        "INSERT INTO runs (id, prompt, status, max_iterations, timeout_seconds, created_at) "
        "VALUES ('44444444-4444-4444-4444-444444444444', 'old', 'success', 5, 30, '2026-01-01T00:00:00');"
    )
    conn.commit()
    conn.close()
    with TestClient(make_app(data_dir, None)) as client:
        assert client.get("/api/runs/44444444-4444-4444-4444-444444444444").json()["image_tool"] is False
        assert client.get("/api/runs").json()["runs"][0]["image_tool"] is False


def test_only_a_ticked_run_gets_the_tool_in_its_prompt():
    from agent_workbench.llm.providers import ChatResult
    from agent_workbench.llm.catalog import find
    from agent_workbench.core.planner import LLMPlanner
    from agent_workbench.domain.schemas import AgentState

    seen: list[str] = []

    class Chat:
        async def stream(self, system, messages, max_tokens, on_text):
            seen.append(system)
            return ChatResult('{"thinking": "DONE", "code": "", "language": "python"}', "end", "end_turn")

    planner = LLMPlanner(find("ollama", "qwen3.5:4b"), chat=Chat(), image_tool_max=3)
    for ticked in (False, True):
        asyncio.run(planner.generate_code(AgentState(user_request="x", image_tool=ticked, timeout_seconds=45)))
    assert seen[0] == SYSTEM_PROMPT
    assert seen[1].startswith(SYSTEM_PROMPT) and "at most 3 requests" in seen[1] and "timeout is 45s" in seen[1]


def test_requests_per_run_are_capped_even_when_they_fail(data_dir):
    calls: list = []
    with TestClient(make_app(data_dir, make_tool(calls, max_per_run=2, status=429))) as client:
        run_id = start_run(client)
        codes = [client.post(url(run_id), json={"prompt": "x"}).status_code for _ in range(3)]
        client.post(f"/api/runs/{run_id}/stop")
    assert codes == [400, 400, 429] and len(calls) == 2   # the third never reaches OpenAI


def test_a_provider_error_reaches_the_model_as_detail(data_dir):
    body = {"error": {"message": "Your request was rejected by the safety system."}}
    with TestClient(make_app(data_dir, make_tool([], status=400, body=body))) as client:
        run_id = start_run(client)
        r = client.post(url(run_id), json={"prompt": "x"})
        client.post(f"/api/runs/{run_id}/stop")
    assert r.status_code == 400 and "safety system" in r.json()["detail"]


@pytest.mark.parametrize("status", [400, 404])
def test_a_retired_or_unavailable_model_is_reported_as_a_server_setting(data_dir, status):
    # What OpenAI really answered for 'gpt-image-1' on a key that can no longer use it
    body = {"error": {"message": "The model `gpt-image-1` does not exist.", "code": "model_not_found"}}
    with TestClient(make_app(data_dir, make_tool([], status=status, body=body))) as client:
        run_id = start_run(client)
        r = client.post(url(run_id), json={"prompt": "x"})
        client.post(f"/api/runs/{run_id}/stop")
    detail = r.json()["detail"]
    assert r.status_code == 503
    assert "IMAGE_MODEL" in detail and "does not exist" in detail and "Change the prompt" not in detail


@pytest.mark.parametrize("payload", [
    {"prompt": ""},
    {"prompt": "x", "size": "4096x4096"},
    {"prompt": "x", "quality": "ultra"},
    {"prompt": "x", "filename": "../evil.png"},
    {"prompt": "x", "filename": "a/b.png"},
    {"prompt": "x", "filename": ".hidden"},
])
def test_bad_input_is_rejected_before_any_call(data_dir, payload):
    calls: list = []
    with TestClient(make_app(data_dir, make_tool(calls))) as client:
        run_id = start_run(client)
        assert client.post(url(run_id), json=payload).status_code == 422
        client.post(f"/api/runs/{run_id}/stop")
    assert calls == []


# ─── ImageTool on its own ─────────────────────────────
def workspace(tmp_path) -> RunWorkspace:
    return RunWorkspace(tmp_path, "33333333-3333-3333-3333-333333333333").create()


def pretend_symlink(monkeypatch, path: Path) -> None:
    """Where the OS refuses to create symlinks (Windows without the privilege), make the check see one."""
    real = Path.is_symlink
    monkeypatch.setattr(Path, "is_symlink", lambda self: self == path or real(self))


def test_a_symlink_planted_in_output_is_never_written_through(tmp_path, monkeypatch):
    ws = workspace(tmp_path)
    victim = tmp_path / "victim.txt"
    victim.write_text("keep me")
    try:
        os.symlink(victim, ws.output_dir / "link.png")
    except (OSError, NotImplementedError):
        (ws.output_dir / "link.png").write_text("stand-in for a link")
        pretend_symlink(monkeypatch, ws.output_dir / "link.png")
    tool = make_tool([])
    with pytest.raises(ImageToolError) as e:
        asyncio.run(tool.generate(ws, ImageRequest(prompt="x", filename="link.png"), still_active=lambda: True))
    assert e.value.status == 400 and victim.read_text() == "keep me"


def test_an_output_directory_that_points_elsewhere_is_refused(tmp_path, monkeypatch):
    ws = workspace(tmp_path)
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    ws.output_dir.rmdir()
    try:
        os.symlink(elsewhere, ws.output_dir, target_is_directory=True)
    except (OSError, NotImplementedError):
        ws.output_dir.mkdir()
        pretend_symlink(monkeypatch, ws.output_dir)
    with pytest.raises(ImageToolError):
        asyncio.run(make_tool([]).generate(ws, ImageRequest(prompt="x"), still_active=lambda: True))
    assert list(elsewhere.iterdir()) == []


def test_an_image_finished_after_stop_is_discarded(tmp_path):
    ws = workspace(tmp_path)
    with pytest.raises(ImageToolError) as e:
        asyncio.run(make_tool([]).generate(ws, ImageRequest(prompt="x"), still_active=lambda: False))
    assert e.value.status == 409 and list(ws.output_dir.iterdir()) == []


def test_default_filename_is_numbered_and_png_is_added(tmp_path):
    ws = workspace(tmp_path)
    tool = make_tool([], max_per_run=3)
    first = asyncio.run(tool.generate(ws, ImageRequest(prompt="x"), still_active=lambda: True))
    named = asyncio.run(tool.generate(ws, ImageRequest(prompt="x", filename="Cover.PNG"), still_active=lambda: True))
    assert first["filename"] == "image_01.png" and named["filename"] == "Cover.PNG"
