"""
The event contract (domain/events.py): what the agent emits matches the declared payloads, and the web UI's copy of
the names (web/src/lib/api.ts) matches the backend's. Offline: scripted planner, local executor.
"""

import asyncio
import re
from pathlib import Path

import pytest

from agent_workbench.core.agent import CodeAgent
from agent_workbench.domain.events import EVENTS, FLOWS, PAYLOADS, Event, Flow, artifact_label, artifact_size
from agent_workbench.execution import LocalExecutor
from agent_workbench.domain.schemas import AgentRequest
from tests.conftest import ScriptedPlanner
from tests.contract.test_characterization import SCENARIOS

API_TS = Path(__file__).resolve().parents[2] / "web" / "src" / "lib" / "api.ts"


def _ts_list(name: str) -> list[str]:
    source = API_TS.read_text(encoding="utf-8")
    match = re.search(r"export const %s = \[(.*?)\] as const" % name, source, re.S)
    assert match, f"{name} not found in api.ts"
    return re.findall(r'"([^"]+)"', match.group(1))


def test_web_ui_knows_exactly_the_backend_events():
    assert _ts_list("SSE_EVENTS") == list(EVENTS)


def test_web_ui_knows_exactly_the_backend_flows():
    assert _ts_list("FLOWS") == list(FLOWS)


def test_names_are_unique_and_complete():
    assert len(set(EVENTS)) == len(EVENTS)
    assert set(EVENTS) == {v for k, v in vars(Event).items() if k.isupper()}
    assert set(FLOWS) == {v for k, v in vars(Flow).items() if k.isupper()}
    assert set(PAYLOADS) == set(EVENTS)


def test_legacy_event_names_never_change():
    assert (Event.SESSION, Event.ITERATION, Event.CODE, Event.RESULT, Event.MODEL_DONE, Event.ERROR, Event.DONE) == (
        "session", "iteration", "code", "result", "model_done", "error", "done")


@pytest.mark.parametrize("name", list(SCENARIOS))
def test_emitted_payloads_match_the_declared_shape(tmp_path, name):
    steps, kw = SCENARIOS[name]
    agent = CodeAgent(planner=ScriptedPlanner(steps),
                      executor=LocalExecutor(timeout=kw.get("timeout", 10), runs_dir=tmp_path / "runs"),
                      max_iterations=kw.get("max_iterations", 5))
    events: list[tuple[str, dict]] = []

    async def emit(event, data):
        events.append((event, data))

    asyncio.run(agent.run(AgentRequest(message="task", timeout_seconds=kw.get("timeout", 10)), emit=emit))
    assert {e for e, _ in events} <= set(EVENTS)
    for event, data in events:
        shape = PAYLOADS[event]
        keys = set(data)
        assert shape.__required_keys__ <= keys, (event, shape.__required_keys__ - keys)
        assert keys <= shape.__required_keys__ | shape.__optional_keys__, (event, keys - set(shape.__annotations__))
        if event == Event.LOG:
            assert data.get("data", {}).get("flow") in (None, *FLOWS)


def test_artifact_label_roundtrip_and_legacy_text():
    assert artifact_label(1234) == "<file: 1234 bytes>"   # shown to the model and stored: do not change
    assert artifact_size(artifact_label(0)) == 0
    assert artifact_size(artifact_label(99)) == 99
    assert artifact_size("no digits here") == 0
