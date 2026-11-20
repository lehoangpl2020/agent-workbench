"""
Reasoning (opt-in per run): catalog support, the Ollama adapter keeping thinking apart from the answer, the planner
streaming it, the API rejecting it for models that cannot show it, and the run storing it.

OFFLINE/MOCK: Ollama is an httpx.MockTransport or a fake ChatClient; no model is called.
"""

import asyncio
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from agent_workbench.core.planner import LLMPlanner
from agent_workbench.domain.events import Event, Flow
from agent_workbench.domain.schemas import AgentState
from agent_workbench.llm import ChatResult, OllamaChat, ProviderRegistry
from agent_workbench.llm import catalog
from agent_workbench.llm.catalog import CATALOG, InvalidModelSelection, ModelSpec, find, for_run
from tests.conftest import fake_registry, make_app, wait_finished

GOOD = json.dumps({"thinking": "Print it", "code": "print(55)", "language": "python"})
DONE = json.dumps({"thinking": "DONE", "code": "", "language": "python"})


# ─── Catalog ───────────────────────────────────────────────────────────
def test_every_model_supports_reasoning_and_says_what_it_streams():
    assert all(m.supports_reasoning for m in CATALOG)
    # Ollama streams the model's own reasoning text; Anthropic and OpenAI only a summary they write of it
    assert {m.provider: m.reasoning_kind for m in CATALOG} == {"ollama": "text", "anthropic": "summary", "openai": "summary"}
    # Catalog rows themselves never have reasoning on: a run has to ask for it
    assert not any(m.reasoning for m in CATALOG)
    assert all(m.options.get("think") is False for m in CATALOG if m.provider == "ollama")
    assert not any("thinking" in m.options or "reasoning_summary" in m.options for m in CATALOG)


def test_for_run_merges_reasoning_options_and_raises_the_output_cap():
    spec = find("ollama", "qwen3.5:4b")
    assert for_run(spec, False) is spec
    run_spec = for_run(spec, True)
    assert run_spec.reasoning and run_spec.options["think"] is True
    assert run_spec.options["num_ctx"] == spec.options["num_ctx"]
    assert run_spec.max_output_tokens == 16384 > spec.max_output_tokens
    assert find("ollama", "qwen3.5:4b").options["think"] is False, "the catalog row must not change"


def test_for_run_refuses_a_model_without_reasoning():
    with pytest.raises(InvalidModelSelection) as e:
        for_run(ModelSpec("anthropic", "m", "M"), True)
    assert e.value.code == "reasoning_unsupported"


def test_for_run_for_paid_providers_asks_for_their_summary():
    claude = for_run(find("anthropic", "claude-sonnet-4-6"), True)
    assert claude.options["thinking"] == {"type": "adaptive", "display": "summarized"}
    assert claude.max_output_tokens == 32000 and claude.options["structured_output"] is True
    gpt = for_run(find("openai", "gpt-6.1-terra"), True)
    assert gpt.options == {"reasoning_effort": "low", "reasoning_summary": "auto"}


# ─── Ollama adapter ────────────────────────────────────────────────────
def ndjson(*chunks) -> bytes:
    return "".join(json.dumps(c) + "\n" for c in chunks).encode()


def thinking_stream(request):
    return httpx.Response(200, content=ndjson(
        {"message": {"role": "assistant", "thinking": "The sum of 1..10 ", "content": ""}, "done": False},
        {"message": {"role": "assistant", "thinking": "is 55.", "content": ""}, "done": False},
        {"message": {"role": "assistant", "content": GOOD[:10]}, "done": False},
        {"message": {"role": "assistant", "content": GOOD[10:]}, "done": False},
        {"message": {"role": "assistant", "content": ""}, "done": True, "done_reason": "stop", "eval_count": 40}))


