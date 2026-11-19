"""Settings: defaults, parsing and the safe-by-default values. Pure: no environment is read."""

from pathlib import Path

import pytest

from agent_workbench.config import Settings
from agent_workbench.execution.executors import LocalExecutor
from agent_workbench.core.planner import LLMPlanner
from agent_workbench.llm.catalog import find


def settings(**env):
    return Settings.from_env(env, base_dir=Path("/app"))


def test_defaults():
    s = settings()
    assert (s.use_docker, s.sandbox_mode, s.max_iterations, s.execution_timeout) == (False, "ephemeral", 5, 30)
    assert (s.host, s.port) == ("127.0.0.1", 8668)
    assert s.max_output_tokens is None and s.local_python is None
    assert s.db_path == Path("/app/data/agent.db") and s.runs_dir == Path("/app/data/runs")
    assert s.static_dir == Path("/app/static")
    assert s.cors_origins == ("http://localhost:5173", "http://127.0.0.1:5173")


def test_cors_never_contains_a_wildcard_by_default():
    assert "*" not in settings().cors_origins


def test_overrides_and_paths_follow_data_dir():
    s = settings(USE_DOCKER="Yes", SANDBOX_MODE="persistent", DATA_DIR="/d", MAX_ITERATIONS="9", PORT="9000",
                 CORS_ORIGINS=" http://a.test , ,http://b.test", MAX_OUTPUT_TOKENS="2048", LOCAL_PYTHON="/py")
    assert s.use_docker and s.sandbox_mode == "persistent" and s.max_iterations == 9 and s.port == 9000
    assert s.db_path == Path("/d/agent.db") and s.runs_dir == Path("/d/runs")
    assert s.cors_origins == ("http://a.test", "http://b.test")
    assert s.max_output_tokens == 2048 and s.local_python == "/py"
    assert settings(DB_PATH="/x/y.db", RUNS_DIR="/r").db_path == Path("/x/y.db")


@pytest.mark.parametrize("value, expected", [("true", True), ("1", True), ("no", False), ("", False)])
def test_use_docker_flag(value, expected):
    assert settings(USE_DOCKER=value).use_docker is expected


def test_bad_integer_names_the_variable():
    with pytest.raises(ValueError, match="MAX_ITERATIONS"):
        settings(MAX_ITERATIONS="many")


def test_provider_settings_come_from_the_same_mapping():
    s = settings(OLLAMA_BASE_URL="http://ollama.test:1/", OPENAI_API_KEY="k")
    assert s.providers.ollama_base_url == "http://ollama.test:1" and s.providers.openai_api_key == "k"


def test_output_token_override_is_passed_in_not_read_from_the_environment(monkeypatch):
    monkeypatch.setenv("MAX_OUTPUT_TOKENS", "1")
    spec = find("ollama", "qwen3.5:4b")
    chat = object()
    assert LLMPlanner(spec, chat=chat).max_tokens == spec.max_output_tokens
    assert LLMPlanner(spec, chat=chat, max_output_tokens=777).max_tokens == 777


def test_local_executor_python_is_passed_in_not_read_from_the_environment(monkeypatch):
    import sys
    monkeypatch.setenv("LOCAL_PYTHON", "/nonexistent")
    assert LocalExecutor().python == sys.executable
    assert LocalExecutor(python="/py").python == "/py"
