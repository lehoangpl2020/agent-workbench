"""
Model catalog — NƠI DUY NHẤT khai báo provider + model mà app cho chọn.

Muốn thêm/bớt model: sửa list CATALOG bên dưới (và PROVIDERS nếu là provider mới).
Backend validate mọi lựa chọn theo file này; frontend lấy danh sách qua GET /api/providers,
không giữ danh sách riêng. Không ghi API key/secret ở đây — key lấy từ biến môi trường
(xem llm_providers.ProviderSettings).

Tương đương .NET: giống một static registry/options class được bind 1 lần, mọi nơi
khác chỉ tra cứu theo id.
"""

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class ModelSpec:
    provider: str                 # id provider: anthropic | openai | ollama
    id: str                       # model ID gửi đúng nguyên văn lên API
    name: str                     # tên hiển thị
    provider_default: bool = False  # model chọn sẵn khi user đổi sang provider này
    note: str = ""                # gợi ý ngắn hiện ở UI (giá, tốc độ...)
    max_output_tokens: int = 16000
    # Tham số riêng của từng model/provider, adapter trong llm_providers.py đọc:
    #   openai:  reasoning_effort ("none" | "low" | "medium" | ...)
    #   ollama:  num_ctx (context window), think (bật/tắt thinking)
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
    # Sonnet 4.6: không gửi `thinking` → chạy không thinking (như trước đây).
    ModelSpec("anthropic", "claude-sonnet-4-6", "Claude Sonnet 4.6", provider_default=True,
              note="Default · $3 / $15 per 1M tokens"),
    # Các model 5.5 luôn bật adaptive thinking; thinking tokens tính vào max_tokens
    # → cho dư chỗ để code không bị cắt cụt.
    ModelSpec("anthropic", "claude-sonnet-5-5", "Claude Sonnet 5.5",
              note="Newer Sonnet · $2 / $10 per 1M tokens", max_output_tokens=32000),
    ModelSpec("anthropic", "claude-opus-5-5", "Claude Opus 5.5",
              note="Most capable Opus · $4 / $20 per 1M tokens", max_output_tokens=32000),
    ModelSpec("anthropic", "claude-haiku-5-5", "Claude Haiku 5.5",
              note="Fast and cheap · $0.10 / $0.50 per 1M tokens", max_output_tokens=32000),

    # ── OpenAI (Responses API) ───────────────────────
    # ID và mức reasoning effort đối chiếu với developers.openai.com/api/docs/models (2026-11).
    # Đều là reasoning model; "low" có ở cả ba model.
    ModelSpec("openai", "gpt-6.2-sol", "GPT-6.2 Sol", provider_default=True,
              note="Everyday coding/agents · $2 / $10 per 1M tokens",
              options={"reasoning_effort": "low"}),
    ModelSpec("openai", "gpt-6-luna", "GPT-6 Luna",
              note="Cheapest, high volume · $0.10 / $0.50 per 1M tokens",
              options={"reasoning_effort": "low"}),
    ModelSpec("openai", "gpt-6.2-astra", "GPT-6.2 Astra",
              note="Flagship, expensive · $8 / $40 per 1M tokens",
              options={"reasoning_effort": "low"}),

    # ── Ollama (chạy local, phải `ollama pull` trước) ─
    # think=False: trả JSON ngay, không tốn token cho thinking (model 4B chạy local).
    # num_ctx: Ollama mặc định context nhỏ; history nhiều iteration cần chỗ.
    ModelSpec("ollama", "qwen3.5:4b", "Qwen 3.5 4B", provider_default=True,
              note="Local · free · needs `ollama pull qwen3.5:4b`",
              max_output_tokens=8192, options={"num_ctx": 32768, "think": False}),
]

DEFAULT_PROVIDER = "anthropic"
DEFAULT_MODEL = "claude-sonnet-4-6"


class InvalidModelSelection(ValueError):
    """provider/model không có trong catalog (API trả 422)."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def models_for(provider: str) -> list[ModelSpec]:
    return [m for m in CATALOG if m.provider == provider]


def find(provider: str | None, model: str | None) -> ModelSpec | None:
    """Tra cứu đúng cặp provider/model đã lưu (không suy đoán). None nếu không còn trong catalog."""
    return next((m for m in CATALOG if m.provider == provider and m.id == model), None)


def default_spec() -> ModelSpec:
    spec = find(DEFAULT_PROVIDER, DEFAULT_MODEL)
    assert spec is not None, "DEFAULT_MODEL must be in CATALOG"
    return spec


def resolve(provider: str | None, model: str | None) -> ModelSpec:
    """
    Chuẩn hóa lựa chọn từ request:
      cả hai None        → default (Claude Sonnet 4.6) — client/CLI cũ không gửi gì
      chỉ provider       → model provider_default của provider đó
      chỉ model          → provider có model đó (nếu duy nhất)
      cả hai             → phải khớp đúng 1 dòng trong CATALOG
    Không có fallback ngầm: sai là raise InvalidModelSelection.
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
    """Tên hiển thị cho run đã lưu. Run cũ (provider NULL) giữ nguyên model đã lưu, không gán default."""
    spec = find(provider, model)
    info = PROVIDERS.get(provider or "")
    return {
        "provider_name": info.name if info else None,
        "model_name": spec.name if spec else None,
    }