def run_stream(spec, handler, with_reasoning: bool):
    seen: dict = {}

    def record(request):
        seen["body"] = json.loads(request.content)
        return handler(request)

    chat = OllamaChat(spec, httpx.AsyncClient(transport=httpx.MockTransport(record)), "http://ollama.test:11434")
    text_chunks, thoughts = [], []

    async def on_text(t):
        text_chunks.append(t)

    async def on_reasoning(t):
        thoughts.append(t)

    async def go():
        kw = {"on_reasoning": on_reasoning} if with_reasoning else {}
        return await chat.stream("SYS", [{"role": "user", "content": "hi"}], 16384, on_text, **kw)

    return asyncio.run(go()), seen["body"], "".join(text_chunks), thoughts


def test_ollama_keeps_thinking_apart_from_the_answer():
    spec = for_run(find("ollama", "qwen3.5:4b"), True)
    result, body, text, thoughts = run_stream(spec, thinking_stream, with_reasoning=True)
    assert body["think"] is True and body["options"]["num_predict"] == 16384
    assert thoughts == ["The sum of 1..10 ", "is 55."]
    assert result.reasoning == "The sum of 1..10 is 55."
    # The answer that gets parsed is exactly the JSON, with no thinking mixed in
    assert result.text == text == GOOD


def test_ollama_without_the_callback_ignores_thinking_as_before():
    result, body, text, thoughts = run_stream(find("ollama", "qwen3.5:4b"), thinking_stream, with_reasoning=False)
    assert body["think"] is False
    assert result.reasoning == "" and result.text == GOOD and thoughts == []


# ─── Planner ───────────────────────────────────────────────────────────
class ThinkingChat:
    """Fake ChatClient that streams reasoning, then the answer. Records whether on_reasoning was passed."""

    def __init__(self, text=GOOD, thought=("Need ", "a sum. ", "Use range.")):
        self.text, self.thought, self.got_callback = text, thought, None
        self.on_answer = None   # called right before the first answer chunk (lets a test look at that moment)

    async def stream(self, system, messages, max_tokens, on_text, on_reasoning=None):
        self.got_callback = on_reasoning is not None
        if on_reasoning:
            for part in self.thought:
                await on_reasoning(part)
        await on_text(self.text[:5])
        if self.on_answer:
            self.on_answer()
        await on_text(self.text[5:])
        return ChatResult(self.text, "end", "stop", {}, reasoning="".join(self.thought) if on_reasoning else "")


def generate(spec, chat, with_progress=True, progress_ref=None):
    logs = []
    progress = progress_ref if progress_ref is not None else []

    async def on_log(level, source, message, **data):
        logs.append((source, message, data))

    async def on_reasoning(text, done):
        progress.append((text, done))

    planner = LLMPlanner(spec, chat=chat)
    state = AgentState(user_request="sum", reasoning=spec.reasoning)
    kw = {"on_reasoning": on_reasoning} if with_progress else {}
    block = asyncio.run(planner.generate_code(state, on_log=on_log, **kw))
    return block, logs, progress


def test_planner_streams_reasoning_and_ends_with_the_full_text():
    chat = ThinkingChat()
    progress_ref: list = []
    seen_at_answer: list = []   # the reasoning updates that had arrived when the answer started
    chat.on_answer = lambda: seen_at_answer.append(list(progress_ref))
    block, logs, progress = generate(for_run(find("ollama", "qwen3.5:4b"), True), chat, progress_ref=progress_ref)
    # The reasoning is reported complete as soon as the answer starts, not only when the reply ends
    assert seen_at_answer[0][-1] == ("Need a sum. Use range.", True)
    assert chat.got_callback is True
    assert block.code == "print(55)" and block.explanation == "Print it"
    # Throttled updates may be skipped, but the last one is always the complete text, marked done
    assert progress[-1] == ("Need a sum. Use range.", True)
    assert all(not done for _, done in progress[:-1])
    flows = [d.get("flow") for _, _, d in logs]
    assert flows.index(Flow.REASONING) < flows.index(Flow.FIRST_TOKEN) < flows.index(Flow.RESPONSE)
    response = next(d for _, _, d in logs if d.get("flow") == Flow.RESPONSE)
    assert response["reasoning_chars"] == len("Need a sum. Use range.")
    assert isinstance(response["first_reasoning_ms"], int)
    # The reasoning is never added to what the next model call receives
    assert "Need a sum" not in json.dumps([d.get("request") for _, _, d in logs])


