"""
LLM Planner — Component 1/3
Takes the user request + error context and generates Python code.
The model returns JSON {thinking, code, language}; the provider (Anthropic / OpenAI / Ollama) is
chosen from the run's ModelSpec and called through llm_providers.ChatClient — one shared contract.
"""

import logging
import time
from typing import Awaitable, Callable

from agent_workbench.domain.events import METRIC_LLM_CALL, Flow
from agent_workbench.llm import ChatClient, ProviderError, ProviderRegistry
from agent_workbench.llm.catalog import ModelSpec, default_spec
from agent_workbench.core.parsing import extract_partial_json_string, parse_response
from agent_workbench.core.prompts import build_messages, system_prompt
from agent_workbench.domain.schemas import CodeBlock, AgentState
from agent_workbench.observability.runlog import ERROR, INFO, WARN, LogFn, no_log

logger = logging.getLogger(__name__)

# How many times the LLM may retry after returning badly formatted JSON (a truncated response is not retried).
MAX_FORMAT_RETRIES = 1
# Warn when a prompt uses at least this share of the model's context window (Ollama `num_ctx`)
CONTEXT_WARN_RATIO = 0.9


# Callback while the model is streaming: (code_so_far, explanation_so_far)
ProgressFn = Callable[[str, str], Awaitable[None]]
# Do not report progress more often than this (seconds), so the UI/SQLite are not flooded with events
PROGRESS_INTERVAL = 0.4


def _call_timing(started: float, timing: dict[str, int]) -> dict[str, int]:
    """Timing of one model call in ms. first_token_ms is absent when no token arrived."""
    return {"duration_ms": round((time.monotonic() - started) * 1000), **timing}


class PlannerOutputError(Exception):
    """The LLM returned unusable output (truncated or malformed JSON)."""


