"""
LLM provider contract — a thin layer that normalizes Anthropic / OpenAI / Ollama to one contract.

The planner (core/planner.py) only knows about:
    result = await chat.stream(system, messages, max_tokens, on_text)
    result.text         the full text the model returned (JSON {thinking, code, language})
    result.stop         "end" | "max_tokens" | "refusal" | "other"   (normalized)
    result.stop_reason  the provider's original value (for logging)
    result.usage        tokens the provider ACTUALLY returned (left empty when missing, never estimated)

Each adapter (anthropic_chat.py, openai_chat.py, ollama_chat.py) handles its own API differences (endpoint, parameters, stream format, error codes). There is no
silent fallback to another provider/model: an error → ProviderError with a clear `kind`.
"""

import json
import os
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Mapping, Protocol

from agent_workbench.llm.catalog import PROVIDERS

TextFn = Callable[[str], Awaitable[None]]

# JSON schema the planner asks for. OpenAI and Ollama enforce it; Anthropic does too when the model's catalog
# options say `structured_output` (otherwise: system prompt + parsing + format retry, which stay as a safety net).
RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "thinking": {"type": "string"},
        "code": {"type": "string"},
        "language": {"type": "string"},
    },
    "required": ["thinking", "code", "language"],
    "additionalProperties": False,
}

# ─── Normalized errors ─────────────────────────────
NOT_CONFIGURED = "not_configured"      # missing API key / base URL
CONNECTION = "connection"              # cannot connect to the provider
TIMEOUT = "timeout"                    # connected, but no data for too long
MODEL_NOT_PULLED = "model_not_pulled"  # Ollama is running but the model has not been `ollama pull`ed
MODEL_NOT_FOUND = "model_not_found"    # the provider does not have this model ID (or the key cannot see it)
AUTH = "auth"                          # wrong / expired key (401)
PERMISSION = "permission"              # the provider denied access (403)
RATE_LIMIT = "rate_limit"              # 429: rate limit / out of credit
BAD_REQUEST = "bad_request"            # 400: invalid parameters
PROVIDER_ERROR = "provider_error"      # 5xx / other errors


class ProviderError(Exception):
    def __init__(self, kind: str, provider: str, message: str, status: int | None = None):
        name = PROVIDERS[provider].name if provider in PROVIDERS else provider
        super().__init__(f"[{name}] {message}")
        self.kind = kind
        self.provider = provider
        self.status = status


@dataclass
class ChatResult:
    text: str
    stop: str                      # end | max_tokens | refusal | other
    stop_reason: str | None        # original value
    usage: dict[str, int] = field(default_factory=dict)


class ChatClient(Protocol):
    async def stream(self, system: str, messages: list[dict], max_tokens: int,
                     on_text: TextFn) -> ChatResult: ...


def token_usage(**values: Any) -> dict[str, int]:
    """Keeps only the token counts the provider returned (int > 0)."""
    return {k: v for k, v in values.items() if isinstance(v, int) and not isinstance(v, bool) and v > 0}


# ─── Settings (from environment variables only; keys are never returned to callers) ──
@dataclass
class ProviderSettings:
    anthropic_api_key: str | None = None
    anthropic_auth_token: str | None = None
    openai_api_key: str | None = None
    openai_base_url: str = "https://api.openai.com/v1"
    ollama_base_url: str = "http://localhost:11434"

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "ProviderSettings":
        env = os.environ if env is None else env
        return cls(
            anthropic_api_key=env.get("ANTHROPIC_API_KEY") or None,
            anthropic_auth_token=env.get("ANTHROPIC_AUTH_TOKEN") or None,
            openai_api_key=env.get("OPENAI_API_KEY") or None,
            openai_base_url=(env.get("OPENAI_BASE_URL") or "https://api.openai.com/v1").rstrip("/"),
            ollama_base_url=(env.get("OLLAMA_BASE_URL") or "http://localhost:11434").rstrip("/"),
        )

    def missing_config(self, provider: str) -> str | None:
        """None when fully configured; otherwise a message saying what is missing (without revealing values)."""
        if provider == "anthropic" and not (self.anthropic_api_key or self.anthropic_auth_token):
            return "ANTHROPIC_API_KEY is not set on the server."
        if provider == "openai" and not self.openai_api_key:
            return "OPENAI_API_KEY is not set on the server."
        if provider == "ollama" and not self.ollama_base_url:
            return "OLLAMA_BASE_URL is empty."
        return None

# ─── HTTP helper shared by OpenAI + Ollama ─────────
def error_text(body: bytes) -> str:
    try:
        data = json.loads(body)
    except ValueError:
        return body.decode("utf-8", "replace")[:300]
    err = data.get("error", data)
    if isinstance(err, dict):
        return str(err.get("message") or err.get("code") or err)[:500]
    return str(err)[:500]
