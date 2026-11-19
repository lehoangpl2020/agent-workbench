"""
HTTP API: sync vs SSE, Stop, 409, artifacts, persistence qua restart.
Mock planner + LocalExecutor (subprocess thật) + SQLite thật trong tmp_path.
"""

import json
import os
import time

import pytest
from fastapi.testclient import TestClient

from executor import LocalExecutor
from server import create_app
from store import RunStore
from tests.conftest import DONE, ScriptedPlanner, code, fake_registry, wait_until


def make_app(data_dir, scripts, **kw):
    kw.setdefault("providers", fake_registry())
    return create_app(
        planner=ScriptedPlanner(scripts) if scripts is not None else None,
        executor=LocalExecutor(timeout=10, runs_dir=data_dir / "runs"),
        db_path=data_dir / "agent.db",
        runs_dir=data_dir / "runs",
        static_dir=data_dir / "no-static",
        **kw,
    )


def parse_sse(text: str) -> list[tuple[str, dict]]:
    events = []
    for block in text.strip().split("\n\n"):
        lines = [l for l in block.split("\n") if not l.startswith(":")]
        etype = next((l[7:] for l in lines if l.startswith("event: ")), None)
        data = "".join(l[6:] for l in lines if l.startswith("data: "))
        if etype:
            events.append((etype, json.loads(data)))
    return events


def wait_finished(client, run_id, timeout=15):
    return wait_until(
        lambda: (r := client.get(f"/api/runs/{run_id}").json())["status"] != "running" and r,
        timeout=timeout,
    )


SCRIPT = [code("import time\ntime.sleep(0.2)\nprint(2 + 2)"), DONE]


def test_sync_and_sse_have_same_business_result(data_dir):
    with TestClient(make_app(data_dir, SCRIPT)) as client:
        sync = client.post("/api/execute", json={"message": "calc"}).json()
        with client.stream("POST", "/api/execute/stream", json={"message": "calc"}) as resp:
            events = parse_sse(resp.read().decode())

    types = [e for e, _ in events]
    assert types[0] == "session" and types[-1] == "done"
    core = [t for t in types if t not in ("activity", "code_progress", "log")]
    assert core == ["session", "iteration", "code", "iteration", "result", "iteration", "model_done", "done"]
    # Quan sát realtime: hành động hiện tại + code stream trước khi có event "code"
    phases = [d["phase"] for e, d in events if e == "activity"]
    assert phases == ["write", "executing", "collecting", "checking", "review"]
    assert types.index("code_progress") < types.index("code")
    sse = events[-1][1]
    for key in ("status", "answer", "message", "iterations"):
        assert sync[key] == sse[key], key
    assert sync["status"] == "success" and sync["answer"].strip() == "4"
    assert [b["code"] for b in sync["code_blocks"]] == [b["code"] for b in sse["code_blocks"]]
    assert [r["exit_code"] for r in sync["execution_results"]] == [r["exit_code"] for r in sse["execution_results"]]


def test_run_api_persists_iterations(data_dir):
    with TestClient(make_app(data_dir, SCRIPT)) as client:
        run = client.post("/api/runs", json={"message": "calc", "max_iterations": 3, "timeout_seconds": 5})
        assert run.status_code == 201
        detail = wait_finished(client, run.json()["id"])
    assert detail["status"] == "success"
    assert detail["max_iterations"] == 3 and detail["timeout_seconds"] == 5
    assert [i["status"] for i in detail["iterations"]] == ["succeeded", "done"]
    assert detail["iterations"][0]["stdout"].strip() == "4"
    assert detail["iterations"][0]["exit_code"] == 0


