"""
P1.1: totals of tokens, time and cost per run (runs/metrics.py, `summary` in GET /api/runs/{id}).

OFFLINE/MOCK: no real API. The "model" is a fake chat client that returns the text and `usage` we script; it goes
through the REAL LLMPlanner, so the `metric` log entries are written exactly as in a real run, and the code the
"model" writes still runs for real in LocalExecutor. These tests show that the totals are computed correctly; they
do not show what a real provider reports as usage.
"""

import asyncio
import json
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from agent_workbench.config import Settings
from agent_workbench.llm import ChatResult, ProviderError, ProviderRegistry
from agent_workbench.runs.metrics import load_pricing, summarize_run
from agent_workbench.storage.run_store import now_iso
from tests.conftest import fake_registry
from tests.conftest import make_app, wait_finished

PROVIDER, MODEL = "anthropic", "claude-sonnet-4-6"
KEY = f"{PROVIDER}/{MODEL}"
PRICE = {KEY: {"input": 3, "output": 15}}


def step(code="", thinking="step") -> str:
    return json.dumps({"thinking": thinking, "code": code, "language": "python"})


DONE_TEXT = step("", "DONE")


class UsageChat:
    """Fake ChatClient: each call returns the next scripted (text, usage); an Exception is raised instead."""

    def __init__(self, registry):
        self.registry = registry

    async def stream(self, system, messages, max_tokens, on_text):
        text, usage = self.registry.script.pop(0) if self.registry.script else (DONE_TEXT, {})
        await asyncio.sleep(0.02)                       # so duration_ms and first_token_ms are > 0
        if isinstance(text, Exception):
            raise text
        await on_text(text[:10])
        await on_text(text[10:])
        return ChatResult(text, "end", "stop", usage)


class UsageRegistry(ProviderRegistry):
    def __init__(self, script):
        base = fake_registry()
        super().__init__(base.settings, transport=base._transport)
        self.script = list(script)

    def create(self, spec):
        return UsageChat(self)


def usage(i, o, **extra):
    return {"input_tokens": i, "output_tokens": o, **extra}


def settings_with(pricing: dict | None) -> Settings:
    return Settings.from_env({"MODEL_PRICING": json.dumps(pricing)} if pricing else {}, base_dir=Path("/app"))


def run_and_get(data_dir, script, pricing=None):
    app = make_app(data_dir, None, providers=UsageRegistry(script), settings=settings_with(pricing))
    with TestClient(app) as client:
        body = {"message": "calc", "provider": PROVIDER, "model": MODEL}
        run_id = client.post("/api/runs", json=body).json()["id"]
        return wait_finished(client, run_id)


# ── Price table ───────────────────────────────────
def test_load_pricing_from_inline_json_and_from_a_file(tmp_path):
    inline = json.dumps({KEY: {"input": 3, "output": 15, "cache_read": 0.3}})
    pricing, warnings = load_pricing(inline)
    assert pricing == {KEY: {"input": 3.0, "output": 15.0, "cache_read": 0.3}} and warnings == []

    path = tmp_path / "pricing.json"
    path.write_text(inline, encoding="utf-8")
    assert load_pricing(str(path))[0] == pricing
    assert load_pricing(None) == ({}, []) and load_pricing("  ") == ({}, [])


@pytest.mark.parametrize("raw", ["{not json", "[1, 2]", "/no/such/file.json"])
def test_load_pricing_never_raises(raw):
    pricing, warnings = load_pricing(raw)
    assert pricing == {} and len(warnings) == 1


def test_load_pricing_skips_only_the_invalid_entries():
    raw = json.dumps({"a/ok": {"input": 1, "output": 2}, "a/no-output": {"input": 1},
                      "a/negative": {"input": -1, "output": 2}, "a/bool": {"input": True, "output": 2}})
    pricing, warnings = load_pricing(raw)
    assert list(pricing) == ["a/ok"] and len(warnings) == 3


def test_settings_carry_the_price_table_and_its_warnings():
    s = Settings.from_env({"MODEL_PRICING": json.dumps({KEY: {"input": 3, "output": 15}, "x/y": {}})},
                          base_dir=Path("/app"))
    assert s.model_pricing == {KEY: {"input": 3.0, "output": 15.0}} and len(s.model_pricing_warnings) == 1
    assert Settings.from_env({}, base_dir=Path("/app")).model_pricing == {}


# ── API: a complete run ───────────────────────────
FIX_FLOW = [
    (step("print(undefined_name)", "First try"), usage(100, 40)),
    (step("print('fixed')", "Fix it"), usage(200, 60)),
    (DONE_TEXT, usage(300, 10)),
]


def test_run_summary_totals_tokens_time_and_cost(data_dir):
    run = run_and_get(data_dir, FIX_FLOW, PRICE)
    assert run["status"] == "success"
    s = run["summary"]

    llm = s["llm"]
    assert llm["calls"] == 3 and llm["failed_calls"] == 0 and llm["format_retries"] == 0
    assert (llm["input_tokens"], llm["output_tokens"]) == (600, 110)
    assert llm["usage_complete"] is True and llm["calls_with_usage"] == 3
    assert llm["duration_ms"] >= 3 * 20 and 0 < llm["first_token_ms_avg"] <= llm["first_token_ms_max"]

    # Two code runs (the first fails, the second works); the third model call only confirms DONE
    assert s["sandbox"]["runs"] == 2 and s["sandbox"]["duration_ms"] > 0
    assert s["wall_ms"] >= llm["duration_ms"]

    assert s["cost"]["status"] == "ok" and s["cost"]["currency"] == "USD"
    assert s["cost"]["amount"] == pytest.approx((600 * 3 + 110 * 15) / 1_000_000)

    per = {r["iteration"]: r for r in s["per_iteration"]}
    assert sorted(per) == [1, 2, 3]
    assert per[2]["input_tokens"] == 200 and per[2]["sandbox_ms"] > 0
    assert per[3]["sandbox_ms"] is None                  # the DONE call runs no code