def test_planner_without_reasoning_calls_the_adapter_exactly_as_before():
    chat = ThinkingChat()
    block, logs, progress = generate(find("ollama", "qwen3.5:4b"), chat, with_progress=False)
    assert chat.got_callback is False and progress == []
    assert block.code == "print(55)"
    assert all(d.get("flow") != Flow.REASONING and "reasoning_chars" not in d for _, _, d in logs)


# ─── API and stored history ────────────────────────────────────────────
class ReasoningRegistry(ProviderRegistry):
    """The real registry (config + preflight) whose create() returns a ThinkingChat; records the specs it got."""

    def __init__(self, texts):
        base = fake_registry()
        super().__init__(base.settings, transport=base._transport)
        self.texts, self.specs = list(texts), []

    def create(self, spec):
        self.specs.append(spec)
        registry = self

        class Chat(ThinkingChat):
            async def stream(self, *args, **kw):
                self.text = registry.texts.pop(0) if registry.texts else DONE
                return await super().stream(*args, **kw)

        return Chat()


def test_providers_say_which_models_can_show_reasoning(data_dir):
    with TestClient(make_app(data_dir, None)) as client:
        providers = client.get("/api/providers").json()["providers"]
    models = {(p["id"], m["id"]): m["reasoning"] for p in providers for m in p["models"]}
    assert all(models.values())
    kinds = {(p["id"], m["id"]): m["reasoning_kind"] for p in providers for m in p["models"]}
    assert kinds[("ollama", "qwen3.5:4b")] == "text" and kinds[("openai", "gpt-6.1-terra")] == "summary"


def test_reasoning_for_a_model_that_cannot_show_it_is_422_and_starts_nothing(data_dir, monkeypatch):
    from dataclasses import replace
    # No catalog model lacks reasoning any more, so take it away from one for this test
    monkeypatch.setattr(catalog, "CATALOG", [replace(m, reasoning_options=None) if m.id == "claude-sonnet-4-6" else m
                                             for m in catalog.CATALOG])
    with TestClient(make_app(data_dir, None)) as client:
        r = client.post("/api/runs", json={"message": "x", "provider": "anthropic", "model": "claude-sonnet-4-6",
                                           "reasoning": True})
        assert r.status_code == 422 and r.json()["detail"]["code"] == "reasoning_unsupported"
        assert client.get("/api/runs").json()["runs"] == []


def test_a_reasoning_run_stores_its_reasoning_per_model_call(data_dir):
    registry = ReasoningRegistry([GOOD, DONE])
    with TestClient(make_app(data_dir, None, providers=registry)) as client:
        run_id = client.post("/api/runs", json={"message": "sum", "reasoning": True}).json()["id"]
        run = wait_finished(client, run_id)
        logs = client.get(f"/api/runs/{run_id}/logs").json()["logs"]

    assert run["status"] == "success" and run["reasoning"] is True
    assert [it["reasoning"] for it in run["iterations"]] == ["Need a sum. Use range."] * 2
    # One planner for the whole run, created from the reasoning spec
    assert len(registry.specs) == 1 and registry.specs[0].reasoning and registry.specs[0].options["think"] is True
    started = next(e for e in logs if e["data"].get("flow") == Flow.STARTED)
    assert started["data"]["reasoning"] is True
    assert sum(e["data"].get("flow") == Flow.REASONING for e in logs) == 2


