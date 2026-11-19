"""
Test helpers. Đây là kiểm tra OFFLINE/MOCK: planner là ScriptedPlanner (không gọi
Claude API), nhưng code vẫn chạy THẬT bằng LocalExecutor (subprocess).
"""

import asyncio
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from schemas import AgentState, CodeBlock  # noqa: E402

DONE = CodeBlock(code="", explanation="DONE")


def code(src: str, why: str = "test step") -> CodeBlock:
    return CodeBlock(code=src, explanation=why)


class Hang:
    """Bước planner treo lâu (giả lập gọi model chậm) — để test Stop khi đang planning."""


class ScriptedPlanner:
    """
    Planner giả: trả lần lượt các bước đã định sẵn cho từng run.
    scripts: list bước (dùng cho mọi prompt) hoặc dict {prompt: list bước}.
    Một bước có thể là CodeBlock, Exception (raise), hoặc Hang().
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
        # Giả lập streaming: gửi nửa đầu của code trước khi trả kết quả đầy đủ
        if on_progress and step.code:
            await on_progress(step.code[: max(1, len(step.code) // 2)], step.explanation)
        await asyncio.sleep(0)  # nhường event loop như một lời gọi API thật
        return step


def ollama_transport(pulled=("qwen3.5:4b",), calls: list | None = None):
    """httpx.MockTransport giả Ollama: /api/tags trả các model đã pull. Ghi lại mọi path được gọi."""
    import httpx

    def handler(request: httpx.Request) -> httpx.Response:
        if calls is not None:
            calls.append(request.url.path)
        if request.url.path == "/api/tags":
            return httpx.Response(200, json={"models": [{"name": n, "model": n} for n in pulled]})
        return httpx.Response(404, json={"error": "unexpected call in test"})

    return httpx.MockTransport(handler)


def fake_registry(anthropic=True, openai=True, pulled=("qwen3.5:4b",), calls=None, transport=None):
    """ProviderRegistry với key giả (không bao giờ gọi API thật) + Ollama giả."""
    from llm_providers import ProviderRegistry, ProviderSettings

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
