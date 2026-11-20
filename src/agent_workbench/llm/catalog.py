"""
Model catalog — the ONLY place that declares the providers + models the app lets you choose.

To add/remove a model: edit the CATALOG list below (and PROVIDERS for a new provider).
The backend validates every selection against this file; the frontend gets the list through GET /api/providers
and keeps no list of its own. Do not put API keys/secrets here — keys come from environment variables
(see llm_providers.ProviderSettings).
"""

from dataclasses import dataclass, field, replace
from typing import Any


@dataclass(frozen=True)
class ModelSpec:
    provider: str                 # id provider: anthropic | openai | ollama
    id: str                       # model ID sent verbatim to the API
    name: str                     # display name
    provider_default: bool = False  # model preselected when the user switches to this provider
    note: str = ""                # short hint shown in the UI (price, speed...)
    max_output_tokens: int = 16000
    # Per-model/provider parameters, read by the adapters in llm/*_chat.py:
    #   anthropic: structured_output (bool: constrain the reply to the JSON schema, API output_config.format),
    #              thinking (dict sent as the API's `thinking` parameter)
    #   openai:  reasoning_effort ("none" | "low" | "medium" | ...), reasoning_summary ("auto" | "concise" | "detailed")
    #   ollama:  num_ctx (context window), think (enable/disable thinking)
    options: dict[str, Any] = field(default_factory=dict)
    # Per-run opt-in "Reasoning": the options merged in when a run asks to see the model's reasoning, and the output cap
    # for such a run (reasoning tokens count toward it). None = this model cannot show reasoning in this app.
    reasoning_options: dict[str, Any] | None = None
    reasoning_max_output_tokens: int | None = None
    # What the provider streams as "reasoning": "text" = the model's own reasoning text (Ollama `thinking`),
    # "summary" = a summary the provider writes of reasoning it never returns (Anthropic, OpenAI). The UI labels it so.
    reasoning_kind: str | None = None
    # True only on the spec of a run that asked for reasoning (see for_run); catalog rows are always False
    reasoning: bool = False

    @property
    def key(self) -> str:
        return f"{self.provider}/{self.id}"

    @property
    def supports_reasoning(self) -> bool:
        return self.reasoning_options is not None


@dataclass(frozen=True)
class ProviderInfo:
    id: str
    name: str
    local: bool = False


PROVIDERS: dict[str, ProviderInfo] = {
    p.id: p
    for p in [
        ProviderInfo("anthropic", "Anthropic"),
        ProviderInfo("openai", "OpenAI"),
        ProviderInfo("ollama", "Ollama (local)", local=True),
    ]
}

# Merged into a model's options for a run with Reasoning on (see ModelSpec.reasoning_options)
ANTHROPIC_REASONING = {"thinking": {"type": "adaptive", "display": "summarized"}}
OPENAI_REASONING = {"reasoning_summary": "auto"}