def test_stop_kills_code_and_server_stays_responsive(data_dir):
    long_code = code(
        "import time, pathlib\ntime.sleep(4)\npathlib.Path('after.txt').write_text('x')\nprint('done')"
    )
    with TestClient(make_app(data_dir, [long_code])) as client:
        run_id = client.post("/api/runs", json={"message": "slow"}).json()["id"]
        wait_until(lambda: client.get(f"/api/runs/{run_id}").json()["iterations"][-1:]
                   and client.get(f"/api/runs/{run_id}").json()["iterations"][-1]["status"] == "executing")

        # Event loop không bị chặn: health trả về ngay khi code đang chạy
        t0 = time.monotonic()
        health = client.get("/health").json()
        assert time.monotonic() - t0 < 1.0
        assert health["active_run_id"] == run_id

        # Chỉ 1 run tại một thời điểm
        busy = client.post("/api/runs", json={"message": "another"})
        assert busy.status_code == 409
        assert busy.json()["detail"]["active_run_id"] == run_id

        stopped = client.post(f"/api/runs/{run_id}/stop")
        assert stopped.status_code == 200
        detail = stopped.json()
        assert detail["status"] == "stopped"
        assert detail["iterations"][-1]["status"] == "stopped"
        assert client.get("/health").json()["active_run_id"] is None

        time.sleep(4.5)
        assert not list((data_dir / "runs").glob(f"{run_id}/output/after.txt")), "code kept running"
        # Stop lần nữa → 409 (run không còn chạy)
        assert client.post(f"/api/runs/{run_id}/stop").status_code == 409


def test_timeout_status_via_api(data_dir):
    with TestClient(make_app(data_dir, [code("import time\ntime.sleep(30)")])) as client:
        run_id = client.post("/api/runs", json={"message": "loop", "max_iterations": 1,
                                                "timeout_seconds": 1}).json()["id"]
        detail = wait_finished(client, run_id, timeout=15)
    assert detail["status"] == "timeout"
    assert detail["iterations"][0]["status"] == "timed_out"
    assert detail["iterations"][0]["timed_out"] is True


def test_validation_limits(data_dir):
    with TestClient(make_app(data_dir, SCRIPT)) as client:
        assert client.post("/api/runs", json={"message": "x", "max_iterations": 0}).status_code == 422
        assert client.post("/api/runs", json={"message": "x", "timeout_seconds": 9999}).status_code == 422
        assert client.post("/api/runs", json={"message": ""}).status_code == 422


WRITE_A = code(
    "open('/workspace/output/a.txt','w').write('A')\n"
    "open('/workspace/output/chart.png','wb').write(b'\\x89PNG fake')\nprint('ok')"
)
WRITE_B = code("open('/workspace/output/b.txt','w').write('B')\nprint('ok')")


def test_artifacts_are_isolated_per_run(data_dir):
    scripts = {"A": [WRITE_A, DONE], "B": [WRITE_B, DONE]}
    with TestClient(make_app(data_dir, scripts)) as client:
        a = client.post("/api/execute", json={"message": "A"}).json()["session_id"]
        b = client.post("/api/execute", json={"message": "B"}).json()["session_id"]

        arts_a = client.get(f"/api/runs/{a}/artifacts").json()["artifacts"]
        arts_b = client.get(f"/api/runs/{b}/artifacts").json()["artifacts"]
        assert sorted(x["path"] for x in arts_a) == ["a.txt", "chart.png"]
        assert [x["path"] for x in arts_b] == ["b.txt"]
        png = next(x for x in arts_a if x["path"] == "chart.png")
        assert png["mime"] == "image/png" and png["iteration"] == 1

        assert client.get(f"/api/runs/{a}/artifacts/a.txt").text == "A"
        dl = client.get(f"/api/runs/{a}/artifacts/a.txt?download=1")
        assert "attachment" in dl.headers["content-disposition"]
        # File của run khác / ngoài phạm vi → 404
        assert client.get(f"/api/runs/{a}/artifacts/b.txt").status_code == 404
        assert client.get(f"/api/runs/{a}/artifacts/..%2F{b}%2Foutput%2Fb.txt").status_code == 404
        assert client.get(f"/api/runs/{a}/artifacts/%2E%2E/%2E%2E/agent.db").status_code == 404
        assert client.get(f"/api/runs/{a}/artifacts/..%5C..%5Cagent.db").status_code == 404
        assert client.get(f"/api/runs/{a}/artifacts/{(data_dir / 'agent.db').as_posix()}").status_code == 404
        assert client.get("/api/runs/not-a-uuid/artifacts/a.txt").status_code == 404


