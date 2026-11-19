"""
LLM Planner — Component 1/3
Takes the user request + error context and generates Python code.
The model returns JSON {thinking, code, language}; the provider (Anthropic / OpenAI / Ollama) is
chosen from the run's ModelSpec and called through llm_providers.ChatClient — one shared contract.
"""

import json
import logging
import os
import re
import time
from typing import Awaitable, Callable

from llm_providers import ChatClient, ProviderError, ProviderRegistry
from model_catalog import ModelSpec, default_spec
from schemas import CodeBlock, AgentState
from runlog import ERROR, INFO, WARN, LogFn, no_log

logger = logging.getLogger(__name__)

# Long plotting code (~9k characters) + JSON escaping can exceed 4096 tokens → truncated → broken JSON.
# Env override for every model; when unset, the model's max_output_tokens from the catalog is used.
_MAX_OUTPUT_ENV = os.getenv("MAX_OUTPUT_TOKENS")
# How many times the LLM may retry after returning badly formatted JSON (a truncated response is not retried).
MAX_FORMAT_RETRIES = 1


# Callback while the model is streaming: (code_so_far, explanation_so_far)
ProgressFn = Callable[[str, str], Awaitable[None]]
# Do not report progress more often than this (seconds), so the UI/SQLite are not flooded with events
PROGRESS_INTERVAL = 0.4


class PlannerOutputError(Exception):
    """The LLM returned unusable output (truncated or malformed JSON)."""

