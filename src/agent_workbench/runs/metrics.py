"""
Totals for ONE run: model calls, tokens, time spent in the model and in the sandbox, estimated cost.

There is no table and no counter. Every number is recomputed from data that is already stored:
  - run_logs with source="llm" and data.metric == events.METRIC_LLM_CALL: core/planner.py writes one per model call,
    with duration_ms, first_token_ms and the tokens the provider actually reported;
  - iterations.execution_time_ms: the time the executor measured for each code run.

Missing data is None ("no data"), never 0. A run stored before the `metric` tag existed, or a provider that
reports no usage, must not look like "0 tokens / $0".

The cost is tokens × a price table the user configures (MODEL_PRICING). No price is hard-coded here: prices
change, and a stale one would be wrong without anyone noticing.
"""

import json
from datetime import datetime
from pathlib import Path

from agent_workbench.domain.events import METRIC_LLM_CALL

# Prices are USD per 1,000,000 tokens. cache_read / cache_write are optional.
PRICE_FIELDS = ("input", "output", "cache_read", "cache_write")
TOKEN_FIELDS = ("input_tokens", "output_tokens", "cache_read_input_tokens",
                "cache_creation_input_tokens", "reasoning_tokens")
PER_MILLION = 1_000_000

Pricing = dict[str, dict[str, float]]


# ─── Price table ──────────────────────────────────
def load_pricing(source: str | None) -> tuple[Pricing, list[str]]:
    """
    Parses MODEL_PRICING: a JSON string (starts with "{") or the path of a JSON file.

        {"anthropic/claude-sonnet-4-6": {"input": 3, "output": 15, "cache_read": 0.3, "cache_write": 3.75}}

    Keys are "provider/model", as in llm/catalog.py. Returns (valid prices, warnings). Never raises: a bad
    price table only loses the cost estimate, it must not stop the server.
    """
    source = (source or "").strip()
    if not source:
        return {}, []
    try:
        text = source if source.startswith("{") else Path(source).read_text(encoding="utf-8")
        raw = json.loads(text)
    except (OSError, ValueError) as e:
        return {}, [f"MODEL_PRICING cannot be read: {e}"]
    if not isinstance(raw, dict):
        return {}, ["MODEL_PRICING must be a JSON object keyed by 'provider/model'"]

    pricing: Pricing = {}
    warnings: list[str] = []
    for key, entry in raw.items():
        if not isinstance(entry, dict) or not all(_is_price(entry.get(f)) for f in ("input", "output")):
            warnings.append(f"MODEL_PRICING['{key}'] ignored: it needs numeric 'input' and 'output' (USD per 1M tokens)")
            continue
        optional = [entry[f] for f in ("cache_read", "cache_write") if f in entry]
        if not all(_is_price(v) for v in optional):
            warnings.append(f"MODEL_PRICING['{key}'] ignored: cache prices must be numbers >= 0")
            continue
        pricing[key] = {f: float(entry[f]) for f in PRICE_FIELDS if f in entry}
    return pricing, warnings