def test_iteration_snapshot_shows_that_iterations_version(data_dir):
    steps = [
        code("open('/workspace/output/out.txt','w').write('v1')\nprint(1)"),
        code("open('/workspace/output/out.txt','w').write('v2')\nprint(2)"),
        DONE,
    ]
    with TestClient(make_app(data_dir, steps)) as client:
        run_id = client.post("/api/execute", json={"message": "x"}).json()["session_id"]
        detail = client.get(f"/api/runs/{run_id}").json()
        it1, it2 = detail["iterations"][0], detail["iterations"][1]
        assert client.get(it1["artifacts"][0]["url"]).text == "v1"
        assert client.get(it2["artifacts"][0]["url"]).text == "v2"
        assert client.get(f"/api/runs/{run_id}/artifacts/out.txt").text == "v2"


def test_symlink_pointing_outside_is_blocked(data_dir):
    with TestClient(make_app(data_dir, [WRITE_B, DONE])) as client:
        run_id = client.post("/api/execute", json={"message": "x"}).json()["session_id"]
        link = data_dir / "runs" / run_id / "output" / "secret.txt"
        try:
            os.symlink(data_dir / "agent.db", link)
        except (OSError, NotImplementedError):
            pytest.skip("cannot create symlinks on this OS/user")
        assert client.get(f"/api/runs/{run_id}/artifacts/secret.txt").status_code == 404
        names = [a["path"] for a in client.get(f"/api/runs/{run_id}/artifacts").json()["artifacts"]]
        assert "secret.txt" not in names


def test_history_survives_restart(data_dir):
    with TestClient(make_app(data_dir, [WRITE_A, DONE])) as client:
        run_id = client.post("/api/execute", json={"message": "persist me"}).json()["session_id"]

    # Giả lập 1 run đang chạy dở khi server bị tắt đột ngột
    store = RunStore(data_dir / "agent.db")
    store.create_run("11111111-1111-1111-1111-111111111111", "crashed", 3, 30, "m", "local")
    store.close()

    with TestClient(make_app(data_dir, [DONE])) as client:  # app mới = server restart
        runs = client.get("/api/runs").json()["runs"]
        assert run_id in [r["id"] for r in runs]
        detail = client.get(f"/api/runs/{run_id}").json()
        assert detail["prompt"] == "persist me" and detail["status"] == "success"
        assert len(detail["iterations"]) == 2
        assert client.get(f"/api/runs/{run_id}/artifacts/a.txt").text == "A"

        crashed = client.get("/api/runs/11111111-1111-1111-1111-111111111111").json()
        assert crashed["status"] == "error" and "restarted" in crashed["message"]

        # SSE của run đã xong → trả done ngay
        with client.stream("GET", f"/api/runs/{run_id}/events") as resp:
            events = parse_sse(resp.read().decode())
        assert events == [("done", {"session_id": run_id, "status": "success",
                                    "answer": detail["answer"], "message": detail["message"],
                                    "iterations": 2})]


def test_live_events_endpoint(data_dir):
    steps = [code("import time\ntime.sleep(1)\nprint('hi')"), DONE]
    with TestClient(make_app(data_dir, steps)) as client:
        run_id = client.post("/api/runs", json={"message": "x"}).json()["id"]
        with client.stream("GET", f"/api/runs/{run_id}/events") as resp:
            events = parse_sse(resp.read().decode())
    types = [e for e, _ in events]
    assert types[0] == "status" and types[-1] == "done"
    assert "result" in types and events[-1][1]["status"] == "success"