SYSTEM_PROMPT = """\
You are a code execution agent. Your job is to solve the user's request 
by writing Python code that will be executed in a sandboxed environment.

## Rules
1. Write complete, self-contained, runnable Python code.
2. Always print() your final results to stdout.
3. Save any generated files (charts, images, CSVs, etc.) to /workspace/output/
   (this folder is private to the current run). Use a non-interactive backend for
   matplotlib (Agg) and never call plt.show().
4. Available packages: numpy, pandas, matplotlib, seaborn, scipy, scikit-learn, 
   requests, beautifulsoup4, openpyxl, Pillow, sympy, tabulate, plotly, xlsxwriter.
5. Let errors crash naturally (DON'T wrap everything in try/except).
   Only use try/except for specific, recoverable cases.
   If a file doesn't exist or data is missing, generate realistic sample data
   and proceed — don't just print "file not found" and exit.
6. If you're fixing a previous error, address the SPECIFIC error message.
7. Keep code concise — no unnecessary comments or boilerplate.
8. The code must finish within the execution time limit; avoid infinite loops
   and very long computations.
9. After a successful run you will see its output. Only reply DONE when the
   output fully satisfies the original request.

## Response Format
Respond ONLY with valid JSON (no markdown fences):
{
    "thinking": "one short sentence telling the user what this code does",
    "code": "your python code here",
    "language": "python"
}
"""


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
    ):
        self.spec = spec or default_spec()
        # Only create the client of the selected provider (Ollama does not need an Anthropic key...)
        self.chat = chat or (registry or ProviderRegistry()).create(self.spec)
        self.model = self.spec.id
        self.provider = self.spec.provider
        self.max_tokens = int(_MAX_OUTPUT_ENV) if _MAX_OUTPUT_ENV else self.spec.max_output_tokens

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
        messages = self._build_messages(state)

        for attempt in range(1 + MAX_FORMAT_RETRIES):
            logger.info(
                f"[{state.session_id}] Calling LLM (iteration {state.current_iteration}"
                f"{', format retry' if attempt else ''}), messages count: {len(messages)}"
            )
            await log(
                INFO, "llm",
                f"Calling {self.model}" + (" (format retry)" if attempt else ""),
                provider=self.provider, model=self.model,
                messages=len(messages), max_tokens=self.max_tokens, stream=True,
            )

            started = time.monotonic()
            try:
                response = await self._stream(messages, on_progress, log, started)
            except ProviderError as e:
                await log(ERROR, "llm", f"Model call failed after {time.monotonic() - started:.1f}s: {e}",
                          provider=self.provider, model=self.model, error_kind=e.kind, http_status=e.status)
                raise
            except Exception as e:
                await log(ERROR, "llm", f"Model call failed after {time.monotonic() - started:.1f}s: "
                          f"{type(e).__name__}: {e}", provider=self.provider, model=self.model)
                raise
            content = response.text
            await log(INFO, "llm", f"Response received in {time.monotonic() - started:.1f}s",
                      stop_reason=response.stop_reason, chars=len(content), **response.usage)

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
                block = self._parse_response(content)
                if block.is_done:
                    await log(INFO, "llm", "Parsed response: model replied DONE (no code)")
                else:
                    await log(INFO, "llm", f"Parsed response: {block.language} code, "
                              f"{len(block.code.splitlines())} lines / {len(block.code):,} chars")
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

    async def _stream(self, messages: list[dict], on_progress: ProgressFn | None,
                      log: LogFn = no_log, started: float | None = None):
        """Calls the provider in streaming mode; on_progress receives code that is still being written (extracted from unclosed JSON)."""
        text = ""
        last_sent = 0.0
        started = started or time.monotonic()

        async def on_text(chunk: str) -> None:
            nonlocal text, last_sent
            if not text:
                await log(INFO, "llm", f"First token after {time.monotonic() - started:.1f}s")
            text += chunk
            now = time.monotonic()
            if on_progress and now - last_sent >= PROGRESS_INTERVAL:
                last_sent = now
                code = extract_partial_json_string(text, "code")
                if code:
                    explanation = extract_partial_json_string(text, "thinking") or ""
                    await on_progress(code, explanation)

        return await self.chat.stream(SYSTEM_PROMPT, messages, self.max_tokens, on_text)

    def _build_messages(self, state: AgentState) -> list[dict]:
        """
        Builds the conversation history for the LLM.
        Pattern: user_request → [code → error_feedback]* → ...
        Each iteration adds one (assistant_code, user_feedback) pair.
        """
        messages = [{"role": "user", "content": state.user_request}]

        for i, (code, result) in enumerate(
            zip(state.generated_code, state.execution_results)
        ):
            # The LLM generated this code
            messages.append(
                {
                    "role": "assistant",
                    "content": json.dumps(
                        {
                            "thinking": code.explanation,
                            "code": code.code,
                            "language": code.language,
                        }
                    ),
                }
            )

            files_note = ""
            if result.artifacts:
                files = ", ".join(f"{p} {s}" for p, s in result.artifacts.items())
                files_note = f"Files created/updated in /workspace/output: {files}\n"

            # Feedback from the execution
            if result.timed_out:
                messages.append(
                    {
                        "role": "user",
                        "content": (
                            f"⏱ Execution TIMED OUT (attempt {i + 1}/{state.max_iterations}). "
                            f"The process was killed after {state.timeout_seconds}s.\n"
                            f"STDOUT before kill:\n{result.stdout[:1000]}\n\n"
                            "Rewrite the code so it finishes well within the time limit "
                            "(no infinite loops, smaller workloads)."
                        ),
                    }
                )
            elif result.exit_code != 0:
                messages.append(
                    {
                        "role": "user",
                        "content": (
                            f"❌ Execution FAILED (attempt {i + 1}/{state.max_iterations}).\n"
                            f"Exit code: {result.exit_code}\n"
                            f"STDERR:\n{result.stderr[:3000]}\n"
                            f"STDOUT:\n{result.stdout[:1000]}\n\n"
                            "Fix the error and try again. "
                            "Focus on the specific error above."
                        ),
                    }
                )
            else:
                # The code ran OK but may need more steps
                no_runs_left = i + 1 >= state.max_iterations
                next_step = (
                    "This was the last allowed code run: any code you send now will NOT be executed. "
                    "If the output does not fully answer the request, reply with the code you would "
                    "run next and say in thinking what is still missing."
                    if no_runs_left else
                    "Otherwise, generate code for the next step."
                )
                messages.append(
                    {
                        "role": "user",
                        "content": (
                            f"✅ Code executed successfully (attempt {i + 1}/{state.max_iterations}).\n"
                            f"Output:\n{result.stdout[:3000]}\n"
                            f"{files_note}\n"
                            "If this fully answers the original request, "
                            "respond with the same JSON format but set "
                            'thinking to "DONE" and code to an empty string. '
                            f"{next_step}"
                        ),
                    }
                )

        return messages

    def _parse_response(self, content: str) -> CodeBlock:
        """
        Parses the JSON response from the LLM.
        Raises ValueError if it is unusable — does NOT return the raw text as code,
        because running broken JSON as Python only produces a SyntaxError.
        """
        # Strip markdown fences if the LLM still added them
        cleaned = content.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.split("\n", 1)[1]
        if cleaned.endswith("```"):
            cleaned = cleaned.rsplit("```", 1)[0]
        cleaned = cleaned.strip()

        try:
            parsed = json.loads(cleaned)
        except json.JSONDecodeError as e:
            raise ValueError(f"not valid JSON ({e.msg} at char {e.pos})") from e

        if not isinstance(parsed, dict):
            raise ValueError("JSON root must be an object")

        code = parsed.get("code", "")
        thinking = parsed.get("thinking", "")
        if not isinstance(code, str) or not isinstance(thinking, str):
            raise ValueError('"code" and "thinking" must be strings')

        # empty code is only valid when the LLM says DONE
        if not code.strip() and not thinking.strip().upper().startswith("DONE"):
            raise ValueError('"code" is empty but thinking is not "DONE"')

        return CodeBlock(
            language=parsed.get("language", "python"),
            code=code,
            explanation=thinking,
        )


_ESCAPES = {"n": "\n", "t": "\t", "r": "\r", "b": "\b", "f": "\f", '"': '"', "\\": "\\", "/": "/"}


def extract_partial_json_string(text: str, key: str) -> str | None:
    """
    Gets the value (possibly unclosed) of "key": "..." in JSON that is still streaming.
    Vd text = '{"thinking": "Plot", "code": "import ma'  → key "code" → 'import ma'.
    Stops at the closing quote of the string or at an incomplete escape. Returns None if the key is not found yet.
    """
    m = re.search(r'"%s"\s*:\s*"' % re.escape(key), text)
    if not m:
        return None
    s, out, i = text[m.end():], [], 0
    while i < len(s):
        c = s[i]
        if c == '"':
            break
        if c != "\\":
            out.append(c)
            i += 1
            continue
        if i + 1 >= len(s):
            break  # escape cut off in the middle
        n = s[i + 1]
        if n == "u":
            if i + 6 > len(s):
                break
            try:
                out.append(chr(int(s[i + 2 : i + 6], 16)))
            except ValueError:
                pass
            i += 6
            continue
        out.append(_ESCAPES.get(n, n))
        i += 2
    # Join surrogate pairs (emoji 🐝) and drop lone surrogates
    # so that saving to SQLite / sending JSON does not fail
    joined = "".join(out)
    return joined.encode("utf-16", "surrogatepass").decode("utf-16", "replace")