def test_a_run_without_reasoning_stores_none(data_dir):
    registry = ReasoningRegistry([GOOD, DONE])
    with TestClient(make_app(data_dir, None, providers=registry)) as client:
        run_id = client.post("/api/runs", json={"message": "sum"}).json()["id"]
        run = wait_finished(client, run_id)
        logs = client.get(f"/api/runs/{run_id}/logs").json()["logs"]
    assert run["reasoning"] is False and all(it["reasoning"] == "" for it in run["iterations"])
    assert registry.specs[0].options["think"] is False
    assert not any(e["data"].get("flow") == Flow.REASONING for e in logs)
    assert "reasoning" not in next(e for e in logs if e["data"].get("flow") == Flow.STARTED)["data"]


def test_reasoning_progress_sets_the_live_activity(data_dir):
    """While it streams, the run's activity names the phase, so the UI can label it after a refresh too."""
    from agent_workbench.storage.run_store import RunStore
    from agent_workbench.runs.manager import RunManager

    store = RunStore(data_dir / "agent.db")
    store.create_run("r1", "x", 5, 30, "qwen3.5:4b", "local", provider="ollama", reasoning=True)
    store.start_iteration("r1", 1)
    manager = RunManager.__new__(RunManager)
    manager.store = store
    manager._persist("r1", Event.REASONING_PROGRESS, {"iteration": 1, "reasoning": "abc", "chars": 3, "done": False})
    run = store.get_run("r1")
    assert run["activity_phase"] == "reasoning" and run["iterations"][0]["reasoning"] == "abc"
    manager._persist("r1", Event.REASONING_PROGRESS, {"iteration": 1, "reasoning": "abcdef", "chars": 6, "done": True})
    run = store.get_run("r1")
    # Complete: the answer is streaming now, so the live view must stop saying "reasoning"
    assert run["iterations"][0]["reasoning"] == "abcdef" and run["activity_phase"] == "streaming"
    store.close()


# ─── Anthropic adapter (fake SDK client) ───────────────────────────────
class ThinkingStream:
    """Fake AsyncAnthropic stream: raw events for two thinking blocks then the answer, and the final message."""

    def __init__(self, thoughts=(("Plan: ", "sum."), ("Check it.",)), text=GOOD):
        self.thoughts, self.text = thoughts, text
        self.used_text_stream = False

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def __aiter__(self):
        return self._events()

    async def _events(self):
        from types import SimpleNamespace as NS
        for block in self.thoughts:
            yield NS(type="content_block_start", content_block=NS(type="thinking"))
            for part in block:
                yield NS(type="content_block_delta", delta=NS(type="thinking_delta", thinking=part))
            yield NS(type="content_block_delta", delta=NS(type="signature_delta", signature="sig"))
        yield NS(type="content_block_start", content_block=NS(type="text"))
        yield NS(type="content_block_delta", delta=NS(type="text_delta", text=self.text))

    @property
    async def text_stream(self):
        self.used_text_stream = True
        yield self.text

    async def get_final_message(self):
        from types import SimpleNamespace as NS
        blocks = [NS(type="thinking", thinking="".join(b), signature="sig") for b in self.thoughts]
        return NS(content=[*blocks, NS(type="text", text=self.text)], stop_reason="end_turn", usage=None)


def anthropic_run(spec, with_reasoning):
    from types import SimpleNamespace as NS
    from agent_workbench.llm import AnthropicChat
    sent, fake = {}, ThinkingStream()

    def stream(**kwargs):
        sent.update(kwargs)
        return fake

    chat = AnthropicChat(spec, NS(messages=NS(stream=stream)))
    text, thoughts = [], []

    async def on_text(t):
        text.append(t)

    async def on_reasoning(t):
        thoughts.append(t)

    kw = {"on_reasoning": on_reasoning} if with_reasoning else {}
    result = asyncio.run(chat.stream("SYS", [{"role": "user", "content": "hi"}], 32000, on_text, **kw))
    return result, sent, "".join(text), "".join(thoughts), fake