def test_fix_intent_shows_error_being_fixed(data_dir):
    steps = [code("x = 1\nprint(y)"), code("print('fixed')"), DONE]
    with TestClient(make_app(data_dir, steps)) as client:
        run_id = client.post("/api/execute", json={"message": "fix me"}).json()["session_id"]
        detail = client.get(f"/api/runs/{run_id}").json()
    intents = [(i["intent"], i["intent_detail"]) for i in detail["iterations"]]
    assert intents[0] == ("write", "")
    assert intents[1][0] == "fix" and "NameError: name 'y' is not defined" in intents[1][1]
    assert intents[2] == ("review", "")
    # Run xong → không còn "current action"
    assert detail["activity"] == "" and detail["activity_phase"] == "finished"


def test_activity_visible_while_running(data_dir):
    steps = [code("import time\ntime.sleep(2)\nprint('ok')"), DONE]
    with TestClient(make_app(data_dir, steps)) as client:
        run_id = client.post("/api/runs", json={"message": "slow"}).json()["id"]
        detail = wait_until(lambda: (r := client.get(f"/api/runs/{run_id}").json())["activity_phase"] == "executing" and r)
        assert detail["activity_iteration"] == 1
        assert "iter_01.py" in detail["activity"]
        # Code đã có trong DB ngay khi bắt đầu chạy
        assert "time.sleep(2)" in detail["iterations"][0]["code"]
        wait_finished(client, run_id)


def test_old_database_is_migrated(data_dir):
    import sqlite3
    conn = sqlite3.connect(data_dir / "agent.db")
    conn.executescript(
        "CREATE TABLE runs (id TEXT PRIMARY KEY, prompt TEXT NOT NULL, status TEXT NOT NULL, "
        "max_iterations INTEGER NOT NULL, timeout_seconds INTEGER NOT NULL, model TEXT DEFAULT '', "
        "executor TEXT DEFAULT '', answer TEXT DEFAULT '', message TEXT DEFAULT '', "
        "iteration_count INTEGER DEFAULT 0, created_at TEXT NOT NULL, finished_at TEXT);"
        "INSERT INTO runs (id, prompt, status, max_iterations, timeout_seconds, created_at) "
        "VALUES ('22222222-2222-2222-2222-222222222222', 'old', 'success', 5, 30, '2026-01-01T00:00:00');"
    )
    conn.commit()
    conn.close()
    with TestClient(make_app(data_dir, SCRIPT)) as client:
        old = client.get("/api/runs/22222222-2222-2222-2222-222222222222").json()
        assert old["prompt"] == "old" and "activity" in old
        assert client.post("/api/execute", json={"message": "new"}).json()["status"] == "success"


# ─── Chỉ cho máy mình gọi API (server chạy code, không có auth) ─────────
def test_cors_rejects_unknown_origin(data_dir):
    preflight = {"Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type"}
    with TestClient(make_app(data_dir, SCRIPT)) as client:
        evil = client.options("/api/runs", headers={"Origin": "http://evil.example", **preflight})
        assert "access-control-allow-origin" not in evil.headers
        simple = client.get("/api/config", headers={"Origin": "http://evil.example"})
        assert "access-control-allow-origin" not in simple.headers

        dev = client.options("/api/runs", headers={"Origin": "http://localhost:5173", **preflight})
        assert dev.headers.get("access-control-allow-origin") == "http://localhost:5173"


def test_server_defaults_to_localhost_only():
    import server
    assert server.HOST == "127.0.0.1" or os.getenv("HOST"), "HOST must default to 127.0.0.1"
    assert "*" not in server.CORS_ORIGINS


def test_config_reports_local_executor_as_not_sandboxed(data_dir):
    with TestClient(make_app(data_dir, SCRIPT)) as client:
        assert client.get("/api/config").json()["sandboxed"] is False
