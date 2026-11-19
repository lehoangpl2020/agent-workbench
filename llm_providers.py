"""
LLM providers — a thin layer that normalizes Anthropic / OpenAI / Ollama to one contract.

The planner (planner.py) only knows about:
    result = await chat.stream(system, messages, max_tokens, on_text)
    result.text         the full text the model returned (JSON {thinking, code, language})
    result.stop         "end" | "max_tokens" | "refusal" | "other"   (normalized)
    result.stop_reason  the provider's original value (for logging)
    result.usage        tokens the provider ACTUALLY returned (left empty when missing, never estimated)

Each adapter handles its own API differences (endpoint, parameters, stream format, error codes). There is no
silent fallback to another provider/model: an error → ProviderError with a clear `kind`.
"""

import json
import logging
import os
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Mapping, Protocol

import httpx

from model_catalog import PROVIDERS, ModelSpec, models_for

logger = logging.getLogger(__name__)

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


def _usage(**values: Any) -> dict[str, int]:
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


# ═══════════════════════════════════════════════════
# Anthropic — Messages API through the official SDK (AsyncAnthropic)
# ═══════════════════════════════════════════════════
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
        usage = _usage(**{f: getattr(u, f, None) for f in (
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


# ═══════════════════════════════════════════════════
# HTTP helpers shared by OpenAI + Ollama (httpx, async)
# ═══════════════════════════════════════════════════
def _error_text(body: bytes) -> str:
    try:
        data = json.loads(body)
    except ValueError:
        return body.decode("utf-8", "replace")[:300]
    err = data.get("error", data)
    if isinstance(err, dict):
        return str(err.get("message") or err.get("code") or err)[:500]
    return str(err)[:500]


# ═══════════════════════════════════════════════════
# OpenAI — Responses API (POST /v1/responses, stream SSE)
# ═══════════════════════════════════════════════════
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
        usage = _usage(input_tokens=u.get("input_tokens"), output_tokens=u.get("output_tokens"),
                       reasoning_tokens=(u.get("output_tokens_details") or {}).get("reasoning_tokens"),
                       cache_read_input_tokens=(u.get("input_tokens_details") or {}).get("cached_tokens"))
        return ChatResult(text, stop, stop_reason, usage)

    def _status_error(self, status: int, body: bytes) -> ProviderError:
        msg = _error_text(body)
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


# ═══════════════════════════════════════════════════
# Ollama — native API (POST /api/chat, stream NDJSON)
# ═══════════════════════════════════════════════════
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

    async def stream(self, system, messages, max_tokens, on_text) -> ChatResult:
        body = self.build_body(system, messages, max_tokens)
        text, last = "", {}
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
                    # Take only the content; if the model has thinking, that part is NOT shown/appended
                    delta = (chunk.get("message") or {}).get("content") or ""
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
        usage = _usage(input_tokens=last.get("prompt_eval_count"), output_tokens=last.get("eval_count"))
        return ChatResult(text, stop, reason, usage)

    def _status_error(self, status: int, body: bytes) -> ProviderError:
        msg = _error_text(body)
        if status == 404 and "not found" in msg.lower():
            return ProviderError(MODEL_NOT_PULLED, self.provider,
                                 f"Model '{self.spec.id}' is not available in Ollama. "
                                 f"Run `ollama pull {self.spec.id}` on the Ollama machine. ({msg})", status)
        if status == 400:
            return ProviderError(BAD_REQUEST, self.provider, f"Request rejected (HTTP 400): {msg}", status)
        return ProviderError(PROVIDER_ERROR, self.provider, f"HTTP {status}: {msg}", status)


# ═══════════════════════════════════════════════════
# Registry: configuration, readiness status, client creation (lazy)
# ═══════════════════════════════════════════════════
class ProviderRegistry:
    """
    Creates a ChatClient for a ModelSpec. SDK/HTTP clients are only created when that provider
    is actually used → running Ollama needs no Anthropic/OpenAI key.
    """

    PROBE_TIMEOUT = 3.0

    def __init__(self, settings: ProviderSettings | None = None,
                 transport: httpx.AsyncBaseTransport | None = None,
                 anthropic_client=None):
        self.settings = settings or ProviderSettings.from_env()
        self._transport = transport          # test: httpx.MockTransport
        self._anthropic = anthropic_client   # tests: fake client
        self._http: dict[str, httpx.AsyncClient] = {}

    def _client(self, provider: str, read_timeout: float) -> httpx.AsyncClient:
        if provider not in self._http:
            self._http[provider] = httpx.AsyncClient(
                transport=self._transport,
                timeout=httpx.Timeout(connect=10.0, read=read_timeout, write=30.0, pool=10.0),
            )
        return self._http[provider]

    def configured(self, provider: str) -> bool:
        return self.settings.missing_config(provider) is None

    def create(self, spec: ModelSpec) -> ChatClient:
        missing = self.settings.missing_config(spec.provider)
        if missing:
            raise ProviderError(NOT_CONFIGURED, spec.provider, missing)
        s = self.settings
        if spec.provider == "anthropic":
            if self._anthropic is None:
                from anthropic import AsyncAnthropic
                self._anthropic = AsyncAnthropic(api_key=s.anthropic_api_key) if s.anthropic_api_key else AsyncAnthropic()
            return AnthropicChat(spec, self._anthropic)
        if spec.provider == "openai":
            # Reasoning models can stay silent for quite a while before the first token
            return OpenAIChat(spec, self._client("openai", 300.0), s.openai_base_url, s.openai_api_key)
        if spec.provider == "ollama":
            # On first use Ollama must load the model into RAM/VRAM → long wait before the first token
            return OllamaChat(spec, self._client("ollama", 300.0), s.ollama_base_url)
        raise ProviderError(NOT_CONFIGURED, spec.provider, f"No adapter for provider '{spec.provider}'.")

    # ── Status shown by the UI before pressing Run ──
    async def ollama_models(self) -> tuple[set[str] | None, str | None, str | None]:
        """(names of pulled models, error kind, message). Calls GET /api/tags — downloads no model."""
        base = self.settings.ollama_base_url
        try:
            client = self._client("ollama-probe", self.PROBE_TIMEOUT)
            resp = await client.get(f"{base}/api/tags", timeout=self.PROBE_TIMEOUT)
        except httpx.TransportError as e:
            return None, CONNECTION, f"Cannot connect to Ollama ({type(e).__name__}). {ollama_hint(base)}"
        if resp.status_code >= 400:
            return None, PROVIDER_ERROR, f"Ollama returned HTTP {resp.status_code} for /api/tags."
        names: set[str] = set()
        for m in (resp.json().get("models") or []):
            for key in ("name", "model"):
                if m.get(key):
                    names.add(m[key])
                    if m[key].endswith(":latest"):
                        names.add(m[key][: -len(":latest")])
        return names, None, None

    async def status(self) -> list[dict]:
        """Catalog + status of each provider/model. Cloud: only checks that a key exists (no paid API call)."""
        out = []
        for pid, info in PROVIDERS.items():
            models = models_for(pid)
            missing = self.settings.missing_config(pid)
            entry: dict[str, Any] = {"id": pid, "name": info.name, "local": info.local,
                                     "configured": missing is None, "ready": missing is None,
                                     "status": NOT_CONFIGURED if missing else "configured",
                                     "message": missing or ""}
            ready_models: set[str] | None = None
            if pid == "ollama":
                entry["base_url"] = self.settings.ollama_base_url  # not a secret
                if missing is None:
                    ready_models, kind, msg = await self.ollama_models()
                    if kind:
                        entry.update(ready=False, status=kind, message=msg)
                    else:
                        entry.update(status="reachable", message="")
            elif missing is None:
                entry["message"] = "API key is set (not verified until the first call)."
            entry["models"] = []
            for m in models:
                model_ready, model_msg = entry["ready"], ""
                if pid == "ollama" and ready_models is not None and m.id not in ready_models:
                    model_ready = False
                    model_msg = f"Not pulled yet. Run `ollama pull {m.id}` on the Ollama machine."
                entry["models"].append({"id": m.id, "name": m.name, "provider_default": m.provider_default,
                                        "note": m.note, "ready": model_ready,
                                        "status": MODEL_NOT_PULLED if model_msg else entry["status"],
                                        "message": model_msg})
            out.append(entry)
        return out

    async def preflight(self, spec: ModelSpec) -> None:
        """Quick check before creating a run. Raises ProviderError if it certainly cannot run."""
        missing = self.settings.missing_config(spec.provider)
        if missing:
            raise ProviderError(NOT_CONFIGURED, spec.provider, missing)
        if spec.provider == "ollama":
            names, kind, msg = await self.ollama_models()
            if kind:
                raise ProviderError(kind, "ollama", msg)
            if spec.id not in names:
                raise ProviderError(MODEL_NOT_PULLED, "ollama",
                                    f"Model '{spec.id}' is not pulled in Ollama at {self.settings.ollama_base_url}. "
                                    f"Run `ollama pull {spec.id}` first (the app never downloads models).")

    async def aclose(self) -> None:
        for client in self._http.values():
            await client.aclose()
        self._http.clear()
        if self._anthropic is not None and hasattr(self._anthropic, "close"):
            try:
                await self._anthropic.close()
            except Exception:  # pragma: no cover
                pass