def test_without_a_price_there_are_tokens_but_no_cost(data_dir):
    s = run_and_get(data_dir, FIX_FLOW)["summary"]
    assert s["llm"]["input_tokens"] == 600
    assert s["cost"] == {"status": "no_pricing", "pricing_key": KEY}


def test_a_provider_that_reports_no_usage_gives_none_not_zero(data_dir):
    s = run_and_get(data_dir, [(step("print(1)"), {}), (DONE_TEXT, {})], PRICE)["summary"]
    llm = s["llm"]
    assert llm["calls"] == 2 and llm["calls_with_usage"] == 0
    assert llm["input_tokens"] is None and llm["output_tokens"] is None
    assert llm["duration_ms"] > 0                       # time is still measured
    assert s["cost"]["status"] == "no_usage" and "amount" not in s["cost"]


def test_a_format_retry_is_counted_and_its_tokens_are_included(data_dir):
    # call 1: broken JSON (it still cost tokens) → resent; call 2: DONE before any code ran → the run fails
    run = run_and_get(data_dir, [("not json at all", usage(50, 5)), (DONE_TEXT, usage(70, 8))])
    llm = run["summary"]["llm"]
    assert llm["calls"] == 2 and llm["format_retries"] == 1
    assert llm["input_tokens"] == 120 and llm["output_tokens"] == 13


def test_a_failed_model_call_makes_usage_incomplete_and_the_cost_partial(data_dir):
    script = [(step("print(1)"), usage(100, 10)), (ProviderError("connection", PROVIDER, "boom"), {})]
    run = run_and_get(data_dir, script, PRICE)
    assert run["status"] == "error"
    llm = run["summary"]["llm"]
    assert llm["calls"] == 2 and llm["failed_calls"] == 1 and llm["usage_complete"] is False
    assert llm["input_tokens"] == 100                   # only what the provider reported
    assert run["summary"]["cost"]["status"] == "partial"


# ── A run from before the metric tag ──────────────
def test_a_run_stored_before_the_tag_has_no_data_instead_of_zero(data_dir):
    with TestClient(make_app(data_dir, None, providers=UsageRegistry([]))) as client:
        store = client.app.state.store
        run_id = str(uuid.uuid4())
        store.create_run(run_id, "old prompt", 5, 30, MODEL, "local", provider=PROVIDER)
        # the log of the old version: tokens are there, but no `metric` tag and no duration_ms
        store.add_log(run_id, {"ts": now_iso(), "iteration": 1, "source": "llm", "level": "INFO",
                               "message": "Response received in 2.0s",
                               "data": {"input_tokens": 10, "output_tokens": 5}})
        store.finish_run(run_id, "success", "", "", 1)
        s = client.get(f"/api/runs/{run_id}").json()["summary"]
    assert s["llm"] is None and s["sandbox"] is None
    assert s["cost"] == {"status": "no_data"}
    assert s["per_iteration"] == []


# ── Price formulas (pure) ─────────────────────────
def call_log(n=1, **data):
    return {"iteration": n, "source": "llm", "data": {"metric": "llm_call", "ok": True, "attempt": 0,
                                                       "duration_ms": 1000, **data}}


def cost_of(provider, model, logs, pricing):
    return summarize_run({"provider": provider, "model": model, "iterations": []}, logs, pricing)["cost"]


def test_anthropic_cache_tokens_are_separate_from_input():
    logs = [call_log(input_tokens=1000, output_tokens=200,
                     cache_read_input_tokens=5000, cache_creation_input_tokens=2000)]
    price = {"anthropic/m": {"input": 3, "output": 15, "cache_read": 0.3, "cache_write": 3.75}}
    c = cost_of("anthropic", "m", logs, price)
    assert c["amount"] == pytest.approx((1000 * 3 + 200 * 15 + 5000 * 0.3 + 2000 * 3.75) / 1e6)


def test_openai_cached_tokens_are_part_of_input_tokens():
    logs = [call_log(input_tokens=1000, output_tokens=200, cache_read_input_tokens=400, reasoning_tokens=150)]
    price = {"openai/m": {"input": 2, "output": 10, "cache_read": 0.5}}
    c = cost_of("openai", "m", logs, price)
    # 600 normal input + 400 cached; reasoning is already inside output, so it is not added again
    assert c["amount"] == pytest.approx((600 * 2 + 200 * 10 + 400 * 0.5) / 1e6)


def test_cache_is_priced_like_input_when_no_cache_price_is_set():
    logs = [call_log(input_tokens=100, output_tokens=0, cache_read_input_tokens=100)]
    c = cost_of("anthropic", "m", logs, {"anthropic/m": {"input": 4, "output": 8}})
    assert c["amount"] == pytest.approx(200 * 4 / 1e6)


def test_a_zero_price_is_a_real_price_not_a_missing_one():
    # A free local model: price 0 is a valid setting and gives $0, unlike "no price set"
    logs = [call_log(input_tokens=10, output_tokens=5)]
    assert cost_of("ollama", "m", logs, {"ollama/m": {"input": 0, "output": 0}})["amount"] == 0
    assert cost_of("ollama", "m", logs, {})["status"] == "no_pricing"
