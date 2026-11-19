"""A prompt close to Ollama's num_ctx is reported in the run log. OFFLINE: a fake chat returns the token counts."""

import asyncio
import json

from agent_workbench.llm.providers import ChatResult
from agent_workbench.llm.catalog import ModelSpec
from agent_workbench.core.planner import CONTEXT_WARN_RATIO, LLMPlanner
from agent_workbench.domain.schemas import AgentState

GOOD = json.dumps({"thinking": "Print", "code": "print(1)", "language": "python"})


class UsageChat:
    def __init__(self, usage):
        self.usage = usage

    async def stream(self, system, messages, max_tokens, on_text):
        await on_text(GOOD)
        return ChatResult(GOOD, "end", "stop", self.usage)


def warnings(spec, usage):
    logs = []

    async def on_log(level, source, message, **data):
        logs.append((level, message, data))

    asyncio.run(LLMPlanner(spec, chat=UsageChat(usage)).generate_code(AgentState(user_request="x"), on_log=on_log))
    return [(m, d) for level, m, d in logs if level == "WARN"]


OLLAMA = ModelSpec("ollama", "m:1b", "M", options={"num_ctx": 1000})


def test_a_nearly_full_context_window_is_reported():
    (message, data), = warnings(OLLAMA, {"input_tokens": 950, "output_tokens": 10})
    assert "950 of the 1,000-token context window" in message
    assert data == {"input_tokens": 950, "num_ctx": 1000}


def test_the_threshold_is_the_documented_ratio():
    assert warnings(OLLAMA, {"input_tokens": int(1000 * CONTEXT_WARN_RATIO)})
    assert not warnings(OLLAMA, {"input_tokens": int(1000 * CONTEXT_WARN_RATIO) - 1})


def test_no_warning_without_a_window_or_without_token_counts():
    assert not warnings(ModelSpec("anthropic", "m", "M"), {"input_tokens": 10**6})   # no num_ctx for this model
    assert not warnings(OLLAMA, {})                                                  # provider returned no usage
