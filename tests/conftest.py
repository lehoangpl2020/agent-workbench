"""
Test helpers. These are OFFLINE/MOCK checks: the planner is a ScriptedPlanner (no calls to the
Claude API), but the code still runs FOR REAL through LocalExecutor (subprocess).
"""

import asyncio
import time
from pathlib import Path

import pytest

from agent_workbench.domain.schemas import AgentState, CodeBlock

DONE = CodeBlock(code="", explanation="DONE")


def code(src: str, why: str = "test step") -> CodeBlock:
    return CodeBlock(code=src, explanation=why)


class Hang:
    """A planner step that hangs for a long time (simulates a slow model call) — used to test Stop while planning."""


class ScriptedPlanner:
    """
    Fake planner: returns the predefined steps in order for each run.
    scripts: a list of steps (used for every prompt) or a dict {prompt: list of steps}.
    A step can be a CodeBlock, an Exception (raised), or Hang().
    """

    configured = True

    def __init__(self, scripts):
        self.scripts = scripts
        self.calls: dict[str, int] = {}
        self.seen_states: list[AgentState] = []

    async def generate_code(self, state: AgentState, on_progress=None, on_log=None) -> CodeBlock:
        self.seen_states.append(state.model_copy(deep=True))
        steps = self.scripts[state.user_request] if isinstance(self.scripts, dict) else self.scripts
        i = self.calls.get(state.session_id, 0)
        self.calls[state.session_id] = i + 1
        step = steps[min(i, len(steps) - 1)]
        if isinstance(step, Hang):
            await asyncio.sleep(60)
        if isinstance(step, Exception):
            raise step
        # Simulate streaming: send the first half of the code before returning the full result
        if on_progress and step.code:
            await on_progress(step.code[: max(1, len(step.code) // 2)], step.explanation)
        await asyncio.sleep(0)  # yield to the event loop like a real API call
        return step


def ollama_transport(pulled=("qwen3.5:4b",), calls: list | None = None):
    """httpx.MockTransport that fakes Ollama: /api/tags returns the pulled models. Records every path that was called."""
    import httpx

    def handler(request: httpx.Request) -> httpx.Response:
        if calls is not None:
            calls.append(request.url.path)
        if request.url.path == "/api/tags":
            return httpx.Response(200, json={"models": [{"name": n, "model": n} for n in pulled]})
        return httpx.Response(404, json={"error": "unexpected call in test"})

    return httpx.MockTransport(handler)


def fake_registry(anthropic=True, openai=True, pulled=("qwen3.5:4b",), calls=None, transport=None):
    """ProviderRegistry with fake keys (never calls a real API) + a fake Ollama."""
    from agent_workbench.llm import ProviderRegistry, ProviderSettings

    settings = ProviderSettings(
        anthropic_api_key="test-anthropic-key" if anthropic else None,
        openai_api_key="test-openai-key" if openai else None,
        ollama_base_url="http://ollama.test:11434",
    )
    return ProviderRegistry(settings, transport=transport or ollama_transport(pulled, calls))


def wait_until(predicate, timeout: float = 10, interval: float = 0.05):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(interval)
    raise AssertionError("condition not met in time")


@pytest.fixture
def data_dir(tmp_path) -> Path:
    return tmp_path