CATALOG: list[ModelSpec] = [
    # ── Anthropic Claude ─────────────────────────────
    # Without Reasoning: Sonnet 4.6 gets no `thinking` (runs without it); the 5.5 models always think (adaptive) and
    # the API returns those thinking blocks empty by default (display "omitted"); thinking tokens count toward
    # max_tokens, hence 32000. With Reasoning: `thinking` = adaptive with display "summarized", so the stream carries
    # a readable summary of the reasoning. The raw reasoning is never returned by the API.
    ModelSpec("anthropic", "claude-sonnet-4-6", "Claude Sonnet 4.6",
              note="Older Sonnet · $3 / $15 per 1M tokens", options={"structured_output": True},
              reasoning_options=ANTHROPIC_REASONING, reasoning_max_output_tokens=32000, reasoning_kind="summary"),
    ModelSpec("anthropic", "claude-sonnet-5-5", "Claude Sonnet 5.5", provider_default=True,
              note="Preselected for Anthropic · $2 / $10 per 1M tokens", max_output_tokens=32000,
              options={"structured_output": True}, reasoning_options=ANTHROPIC_REASONING, reasoning_kind="summary"),
    ModelSpec("anthropic", "claude-opus-5-5", "Claude Opus 5.5",
              note="Most capable Opus · $4 / $20 per 1M tokens", max_output_tokens=32000,
              options={"structured_output": True}, reasoning_options=ANTHROPIC_REASONING, reasoning_kind="summary"),
    ModelSpec("anthropic", "claude-haiku-5-5", "Claude Haiku 5.5",
              note="Fast and cheap · $0.10 / $0.50 per 1M tokens", max_output_tokens=32000,
              options={"structured_output": True}, reasoning_options=ANTHROPIC_REASONING, reasoning_kind="summary"),

    # ── OpenAI (Responses API) ───────────────────────
    # IDs, prices and reasoning-effort levels checked against developers.openai.com/api/docs/models and /pricing
    # (2026-11-20). All are reasoning models; "low" exists on all four. With Reasoning: `reasoning.summary` asks for
    # the summary OpenAI writes of the model's reasoning (the reasoning itself is never returned).
    ModelSpec("openai", "gpt-6.2-sol", "GPT-6.2 Sol", provider_default=True,
              note="Everyday coding/agents · $2 / $10 per 1M tokens",
              options={"reasoning_effort": "low"}, reasoning_options=OPENAI_REASONING, reasoning_kind="summary"),
    ModelSpec("openai", "gpt-6.1-terra", "GPT-6.1 Terra",
              note="Mid-range · $1 / $5 per 1M tokens",
              options={"reasoning_effort": "low"}, reasoning_options=OPENAI_REASONING, reasoning_kind="summary"),
    ModelSpec("openai", "gpt-6-luna", "GPT-6 Luna",
              note="Cheapest, high volume · $0.10 / $0.50 per 1M tokens",
              options={"reasoning_effort": "low"}, reasoning_options=OPENAI_REASONING, reasoning_kind="summary"),
    ModelSpec("openai", "gpt-6.2-astra", "GPT-6.2 Astra",
              note="Flagship, expensive · $8 / $40 per 1M tokens",
              options={"reasoning_effort": "low"}, reasoning_options=OPENAI_REASONING, reasoning_kind="summary"),

    # ── Ollama (runs locally; `ollama pull` the model first) ─
    # IDs are the exact tags shown by `ollama list` (sent verbatim, including ":latest").
    # think=False: return JSON immediately, spending no tokens on thinking. `ollama show` lists `false` among
    #   the thinking levels of all three models below.
    # num_ctx: Ollama's default context is small; a history of many iterations needs room. 32768 is an
    #   application setting, below the 262144 context length `ollama show` reports for these models.
    # max_output_tokens: an application-side cap per model call, not a statement about what the model supports.
    # Reasoning (opt-in per run): think=True makes Ollama stream the model's thinking in `message.thinking`, separate
    #   from the JSON answer. Checked with Ollama 0.40.16 and the JSON `format` on all three models (2026-11-20).
    #   Thinking tokens count toward num_predict, so such a run gets a larger cap.
    ModelSpec("ollama", "qwen3.5:4b", "Qwen 3.5 4B", provider_default=True,
              note="Local · free · app default · needs `ollama pull qwen3.5:4b`",
              max_output_tokens=8192, options={"num_ctx": 32768, "think": False},
              reasoning_options={"think": True}, reasoning_max_output_tokens=16384, reasoning_kind="text"),
    ModelSpec("ollama", "qwen3.8:latest", "Qwen 3.8 (latest)",
              note="Local · free · needs `ollama pull qwen3.8:latest`",
              max_output_tokens=8192, options={"num_ctx": 32768, "think": False},
              reasoning_options={"think": True}, reasoning_max_output_tokens=16384, reasoning_kind="text"),
    ModelSpec("ollama", "gemma4:12b", "Gemma 4 12B",
              note="Local · free · needs `ollama pull gemma4:12b`",
              max_output_tokens=8192, options={"num_ctx": 32768, "think": False},
              reasoning_options={"think": True}, reasoning_max_output_tokens=16384, reasoning_kind="text"),
]

