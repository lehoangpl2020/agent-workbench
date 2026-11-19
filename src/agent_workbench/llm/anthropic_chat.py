"""Anthropic adapter: Messages API through the official SDK (AsyncAnthropic)."""

from typing import Any

from agent_workbench.llm.catalog import ModelSpec
from agent_workbench.llm.base import (
    AUTH,
    BAD_REQUEST,
    CONNECTION,
    MODEL_NOT_FOUND,
    PERMISSION,
    PROVIDER_ERROR,
    RATE_LIMIT,
    RESPONSE_SCHEMA,
    TIMEOUT,
    ChatResult,
    ProviderError,
    token_usage,
)

# Anthropic SDK behavior, same as its defaults (checked in anthropic 2.10: DEFAULT_MAX_RETRIES = 2, 10 min timeout)
ANTHROPIC_MAX_RETRIES = 2
ANTHROPIC_TIMEOUT_SECONDS = 600.0


class AnthropicChat:
    provider = "anthropic"

    def __init__(self, spec: ModelSpec, client):
        self.spec = spec
        self.client = client   # AsyncAnthropic (tests inject a fake client)

    async def stream(self, system, messages, max_tokens, on_text) -> ChatResult:
        import anthropic

        params: dict[str, Any] = dict(model=self.spec.id, max_tokens=max_tokens,
                                      system=system, messages=messages)
        output_config: dict[str, Any] = {}
        if "effort" in self.spec.options:
            output_config["effort"] = self.spec.options["effort"]
        if self.spec.options.get("structured_output"):
            # Constrains the reply to the same {thinking, code, language} object OpenAI and Ollama already get.
            # Sent as extra_body so it also works with SDK versions that predate the output_config argument.
            output_config["format"] = {"type": "json_schema", "schema": RESPONSE_SCHEMA}
        if output_config:
            params["extra_body"] = {"output_config": output_config}
        try:
            async with self.client.messages.stream(**params) as stream:
                async for chunk in stream.text_stream:
                    await on_text(chunk)
                final = await stream.get_final_message()
        except anthropic.APIStatusError as e:
            raise self._status_error(e) from e
        except anthropic.APITimeoutError as e:
            raise ProviderError(TIMEOUT, self.provider, f"No response from the Anthropic API in time: {e}") from e
        except anthropic.APIConnectionError as e:
            raise ProviderError(CONNECTION, self.provider,
                                f"Cannot reach the Anthropic API ({type(e).__name__}): {e}") from e

        text = "".join(b.text for b in final.content if getattr(b, "type", None) == "text")
        reason = getattr(final, "stop_reason", None)
        stop = {"end_turn": "end", "stop_sequence": "end", "max_tokens": "max_tokens",
                "refusal": "refusal"}.get(reason, "other")
        u = getattr(final, "usage", None)
        usage = token_usage(**{f: getattr(u, f, None) for f in (
            "input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")}) if u else {}
        return ChatResult(text, stop, reason, usage)

    def _status_error(self, e) -> ProviderError:
        status = getattr(e, "status_code", None)
        msg = getattr(e, "message", str(e))
        kind = {401: AUTH, 403: PERMISSION, 404: MODEL_NOT_FOUND, 429: RATE_LIMIT, 400: BAD_REQUEST}.get(
            status, PROVIDER_ERROR)
        label = {
            AUTH: "Authentication failed — check ANTHROPIC_API_KEY",
            PERMISSION: "Access denied for this key",
            MODEL_NOT_FOUND: f"Model '{self.spec.id}' was not found (wrong ID or no access)",
            RATE_LIMIT: "Rate limited or out of credit",
            BAD_REQUEST: "Request rejected",
        }.get(kind, "Provider error")
        return ProviderError(kind, self.provider, f"{label} (HTTP {status}): {msg}", status)
