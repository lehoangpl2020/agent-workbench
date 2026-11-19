"""
LLM adapters: the model catalog and one ChatClient per provider.

    catalog.py         providers, models, the default model (pure data)
    base.py            the contract: ChatClient, ChatResult, ProviderError + error kinds, ProviderSettings
    anthropic_chat.py  AnthropicChat (official SDK)
    openai_chat.py     OpenAIChat (Responses API over httpx)
    ollama_chat.py     OllamaChat (native API over httpx)
    registry.py        ProviderRegistry: readiness, preflight, create(spec) -> ChatClient

A new provider = a catalog entry + one <name>_chat.py that implements ChatClient + one line in the
registry's factory table. The planner only ever sees ChatClient.
"""

from agent_workbench.llm.base import (
    AUTH,
    BAD_REQUEST,
    CONNECTION,
    MODEL_NOT_FOUND,
    MODEL_NOT_PULLED,
    NOT_CONFIGURED,
    PERMISSION,
    PROVIDER_ERROR,
    RATE_LIMIT,
    RESPONSE_SCHEMA,
    TIMEOUT,
    ChatClient,
    ChatResult,
    ProviderError,
    ProviderSettings,
)
from agent_workbench.llm.anthropic_chat import ANTHROPIC_MAX_RETRIES, ANTHROPIC_TIMEOUT_SECONDS, AnthropicChat
from agent_workbench.llm.ollama_chat import OllamaChat
from agent_workbench.llm.openai_chat import OpenAIChat
from agent_workbench.llm.registry import ProviderRegistry

__all__ = [
    "ANTHROPIC_MAX_RETRIES", "ANTHROPIC_TIMEOUT_SECONDS", "AUTH", "BAD_REQUEST", "CONNECTION", "MODEL_NOT_FOUND",
    "MODEL_NOT_PULLED", "NOT_CONFIGURED", "PERMISSION", "PROVIDER_ERROR", "RATE_LIMIT", "RESPONSE_SCHEMA", "TIMEOUT",
    "AnthropicChat", "ChatClient", "ChatResult", "OllamaChat", "OpenAIChat", "ProviderError", "ProviderRegistry",
    "ProviderSettings",
]