def test_anthropic_streams_the_thinking_summary_apart_from_the_answer():
    result, sent, text, thoughts, fake = anthropic_run(for_run(find("anthropic", "claude-haiku-5-5"), True), True)
    assert sent["extra_body"]["thinking"] == {"type": "adaptive", "display": "summarized"}
    assert sent["extra_body"]["output_config"]["format"]["type"] == "json_schema"   # still the JSON schema
    assert thoughts == "Plan: sum.\n\nCheck it."           # two blocks, kept apart as paragraphs
    assert result.reasoning == "Plan: sum.\n\nCheck it."
    assert text == result.text == GOOD and not fake.used_text_stream


def test_anthropic_without_reasoning_is_unchanged():
    result, sent, text, thoughts, fake = anthropic_run(find("anthropic", "claude-haiku-5-5"), False)
    assert "thinking" not in sent["extra_body"] and fake.used_text_stream
    assert result.reasoning == "" and thoughts == "" and result.text == GOOD


# ─── OpenAI adapter (MockTransport) ────────────────────────────────────
def sse(*events) -> bytes:
    return "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events).encode()


def openai_run(spec, events, with_reasoning):
    from agent_workbench.llm import OpenAIChat
    seen = {}

    def handler(request):
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, content=sse(*events), headers={"content-type": "text/event-stream"})

    chat = OpenAIChat(spec, httpx.AsyncClient(transport=httpx.MockTransport(handler)), "https://api.openai.test/v1", "k")
    text, thoughts = [], []

    async def on_text(t):
        text.append(t)

    async def on_reasoning(t):
        thoughts.append(t)

    kw = {"on_reasoning": on_reasoning} if with_reasoning else {}
    result = asyncio.run(chat.stream("SYS", [{"role": "user", "content": "hi"}], 1234, on_text, **kw))
    return result, seen["body"], "".join(text), "".join(thoughts)


COMPLETED = {"type": "response.completed", "response": {"status": "completed", "usage": {"input_tokens": 9}}}


def test_openai_asks_for_and_streams_the_reasoning_summary():
    events = [
        {"type": "response.reasoning_summary_part.added", "summary_index": 0},
        {"type": "response.reasoning_summary_text.delta", "delta": "Need a sum.", "summary_index": 0},
        {"type": "response.reasoning_summary_part.added", "summary_index": 1},
        {"type": "response.reasoning_summary_text.delta", "delta": "Use range.", "summary_index": 1},
        {"type": "response.output_text.delta", "delta": GOOD},
        COMPLETED,
    ]
    result, body, text, thoughts = openai_run(for_run(find("openai", "gpt-6.1-terra"), True), events, True)
    assert body["model"] == "gpt-6.1-terra"
    assert body["reasoning"] == {"effort": "low", "summary": "auto"}
    assert body["text"]["format"]["strict"] is True                    # still the strict JSON schema
    assert thoughts == result.reasoning == "Need a sum.\n\nUse range."
    assert text == result.text == GOOD and result.stop == "end"


def test_openai_takes_the_summary_from_the_final_response_when_none_was_streamed():
    completed = {"type": "response.completed", "response": {"status": "completed", "output": [
        {"type": "reasoning", "summary": [{"type": "summary_text", "text": "Short plan."}]},
        {"type": "message", "content": [{"type": "output_text", "text": GOOD}]}]}}
    events = [{"type": "response.output_text.delta", "delta": GOOD}, completed]
    result, _, _, thoughts = openai_run(for_run(find("openai", "gpt-6-luna"), True), events, True)
    assert thoughts == result.reasoning == "Short plan."


def test_openai_without_reasoning_sends_no_summary_and_ignores_reasoning_events():
    events = [{"type": "response.reasoning_summary_text.delta", "delta": "hidden"},
              {"type": "response.output_text.delta", "delta": GOOD}, COMPLETED]
    result, body, text, thoughts = openai_run(find("openai", "gpt-6.1-terra"), events, False)
    assert body["reasoning"] == {"effort": "low"}
    assert result.reasoning == "" and thoughts == "" and text == GOOD
