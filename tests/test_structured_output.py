"""
Anthropic requests ask for the same JSON schema OpenAI and Ollama already get (catalog option `structured_output`).
OFFLINE: a fake client records the request; nothing here shows how a real Anthropic model responds to it.
"""

import asyncio
import json
from types import SimpleNamespace

from agent_workbench.llm.providers import RESPONSE_SCHEMA, AnthropicChat
from agent_workbench.llm.catalog import ModelSpec, models_for
from agent_workbench.core.planner import LLMPlanner
from agent_workbench.domain.schemas import AgentState
from tests.test_logs import FakeStream

GOOD = json.dumps({"thinking": "Print it", "code": "print(1)", "language": "python"})


def request_for(spec: ModelSpec) -> dict:
    sent = {}

    def stream(**kwargs):
        sent.update(kwargs)
        return FakeStream(GOOD, None)

    client = SimpleNamespace(messages=SimpleNamespace(stream=stream))
    planner = LLMPlanner(spec, chat=AnthropicChat(spec, client))
    asyncio.run(planner.generate_code(AgentState(user_request="x")))
    return sent


def test_flagged_models_send_the_json_schema():
    sent = request_for(ModelSpec("anthropic", "m", "M", options={"structured_output": True}))
    assert sent["extra_body"] == {"output_config": {"format": {"type": "json_schema", "schema": RESPONSE_SCHEMA}}}
    assert "output_config" not in sent        # one path only: extra_body works with older SDKs too


def test_unflagged_models_send_no_output_config():
    assert "extra_body" not in request_for(ModelSpec("anthropic", "m", "M"))


def test_effort_and_format_share_one_output_config():
    sent = request_for(ModelSpec("anthropic", "m", "M", options={"effort": "low", "structured_output": True}))
    assert sent["extra_body"]["output_config"]["effort"] == "low"
    assert sent["extra_body"]["output_config"]["format"]["type"] == "json_schema"


def test_every_catalog_anthropic_model_is_flagged():
    assert all(m.options.get("structured_output") for m in models_for("anthropic"))


def test_schema_follows_the_strict_rules_both_providers_document():
    assert RESPONSE_SCHEMA["additionalProperties"] is False
    assert set(RESPONSE_SCHEMA["required"]) == set(RESPONSE_SCHEMA["properties"])

