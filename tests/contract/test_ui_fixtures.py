"""
Recorded runs for the web UI's unit tests (web/src/lib/studio.test.ts).

A scripted run (real planner, fake model client, real local executor) is produced through the API, stabilized (fixed run id, evenly spaced timestamps, no machine
paths) and compared with web/src/lib/__fixtures__/. So the fixtures are always what the backend emits today:
when a log message, a `flow` tag or a response field changes, this test fails until the fixtures are regenerated

    UPDATE_SNAPSHOTS=1 pytest tests/contract/test_ui_fixtures.py

and then `cd web && npm test` shows what the UI does with the new shape.
"""

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from tests.conftest import make_app, wait_finished
from tests.integration.test_providers import DONE_TEXT, RecordingRegistry, step
from tests.contract.test_characterization import UPDATE, norm

FIXTURES = Path(__file__).resolve().parents[2] / "web" / "src" / "lib" / "__fixtures__"
RUN_ID = "00000000-0000-4000-8000-000000000001"
BASE = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
TIME_KEYS = {"time_ms", "execution_time_ms", "elapsed_ms",
              # P1.1 (metrics.py): measured in the log of each model call and in the run summary
              "duration_ms", "first_token_ms", "first_token_ms_avg", "first_token_ms_max", "llm_ms", "sandbox_ms", "wall_ms"}

RUNS = {
    # An error, a fix that writes a file, then DONE: every beat of the normal flow.
    "fix_then_done": ({"message": "demo", "max_iterations": 4},
                      [step("print(undefined_name)", "Print a value"),
                       step("open('/workspace/output/out.txt','w').write('hello')\nprint('ok')", "Write a file"),
                       DONE_TEXT]),
    # The code-run limit is reached and the final review asks for more: ends as max_retries.
    "final_review_rejected": ({"message": "demo", "max_iterations": 1},
                              [step("print('step 1')", "One"), step("print('step 2')", "Two")]),
}


def stabilize(run: dict, logs: list[dict]) -> dict:
    def at(i: int) -> str:
        return (BASE + timedelta(milliseconds=150 * i)).isoformat(timespec="milliseconds")

    def clean(value, key=None):
        if key in TIME_KEYS and isinstance(value, (int, float)):
            return 100
        if isinstance(value, str):
            return value if key in {"id", "run_id", "url", "download_url"} else norm(value)
        if isinstance(value, dict):
            return {k: clean(v, k) for k, v in value.items()}
        if isinstance(value, list):
            return [clean(v) for v in value]
        return value

    text = json.dumps({"run": run, "logs": logs}).replace(run["id"], RUN_ID)
    data = json.loads(text)
    run, logs = data["run"], data["logs"]
    for i, entry in enumerate(logs):
        entry["ts"] = at(i)
    first = {}
    last = {}
    for entry in logs:
        n = entry["iteration"]
        if n is not None:
            first.setdefault(n, entry["ts"])
            last[n] = entry["ts"]
    for it in run["iterations"]:
        it["started_at"] = first.get(it["number"], at(0))
        it["finished_at"] = last.get(it["number"]) if it["finished_at"] else None
    run["created_at"] = logs[0]["ts"]
    run["finished_at"] = logs[-1]["ts"] if run["finished_at"] else None
    run["activity_at"] = None
    return clean({"run": run, "logs": logs})


@pytest.mark.parametrize("name", list(RUNS))
def test_ui_fixture_matches_what_the_backend_emits(data_dir, name):
    body, texts = RUNS[name]
    # The real planner with a fake model client, so the recorded log includes the model-call entries too
    with TestClient(make_app(data_dir, None, providers=RecordingRegistry(texts))) as client:
        run_id = client.post("/api/runs", json=body).json()["id"]
        run = wait_finished(client, run_id)
        logs = client.get(f"/api/runs/{run_id}/logs").json()["logs"]
    actual = json.dumps(stabilize(run, logs), indent=2, ensure_ascii=False, sort_keys=True) + "\n"
    path = FIXTURES / f"{name}.json"
    if UPDATE or not path.exists():
        FIXTURES.mkdir(parents=True, exist_ok=True)
        path.write_text(actual, encoding="utf-8", newline="\n")
        if not UPDATE:
            pytest.fail(f"{path.name} did not exist and was created; review and commit it")
        return
    assert actual == path.read_text(encoding="utf-8"), (
        f"{path.name} differs from what the backend emits; regenerate with UPDATE_SNAPSHOTS=1 (see the docstring)")
