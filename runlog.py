"""
Activity log của một run: mỗi bước thật của agent → 1 entry
{ts, iteration, source, level, message, data}.

source cho biết AI/ai làm:
  runtime  agent loop (application) quyết định / điều phối
  llm      lời gọi Claude API: gửi request, nhận response, thời gian, tokens, parse
  model    nội dung model trả về (giải thích ngắn về cách làm) — KHÔNG phải hành động runtime
  sandbox  executor: ghi file, chạy code, cài package, thu artifacts

Mọi message/data đi qua redact() để không bao giờ ghi API key / secret vào log.
"""

import os
import re
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

INFO, WARN, ERROR = "INFO", "WARN", "ERROR"

# log(level, source, message, **data)
LogFn = Callable[..., Awaitable[None]]

_SECRET_PATTERNS = [
    re.compile(r"sk-ant-[A-Za-z0-9_\-]{8,}"),           # Anthropic key
    re.compile(r"sk-[A-Za-z0-9_\-]{20,}"),              # các key kiểu sk-...
    re.compile(r"(?i)(x-api-key|authorization)\s*[:=]\s*\S+"),
]
_SECRET_ENV = re.compile(r"(KEY|TOKEN|SECRET|PASSWORD)", re.IGNORECASE)


def _secret_values() -> list[str]:
    # Giá trị thật của biến môi trường nhạy cảm (đủ dài để không che nhầm chữ thường)
    return [v for k, v in os.environ.items() if _SECRET_ENV.search(k) and v and len(v) >= 8]


def redact(value: Any) -> Any:
    if isinstance(value, str):
        for secret in _secret_values():
            value = value.replace(secret, "***")
        for pattern in _SECRET_PATTERNS:
            value = pattern.sub("***", value)
        return value
    if isinstance(value, dict):
        return {k: redact(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [redact(v) for v in value]
    return value


def now_ms() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def make_entry(iteration: int | None, level: str, source: str, message: str, **data) -> dict:
    return {
        "ts": now_ms(),
        "iteration": iteration,
        "source": source,
        "level": level,
        "message": redact(message),
        "data": redact({k: v for k, v in data.items() if v is not None}),
    }


async def _no_log(*args, **kwargs) -> None:
    return None


no_log: LogFn = _no_log


def fmt_bytes(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f} KB"
    return f"{n / 1024 / 1024:.1f} MB"