# App-wide default: used only when a request names neither provider nor model. A run still keeps whatever
# was chosen (or defaulted) for its whole life, and old runs with no stored provider are never given this.
DEFAULT_PROVIDER = "ollama"
DEFAULT_MODEL = "qwen3.5:4b"


class InvalidModelSelection(ValueError):
    """The provider/model is not in the catalog (the API returns 422)."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def models_for(provider: str) -> list[ModelSpec]:
    return [m for m in CATALOG if m.provider == provider]


def find(provider: str | None, model: str | None) -> ModelSpec | None:
    """Looks up exactly the stored provider/model pair (no guessing). None if it is no longer in the catalog."""
    return next((m for m in CATALOG if m.provider == provider and m.id == model), None)


def default_spec() -> ModelSpec:
    spec = find(DEFAULT_PROVIDER, DEFAULT_MODEL)
    assert spec is not None, "DEFAULT_MODEL must be in CATALOG"
    return spec


def resolve(provider: str | None, model: str | None) -> ModelSpec:
    """
    Normalizes the selection from a request:
      both None        → default (Ollama qwen3.5:4b) — old clients/CLI send nothing
      provider only    → that provider's provider_default model
      model only       → the provider that has that model (if unique)
      both             → must match exactly one row in CATALOG
    No silent fallback: a bad selection raises InvalidModelSelection.
    """
    provider = (provider or "").strip() or None
    model = (model or "").strip() or None
    if provider is None and model is None:
        return default_spec()
    if provider is not None and provider not in PROVIDERS:
        raise InvalidModelSelection(
            "invalid_provider",
            f"Unknown provider '{provider}'. Available: {', '.join(PROVIDERS)}.",
        )
    if model is None:
        options = models_for(provider)
        if not options:
            raise InvalidModelSelection("invalid_model", f"Provider '{provider}' has no models configured.")
        return next((m for m in options if m.provider_default), options[0])
    if provider is None:
        matches = [m for m in CATALOG if m.id == model]
        if len(matches) == 1:
            return matches[0]
        raise InvalidModelSelection(
            "invalid_model",
            f"Model '{model}' is not in the catalog." if not matches
            else f"Model '{model}' exists for several providers; send 'provider' too.",
        )
    spec = find(provider, model)
    if spec is None:
        available = ", ".join(m.id for m in models_for(provider))
        raise InvalidModelSelection(
            "invalid_model",
            f"Model '{model}' is not configured for provider '{provider}'. Available: {available}.",
        )
    return spec


def for_run(spec: ModelSpec, reasoning: bool) -> ModelSpec:
    """The spec one run calls: the catalog row, plus the reasoning options when the run asked to see reasoning.
    Raises InvalidModelSelection if the model cannot show reasoning (never silently runs without it)."""
    if not reasoning:
        return spec
    if spec.reasoning_options is None:
        raise InvalidModelSelection(
            "reasoning_unsupported", f"{spec.name} ({spec.key}) cannot show its reasoning in this app.")
    return replace(spec, options={**spec.options, **spec.reasoning_options}, reasoning=True,
                   max_output_tokens=spec.reasoning_max_output_tokens or spec.max_output_tokens)


def describe(provider: str | None, model: str | None) -> dict:
    """Display name for a stored run. Old runs (provider NULL) keep the stored model and get no default."""
    spec = find(provider, model)
    info = PROVIDERS.get(provider or "")
    return {
        "provider_name": info.name if info else None,
        "model_name": spec.name if spec else None,
        # "text" | "summary" | None: how to label the reasoning this model streams (see ModelSpec.reasoning_kind)
        "reasoning_kind": spec.reasoning_kind if spec else None,
    }