def _is_price(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v >= 0


# ─── Totals ───────────────────────────────────────
def summarize_run(run: dict, logs: list[dict], pricing: Pricing | None = None) -> dict:
    """
    run: a dict from RunStore.get_run (with iterations). logs: the run's `llm` log entries (RunStore.list_logs).

    Returns:
      llm            None when no model call was measured; otherwise calls, failed_calls, format_retries, the token
                     totals (None when the provider reported none), duration_ms and first_token_ms_avg / _max
      sandbox        None when no code ran; otherwise runs and duration_ms
      wall_ms        the whole run (None while it is still running)
      cost           {status, amount, currency, ...}; status is ok | partial | no_pricing | no_usage | no_data
      per_iteration  time and tokens of each iteration, to see whether the time went to the model or the sandbox
    """
    calls = [l for l in logs if l.get("source") == "llm" and (l.get("data") or {}).get("metric") == METRIC_LLM_CALL]
    iterations = run.get("iterations") or []
    llm = _summarize_llm(calls)
    return {
        "llm": llm,
        "sandbox": _summarize_sandbox(iterations),
        "wall_ms": _wall_ms(run),
        "cost": _cost(run, llm, pricing or {}),
        "per_iteration": _per_iteration(calls, iterations),
    }


def _has_usage(data: dict) -> bool:
    return any(k in data for k in ("input_tokens", "output_tokens"))


def _sum(values) -> int | None:
    values = [v for v in values if isinstance(v, (int, float))]
    return round(sum(values)) if values else None


def _summarize_llm(calls: list[dict]) -> dict | None:
    if not calls:
        return None
    data = [c.get("data") or {} for c in calls]
    with_usage = [d for d in data if _has_usage(d)]
    first_tokens = [d["first_token_ms"] for d in data if isinstance(d.get("first_token_ms"), (int, float))]
    out = {
        "calls": len(calls),
        "failed_calls": sum(1 for d in data if d.get("ok") is False),
        "format_retries": sum(1 for d in data if (d.get("attempt") or 0) > 0),
        "calls_with_usage": len(with_usage),
        # False: some call reported no usage (the provider left it out, or the call failed), so the totals are a floor
        "usage_complete": len(with_usage) == len(calls),
        "duration_ms": _sum(d.get("duration_ms") for d in data),
        "first_token_ms_avg": round(sum(first_tokens) / len(first_tokens)) if first_tokens else None,
        "first_token_ms_max": round(max(first_tokens)) if first_tokens else None,
    }
    for field in TOKEN_FIELDS:
        out[field] = _sum(d.get(field) for d in with_usage) if with_usage else None
    return out


def _summarize_sandbox(iterations: list[dict]) -> dict | None:
    ran = [it for it in iterations if it.get("exit_code") is not None]
    if not ran:
        return None
    return {"runs": len(ran), "duration_ms": _sum(it.get("execution_time_ms") for it in ran)}


def _wall_ms(run: dict) -> int | None:
    start, end = run.get("created_at"), run.get("finished_at")
    if not start or not end:
        return None
    try:
        return round((datetime.fromisoformat(end) - datetime.fromisoformat(start)).total_seconds() * 1000)
    except ValueError:
        return None


def _per_iteration(calls: list[dict], iterations: list[dict]) -> list[dict]:
    rows: dict[int, dict] = {}

    def row(n: int) -> dict:
        return rows.setdefault(n, {"iteration": n, "llm_calls": 0, "llm_ms": None, "input_tokens": None,
                                   "output_tokens": None, "sandbox_ms": None})

    for c in calls:
        n, d = c.get("iteration"), c.get("data") or {}
        if n is None:
            continue
        r = row(n)
        r["llm_calls"] += 1
        r["llm_ms"] = (r["llm_ms"] or 0) + round(d.get("duration_ms") or 0)
        if _has_usage(d):
            r["input_tokens"] = (r["input_tokens"] or 0) + (d.get("input_tokens") or 0)
            r["output_tokens"] = (r["output_tokens"] or 0) + (d.get("output_tokens") or 0)
    for it in iterations:
        if it.get("exit_code") is not None and it.get("execution_time_ms") is not None:
            row(it["number"])["sandbox_ms"] = round(it["execution_time_ms"])
    return [rows[n] for n in sorted(rows)]


def _cost(run: dict, llm: dict | None, pricing: Pricing) -> dict:
    if llm is None:
        return {"status": "no_data"}
    if llm["calls_with_usage"] == 0:
        return {"status": "no_usage"}          # the provider reported no tokens: nothing to price
    provider, model = run.get("provider"), run.get("model")
    key = f"{provider}/{model}" if provider and model else None
    price = pricing.get(key) if key else None
    if not price:
        return {"status": "no_pricing", "pricing_key": key}

    inp = llm["input_tokens"] or 0
    out = llm["output_tokens"] or 0
    cache_read = llm["cache_read_input_tokens"] or 0
    cache_write = llm["cache_creation_input_tokens"] or 0
    # OpenAI counts cached_tokens INSIDE input_tokens; Anthropic reports cache tokens apart from input_tokens.
    fresh_input = max(inp - cache_read, 0) if provider == "openai" else inp
    # Reasoning/thinking tokens are already inside output_tokens for both, so they are not added again.
    # With no cache price configured, cache tokens are priced like normal input (no discount is assumed).
    amount = (
        fresh_input * price["input"]
        + out * price["output"]
        + cache_read * price.get("cache_read", price["input"])
        + cache_write * price.get("cache_write", price["input"])
    ) / PER_MILLION
    return {
        "status": "ok" if llm["usage_complete"] else "partial",
        "amount": amount,
        "currency": "USD",
        "pricing_key": key,
        "price_per_million": price,
    }
