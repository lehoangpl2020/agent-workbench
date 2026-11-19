"""
Model catalog — the ONLY place that declares the providers + models the app lets you choose.

To add/remove a model: edit the CATALOG list below (and PROVIDERS for a new provider).
The backend validates every selection against this file; the frontend gets the list through GET /api/providers
and keeps no list of its own. Do not put API keys/secrets here — keys come from environment variables
(see llm_providers.ProviderSettings).
"""

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class ModelSpec:
    provider: str                 # id provider: anthropic | openai | ollama
    id: str                       # model ID sent verbatim to the API
    name: str                     # display name
    provider_default: bool = False  # model preselected when the user switches to this provider
    note: str = ""                # short hint shown in the UI (price, speed...)
    max_output_tokens: int = 16000
    # Per-model/provider parameters, read by the adapters in llm_providers.py:
    #   openai:  reasoning_effort ("none" | "low" | "medium" | ...)
    #   ollama:  num_ctx (context window), think (enable/disable thinking)
    options: dict[str, Any] = field(default_factory=dict)

    @property
    def key(self) -> str:
        return f"{self.provider}/{self.id}"


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

CATALOG: list[ModelSpec] = [
    # ── Anthropic Claude ─────────────────────────────
    # Sonnet 4.6: no `thinking` is sent → runs without thinking (as before).
    ModelSpec("anthropic", "claude-sonnet-4-6", "Claude Sonnet 4.6", provider_default=True,
              note="Default · $3 / $15 per 1M tokens"),
    # The 5.5 models always use adaptive thinking; thinking tokens count toward max_tokens
    # → leave enough headroom so the code is not truncated.
    ModelSpec("anthropic", "claude-sonnet-5-5", "Claude Sonnet 5.5",
              note="Newer Sonnet · $2 / $10 per 1M tokens", max_output_tokens=32000),
    ModelSpec("anthropic", "claude-opus-5-5", "Claude Opus 5.5",
              note="Most capable Opus · $4 / $20 per 1M tokens", max_output_tokens=32000),
    ModelSpec("anthropic", "claude-haiku-5-5", "Claude Haiku 5.5",
              note="Fast and cheap · $0.10 / $0.50 per 1M tokens", max_output_tokens=32000),

    # ── OpenAI (Responses API) ───────────────────────
    # IDs and reasoning-effort levels checked against developers.openai.com/api/docs/models (2026-11).
    # All are reasoning models; "low" exists on all three.
    ModelSpec("openai", "gpt-6.2-sol", "GPT-6.2 Sol", provider_default=True,
              note="Everyday coding/agents · $2 / $10 per 1M tokens",
              options={"reasoning_effort": "low"}),
    ModelSpec("openai", "gpt-6-luna", "GPT-6 Luna",
              note="Cheapest, high volume · $0.10 / $0.50 per 1M tokens",
              options={"reasoning_effort": "low"}),
    ModelSpec("openai", "gpt-6.2-astra", "GPT-6.2 Astra",
              note="Flagship, expensive · $8 / $40 per 1M tokens",
              options={"reasoning_effort": "low"}),

    # ── Ollama (runs locally; `ollama pull` the model first) ─
    # think=False: return JSON immediately, spending no tokens on thinking (a 4B model running locally).
    # num_ctx: Ollama's default context is small; a history of many iterations needs room.
    ModelSpec("ollama", "qwen3.5:4b", "Qwen 3.5 4B", provider_default=True,
              note="Local · free · needs `ollama pull qwen3.5:4b`",
              max_output_tokens=8192, options={"num_ctx": 32768, "think": False}),
]

DEFAULT_PROVIDER = "anthropic"
DEFAULT_MODEL = "claude-sonnet-4-6"


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
      both None        → default (Claude Sonnet 4.6) — old clients/CLI send nothing
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


def describe(provider: str | None, model: str | None) -> dict:
    """Display name for a stored run. Old runs (provider NULL) keep the stored model and get no default."""
    spec = find(provider, model)
    info = PROVIDERS.get(provider or "")
    return {
        "provider_name": info.name if info else None,
        "model_name": spec.name if spec else None,
    }
