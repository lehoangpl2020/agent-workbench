"""OpenAI adapter: Responses API (POST /v1/responses, streamed as SSE) over httpx."""

import json
import logging
from typing import Any

import httpx

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
    error_text,
    ProviderError,
    token_usage,
)

logger = logging.getLogger(__name__)


class OpenAIChat:
    provider = "openai"

    def __init__(self, spec: ModelSpec, http: httpx.AsyncClient, base_url: str, api_key: str):
        self.spec, self.http, self.base_url, self.api_key = spec, http, base_url, api_key

    def build_body(self, system: str, messages: list[dict], max_tokens: int) -> dict:
        body: dict[str, Any] = {
            "model": self.spec.id,
            "instructions": system,
            "input": [{"role": m["role"], "content": m["content"]} for m in messages],
            "max_output_tokens": max_tokens,
            "stream": True,
            "store": False,
            # Structured output: the model is forced to return exactly {thinking, code, language}
            "text": {"format": {"type": "json_schema", "name": "code_step",
                                "schema": RESPONSE_SCHEMA, "strict": True}},
        }
        # Reasoning models: do not send temperature; only adjust effort
        if "reasoning_effort" in self.spec.options:
            body["reasoning"] = {"effort": self.spec.options["reasoning_effort"]}
        return body

    async def stream(self, system, messages, max_tokens, on_text) -> ChatResult:
        body = self.build_body(system, messages, max_tokens)
        text, refusal, final = "", "", None
        try:
            async with self.http.stream(
                "POST", f"{self.base_url}/responses", json=body,
                headers={"Authorization": f"Bearer {self.api_key}"},
            ) as resp:
                if resp.status_code >= 400:
                    raise self._status_error(resp.status_code, await resp.aread())
                async for event in _sse_events(resp):
                    etype = event.get("type", "")
                    if etype == "response.output_text.delta":
                        delta = event.get("delta") or ""
                        text += delta
                        await on_text(delta)
                    elif etype == "response.refusal.delta":
                        refusal += event.get("delta") or ""
                    elif etype in ("response.completed", "response.incomplete"):
                        final = event.get("response") or {}
                    elif etype == "response.failed":
                        err = (event.get("response") or {}).get("error") or {}
                        raise ProviderError(PROVIDER_ERROR, self.provider,
                                            f"Response failed: {err.get('code', '')} {err.get('message', '')}".strip())
                    elif etype == "error":
                        raise ProviderError(PROVIDER_ERROR, self.provider,
                                            f"Stream error: {event.get('code', '')} {event.get('message', '')}".strip())
        except httpx.ConnectTimeout as e:
            raise ProviderError(CONNECTION, self.provider, f"Cannot reach {self.base_url} (connect timeout)") from e
        except httpx.TimeoutException as e:
            raise ProviderError(TIMEOUT, self.provider,
                                f"No data from {self.base_url} for too long ({type(e).__name__})") from e
        except httpx.TransportError as e:
            raise ProviderError(CONNECTION, self.provider,
                                f"Cannot reach {self.base_url} ({type(e).__name__}): {e}") from e

        final = final or {}
        status = final.get("status")
        reason = (final.get("incomplete_details") or {}).get("reason")
        if refusal and not text:
            stop, stop_reason = "refusal", "refusal"
        elif status == "incomplete" and reason == "max_output_tokens":
            stop, stop_reason = "max_tokens", reason
        elif status == "incomplete" and reason == "content_filter":
            stop, stop_reason = "refusal", reason
        elif status == "completed":
            stop, stop_reason = "end", "completed"
        else:
            stop, stop_reason = "other", reason or status
        u = final.get("usage") or {}
        usage = token_usage(input_tokens=u.get("input_tokens"), output_tokens=u.get("output_tokens"),
                       reasoning_tokens=(u.get("output_tokens_details") or {}).get("reasoning_tokens"),
                       cache_read_input_tokens=(u.get("input_tokens_details") or {}).get("cached_tokens"))
        return ChatResult(text, stop, stop_reason, usage)

    def _status_error(self, status: int, body: bytes) -> ProviderError:
        msg = error_text(body)
        if status == 401:
            return ProviderError(AUTH, self.provider, f"Authentication failed — check OPENAI_API_KEY (HTTP 401): {msg}", status)
        if status == 403:
            return ProviderError(PERMISSION, self.provider, f"Access denied (HTTP 403): {msg}", status)
        if status == 404:
            return ProviderError(MODEL_NOT_FOUND, self.provider,
                                 f"Model '{self.spec.id}' was not found or this key has no access (HTTP 404): {msg}", status)
        if status == 429:
            return ProviderError(RATE_LIMIT, self.provider, f"Rate limited or out of credit (HTTP 429): {msg}", status)
        if status == 400:
            return ProviderError(BAD_REQUEST, self.provider, f"Request rejected (HTTP 400): {msg}", status)
        return ProviderError(PROVIDER_ERROR, self.provider, f"HTTP {status}: {msg}", status)


async def _sse_events(resp: httpx.Response):
    """Reads SSE: each event is one 'data: {...}' block terminated by a blank line."""
    data_lines: list[str] = []
    async for line in resp.aiter_lines():
        if line == "":
            if data_lines:
                payload = "\n".join(data_lines)
                data_lines = []
                if payload.strip() == "[DONE]":
                    return
                try:
                    yield json.loads(payload)
                except ValueError:
                    logger.warning("Skipping malformed SSE payload")
            continue
        if line.startswith("data:"):
            data_lines.append(line[5:].lstrip())
    if data_lines:
        try:
            yield json.loads("\n".join(data_lines))
        except ValueError:
            pass