class LLMPlanner:
    """
    One planner = one fixed provider/model. RunManager creates a new planner for every run
    (from the user's choice), so every iteration — writing, fixing, the DONE review —
    uses exactly that model.
    """

    def __init__(
        self,
        spec: ModelSpec | None = None,
        chat: ChatClient | None = None,
        registry: ProviderRegistry | None = None,
        max_output_tokens: int | None = None,
        image_tool_max: int | None = None,
    ):
        self.spec = spec or default_spec()
        # Requests allowed per run, or None when the server offers no image tool. The prompt only mentions the tool
        # for a run whose `state.image_tool` is set; any other run gets exactly SYSTEM_PROMPT.
        self.image_tool_max = image_tool_max
        # Only create the client of the selected provider (Ollama does not need an Anthropic key...)
        self.chat = chat or (registry or ProviderRegistry()).create(self.spec)
        self.model = self.spec.id
        self.provider = self.spec.provider
        # Long plotting code (~9k characters) + JSON escaping can exceed 4096 tokens → truncated → broken JSON.
        # `max_output_tokens` (MAX_OUTPUT_TOKENS) overrides every model; otherwise the catalog's value for this model.
        self.max_tokens = max_output_tokens or self.spec.max_output_tokens

    async def generate_code(
        self,
        state: AgentState,
        on_progress: ProgressFn | None = None,
        on_log: LogFn | None = None,
    ) -> CodeBlock:
        """
        Generates code from the user request + execution history.
        If the previous attempt failed, the error context is added to the messages
        so the LLM can fix it itself (feedback loop).

        Uses streaming: while the model is writing, on_progress receives the code so far
        (extracted from the incomplete JSON) so the UI can show code right away instead of waiting.
        """
        log = on_log or no_log
        messages = build_messages(state)

        for attempt in range(1 + MAX_FORMAT_RETRIES):
            logger.info(
                f"[{state.session_id}] Calling LLM (iteration {state.current_iteration}"
                f"{', format retry' if attempt else ''}), messages count: {len(messages)}"
            )
            await log(
                INFO, "llm",
                f"Calling {self.model}" + (" (format retry)" if attempt else ""),
                provider=self.provider, model=self.model,
                messages=len(messages), max_tokens=self.max_tokens, stream=True, flow=Flow.CALLING,
            )

            started = time.monotonic()
            timing: dict[str, int] = {}   # _stream fills first_token_ms when the first token arrives
            # `metric` marks this entry as the measurement of ONE model call (events.METRIC_LLM_CALL)
            try:
                response = await self._stream(messages, on_progress, log, started, state.timeout_seconds, timing,
                                              self.image_tool_max if state.image_tool else None)
            except ProviderError as e:
                await log(ERROR, "llm", f"Model call failed after {time.monotonic() - started:.1f}s: {e}",
                          provider=self.provider, model=self.model, error_kind=e.kind, http_status=e.status,
                          metric=METRIC_LLM_CALL, ok=False, attempt=attempt, **_call_timing(started, timing))
                raise
            except Exception as e:
                await log(ERROR, "llm", f"Model call failed after {time.monotonic() - started:.1f}s: "
                          f"{type(e).__name__}: {e}", provider=self.provider, model=self.model,
                          metric=METRIC_LLM_CALL, ok=False, attempt=attempt, **_call_timing(started, timing))
                raise
            content = response.text
            await log(INFO, "llm", f"Response received in {time.monotonic() - started:.1f}s",
                      stop_reason=response.stop_reason, chars=len(content), flow=Flow.RESPONSE,
                      metric=METRIC_LLM_CALL, ok=True, attempt=attempt, **_call_timing(started, timing),
                      **response.usage)
            await self._warn_if_context_nearly_full(response.usage, log)

            if response.stop == "refusal":
                await log(ERROR, "llm", f"Model declined the request (stop_reason={response.stop_reason})")
                raise PlannerOutputError(
                    f"The model declined this request (stop_reason={response.stop_reason}).")

            # A truncated response means the JSON is certainly broken, and a retry would give the same result
            # → stop immediately so more tokens are not burned.
            if response.stop == "max_tokens":
                await log(ERROR, "llm", f"Response truncated at max_tokens={self.max_tokens}")
                raise PlannerOutputError(
                    f"LLM response truncated at max_tokens={self.max_tokens}. "
                    "Raise MAX_OUTPUT_TOKENS or ask for a simpler task."
                )

            try:
                block = parse_response(content)
                if block.is_done:
                    await log(INFO, "llm", "Parsed response: model replied DONE (no code)", flow=Flow.PARSED)
                else:
                    await log(INFO, "llm", f"Parsed response: {block.language} code, "
                              f"{len(block.code.splitlines())} lines / {len(block.code):,} chars", flow=Flow.PARSED)
                return block
            except ValueError as e:
                logger.warning(
                    f"[{state.session_id}] Invalid LLM response format: {e}"
                )
                last = attempt >= MAX_FORMAT_RETRIES
                await log(ERROR if last else WARN, "llm", f"Could not parse response: {e}"
                          + ("" if last else " — asking the model to resend valid JSON"))
                if last:
                    raise PlannerOutputError(
                        f"LLM returned an invalid response after "
                        f"{attempt + 1} attempt(s): {e}"
                    ) from e
                # Give the LLM one chance to fix the format
                messages = messages + [
                    {"role": "assistant", "content": content or "(empty)"},
                    {
                        "role": "user",
                        "content": (
                            f"Your last reply was unusable: {e}. "
                            "Reply again with ONLY the JSON object "
                            '{"thinking": ..., "code": ..., "language": ...} '
                            "and no markdown fences."
                        ),
                    },
                ]

        raise PlannerOutputError("unreachable")  # pragma: no cover

    async def _warn_if_context_nearly_full(self, usage: dict, log: LogFn) -> None:
        """
        The history grows with every iteration and Ollama silently drops the start of a prompt that does not fit
        `num_ctx`. The provider reports how many prompt tokens it processed (a lower bound when part of the prompt
        was cached), so say so when that gets close to the window instead of leaving a mysteriously worse model.
        """
        window = self.spec.options.get("num_ctx")
        used = usage.get("input_tokens")
        if window and used and used >= CONTEXT_WARN_RATIO * window:
            await log(WARN, "llm", f"The prompt used {used:,} of the {window:,}-token context window (num_ctx): "
                      "the start of the conversation may have been cut off", input_tokens=used, num_ctx=window)

    async def _stream(self, messages: list[dict], on_progress: ProgressFn | None,
                      log: LogFn = no_log, started: float | None = None, timeout_seconds: int = 30,
                      timing: dict[str, int] | None = None, image_tool_max: int | None = None):
        """Calls the provider in streaming mode; on_progress receives code that is still being written (extracted from unclosed JSON)."""
        text = ""
        last_sent = 0.0
        started = started or time.monotonic()
        timing = timing if timing is not None else {}

        async def on_text(chunk: str) -> None:
            nonlocal text, last_sent
            if not text:
                timing["first_token_ms"] = round((time.monotonic() - started) * 1000)
                await log(INFO, "llm", f"First token after {time.monotonic() - started:.1f}s", flow=Flow.FIRST_TOKEN)
            text += chunk
            now = time.monotonic()
            if on_progress and now - last_sent >= PROGRESS_INTERVAL:
                last_sent = now
                code = extract_partial_json_string(text, "code")
                if code:
                    explanation = extract_partial_json_string(text, "thinking") or ""
                    await on_progress(code, explanation)

        system = system_prompt(image_tool_max=image_tool_max, timeout_seconds=timeout_seconds)
        return await self.chat.stream(system, messages, self.max_tokens, on_text)
