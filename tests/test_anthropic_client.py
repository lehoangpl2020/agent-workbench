"""The Anthropic SDK client the registry builds. OFFLINE: constructing a client sends no request."""

from model_catalog import models_for


def test_anthropic_client_retries_and_timeout_are_explicit():
    from llm_providers import ANTHROPIC_MAX_RETRIES, ANTHROPIC_TIMEOUT_SECONDS, ProviderRegistry, ProviderSettings
    from anthropic import DEFAULT_MAX_RETRIES

    registry = ProviderRegistry(ProviderSettings(anthropic_api_key="test-key"))
    registry.create(models_for("anthropic")[0])
    client = registry._anthropic
    assert (client.max_retries, client.timeout) == (ANTHROPIC_MAX_RETRIES, ANTHROPIC_TIMEOUT_SECONDS)
    assert ANTHROPIC_MAX_RETRIES == DEFAULT_MAX_RETRIES   # explicit, but not a behavior change
