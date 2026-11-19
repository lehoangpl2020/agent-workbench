"""
Application settings, read from environment variables in ONE place.

`Settings.from_env()` is called once when the app starts (api/app.py) and the result is passed to the parts
that need it. Nothing else reads these variables, so what the server runs with can be seen (and tested) by
building a Settings. Provider keys and URLs are read the same way into `ProviderSettings` (llm/base.py)
and are never copied here, so Settings can be logged without leaking a secret.

Not in here on purpose: redaction (observability/runlog.py) reads the live environment every time, because it must mask
the values that are set when a message is logged, not the ones that were set at startup.
"""

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping

from agent_workbench.tools.image import DEFAULT_MAX_PER_RUN, DEFAULT_MODEL as DEFAULT_IMAGE_MODEL, ImageToolSettings
from agent_workbench.llm import ProviderSettings
from agent_workbench.runs.metrics import load_pricing

# The repository root (src/agent_workbench/config.py → ../..): default home of data/ and static/
BASE_DIR = Path(__file__).resolve().parents[2]

DEFAULT_CORS_ORIGINS = "http://localhost:5173,http://127.0.0.1:5173"


def _flag(value: str) -> bool:
    return value.strip().lower() in ("true", "1", "yes")


def _int(env: Mapping[str, str], name: str, default: int) -> int:
    raw = env.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError:
        raise ValueError(f"{name} must be an integer, got {raw!r}") from None


@dataclass(frozen=True)
class Settings:
    # Execution
    use_docker: bool
    sandbox_mode: str                 # ephemeral | persistent (only used with use_docker)
    sandbox_container_name: str
    sandbox_runs_dir: str             # the runs directory as seen from inside the sandbox
    local_python: str | None          # Python used by LocalExecutor; None = the server's own
    # Limits (a request may override the first two, within server.LIMITS)
    max_iterations: int
    execution_timeout: int
    max_output_tokens: int | None     # None = each model's own limit from the catalog
    # Storage
    data_dir: Path
    db_path: Path
    runs_dir: Path
    static_dir: Path
    # Network. The server runs model-written code and has no auth: listen on this machine only by default.
    host: str
    port: int
    # Origins allowed to call the API from a browser. The built UI is served from the same origin as the API, so it
    # needs no CORS; only the Vite dev server (:5173) does.
    cors_origins: tuple[str, ...]
    providers: ProviderSettings
    image_tool: ImageToolSettings     # opt-in tool: the code in the sandbox asks the server for an image (tools/image.py)
    # Cost estimate (runs/metrics.py): USD per 1M tokens, keyed "provider/model". Empty = tokens and time only; the code has no prices.
    model_pricing: Mapping[str, Mapping[str, float]] = field(default_factory=dict)
    model_pricing_warnings: tuple[str, ...] = ()   # why part of MODEL_PRICING was ignored; api/app.py logs them at startup

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None, base_dir: Path = BASE_DIR) -> "Settings":
        env = os.environ if env is None else env
        data_dir = Path(env.get("DATA_DIR") or base_dir / "data")
        max_output = env.get("MAX_OUTPUT_TOKENS")
        port = _int(env, "PORT", 8668)
        pricing, pricing_warnings = load_pricing(env.get("MODEL_PRICING"))
        return cls(
            use_docker=_flag(env.get("USE_DOCKER", "false")),
            sandbox_mode=env.get("SANDBOX_MODE", "ephemeral"),
            sandbox_container_name=env.get("SANDBOX_CONTAINER_NAME", "agent-workbench-sandbox"),
            sandbox_runs_dir=env.get("SANDBOX_RUNS_DIR", "/workspace/runs"),
            local_python=env.get("LOCAL_PYTHON") or None,
            max_iterations=_int(env, "MAX_ITERATIONS", 5),
            execution_timeout=_int(env, "EXECUTION_TIMEOUT", 30),
            max_output_tokens=_int(env, "MAX_OUTPUT_TOKENS", 0) if max_output else None,
            data_dir=data_dir,
            db_path=Path(env.get("DB_PATH") or data_dir / "agent.db"),
            runs_dir=Path(env.get("RUNS_DIR") or data_dir / "runs"),
            static_dir=Path(env.get("STATIC_DIR") or base_dir / "static"),
            host=env.get("HOST", "127.0.0.1"),
            port=port,
            cors_origins=tuple(o.strip() for o in env.get("CORS_ORIGINS", DEFAULT_CORS_ORIGINS).split(",") if o.strip()),
            providers=ProviderSettings.from_env(env),
            image_tool=ImageToolSettings(
                enabled=_flag(env.get("IMAGE_TOOL", "false")),
                model=env.get("IMAGE_MODEL") or DEFAULT_IMAGE_MODEL,
                url=(env.get("IMAGE_TOOL_URL") or f"http://127.0.0.1:{port}").rstrip("/"),
                max_per_run=_int(env, "IMAGE_MAX_PER_RUN", DEFAULT_MAX_PER_RUN),
            ),
            model_pricing=pricing,
            model_pricing_warnings=tuple(pricing_warnings),
        )
