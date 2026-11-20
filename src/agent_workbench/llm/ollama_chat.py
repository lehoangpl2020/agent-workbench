"""Ollama adapter: native API (POST /api/chat, streamed as NDJSON) over httpx."""

import json
from typing import Any

import httpx

from agent_workbench.llm.catalog import ModelSpec
from agent_workbench.llm.base import (
    BAD_REQUEST,
    CONNECTION,
    MODEL_NOT_PULLED,
    PROVIDER_ERROR,
    RESPONSE_SCHEMA,
    TIMEOUT,
    ChatResult,
    error_text,
    ProviderError,
    token_usage,
)


def ollama_hint(base_url: str) -> str:
    return (f"Check that Ollama is running and reachable from the backend at {base_url}. "
            "Backend in Docker: OLLAMA_BASE_URL=http://host.docker.internal:11434. "
            "Backend in WSL (NAT mode): use the Windows host IP and start Ollama with OLLAMA_HOST=0.0.0.0.")


class OllamaChat:
    provider = "ollama"

    def __init__(self, spec: ModelSpec, http: httpx.AsyncClient, base_url: str):
        self.spec, self.http, self.base_url = spec, http, base_url

    def build_body(self, system: str, messages: list[dict], max_tokens: int) -> dict:
        opts = self.spec.options
        body: dict[str, Any] = {
            "model": self.spec.id,
            "messages": [{"role": "system", "content": system}] + messages,
            "stream": True,
            "format": RESPONSE_SCHEMA,  # force JSON that matches the schema
            "options": {"num_predict": max_tokens},
        }
        if "num_ctx" in opts:
            body["options"]["num_ctx"] = opts["num_ctx"]
        if "think" in opts:
            body["think"] = opts["think"]
        return body

    async def stream(self, system, messages, max_tokens, on_text, on_reasoning=None) -> ChatResult:
        body = self.build_body(system, messages, max_tokens)
        text, reasoning, last = "", "", {}
        try:
            async with self.http.stream("POST", f"{self.base_url}/api/chat", json=body) as resp:
                if resp.status_code >= 400:
                    raise self._status_error(resp.status_code, await resp.aread())
                async for line in resp.aiter_lines():
                    if not line.strip():
                        continue
                    try:
                        chunk = json.loads(line)
                    except ValueError:
                        continue
                    if chunk.get("error"):
                        raise ProviderError(PROVIDER_ERROR, self.provider, f"Ollama error: {chunk['error']}")
                    message = chunk.get("message") or {}
                    # With think=True the model's thinking arrives in its own field, before the JSON answer. It is kept
                    # apart from `text`, so the answer that gets parsed is exactly what it was without reasoning.
                    thought = message.get("thinking") or ""
                    if thought and on_reasoning is not None:
                        reasoning += thought
                        await on_reasoning(thought)
                    delta = message.get("content") or ""
                    if delta:
                        text += delta
                        await on_text(delta)
                    if chunk.get("done"):
                        last = chunk
        except httpx.ConnectTimeout as e:
            raise ProviderError(CONNECTION, self.provider,
                                f"Cannot connect to Ollama (connect timeout). {ollama_hint(self.base_url)}") from e
        except httpx.TimeoutException as e:
            raise ProviderError(TIMEOUT, self.provider,
                                f"Ollama sent no data for too long ({type(e).__name__}); the model may still be loading "
                                "or the machine is too slow for this model.") from e
        except httpx.TransportError as e:
            raise ProviderError(CONNECTION, self.provider,
                                f"Cannot connect to Ollama ({type(e).__name__}). {ollama_hint(self.base_url)}") from e

        reason = last.get("done_reason")
        stop = {"stop": "end", "length": "max_tokens"}.get(reason, "other" if last else "other")
        usage = token_usage(input_tokens=last.get("prompt_eval_count"), output_tokens=last.get("eval_count"))
        return ChatResult(text, stop, reason, usage, reasoning=reasoning)

    def _status_error(self, status: int, body: bytes) -> ProviderError:
        msg = error_text(body)
        if status == 404 and "not found" in msg.lower():
            return ProviderError(MODEL_NOT_PULLED, self.provider,
                                 f"Model '{self.spec.id}' is not available in Ollama. "
                                 f"Run `ollama pull {self.spec.id}` on the Ollama machine. ({msg})", status)
        if status == 400:
            return ProviderError(BAD_REQUEST, self.provider, f"Request rejected (HTTP 400): {msg}", status)
        return ProviderError(PROVIDER_ERROR, self.provider, f"HTTP {status}: {msg}", status)
