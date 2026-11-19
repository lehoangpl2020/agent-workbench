"""
Activity log of a run: every real step of the agent → one entry
{ts, iteration, source, level, message, data}.

`source` tells who did it:
  runtime  the agent loop (application) decides / coordinates
  llm      a model API call: request sent, response received, timing, tokens, parsing
  model    what the model returned (a short explanation of its approach) — NOT a runtime action
  sandbox  the executor: writes files, runs code, installs packages, collects artifacts

Every message/data goes through redact() so API keys / secrets are never written to the log.
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
    re.compile(r"sk-[A-Za-z0-9_\-]{20,}"),              # sk-... style keys
    re.compile(r"(?i)(x-api-key|authorization)\s*[:=]\s*\S+"),
]
_SECRET_ENV = re.compile(r"(KEY|TOKEN|SECRET|PASSWORD)", re.IGNORECASE)


def _secret_values() -> list[str]:
    # Real values of sensitive environment variables (long enough not to mask ordinary words by mistake)
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


def format_log_line(e: dict) -> str:
    """One stored log entry as a line of text: time, iteration, level, source, message, data."""
    it = f"iter {e['iteration']}" if e.get("iteration") else "run"
    data = " ".join(f"{k}={v}" for k, v in (e.get("data") or {}).items())
    return f"{e['ts']}  {it:<7} {e['level']:<5} {e['source']:<7} {e['message']}" + (f"  [{data}]" if data else "")
