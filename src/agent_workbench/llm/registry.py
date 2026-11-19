"""ProviderRegistry: which providers are configured, their readiness, and creating a ChatClient for a model."""

from typing import Any

import httpx

from agent_workbench.llm.anthropic_chat import ANTHROPIC_MAX_RETRIES, ANTHROPIC_TIMEOUT_SECONDS, AnthropicChat
from agent_workbench.llm.base import (
    CONNECTION,
    MODEL_NOT_PULLED,
    NOT_CONFIGURED,
    PROVIDER_ERROR,
    ChatClient,
    ProviderError,
    ProviderSettings,
)
from agent_workbench.llm.catalog import PROVIDERS, ModelSpec, models_for
from agent_workbench.llm.ollama_chat import OllamaChat, ollama_hint
from agent_workbench.llm.openai_chat import OpenAIChat


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
                # Retries and timeout are the SDK's own defaults, written out so they are visible and tested:
                # a transient error (429/5xx/connection) is retried inside ONE model call and is not logged.
                limits = dict(max_retries=ANTHROPIC_MAX_RETRIES, timeout=ANTHROPIC_TIMEOUT_SECONDS)
                self._anthropic = (AsyncAnthropic(api_key=s.anthropic_api_key, **limits) if s.anthropic_api_key
                                   else AsyncAnthropic(**limits))
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
