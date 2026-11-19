"""
LLM Planner — Component 1/3
Nhận yêu cầu từ user + error context, sinh ra Python code.
Model trả JSON {thinking, code, language}; provider (Anthropic / OpenAI / Ollama) được
chọn theo ModelSpec của run và gọi qua llm_providers.ChatClient — cùng 1 contract.
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

# Code vẽ hình dài (~9k ký tự) + JSON-escape vượt 4096 token → bị cắt cụt → JSON hỏng.
# Env ghi đè cho mọi model; không đặt thì dùng max_output_tokens của model trong catalog.
_MAX_OUTPUT_ENV = os.getenv("MAX_OUTPUT_TOKENS")
# Số lần cho LLM sửa lại khi trả JSON sai format (không tính trường hợp bị cắt cụt).
MAX_FORMAT_RETRIES = 1


# Gọi lại khi model đang stream: (code_đến_giờ, explanation_đến_giờ)
ProgressFn = Callable[[str, str], Awaitable[None]]
# Không gửi tiến độ dày hơn mức này (giây) để UI/SQLite không bị dội event
PROGRESS_INTERVAL = 0.4


class PlannerOutputError(Exception):
    """LLM trả output không dùng được (bị cắt cụt hoặc sai format JSON)."""

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
    1 planner = 1 provider/model cố định. RunManager tạo planner mới cho mỗi run
    (theo lựa chọn của user), nên mọi iteration — viết, sửa lỗi, đánh giá DONE —
    đều dùng đúng model đó.
    """

    def __init__(
        self,
        spec: ModelSpec | None = None,
        chat: ChatClient | None = None,
        registry: ProviderRegistry | None = None,
    ):
        self.spec = spec or default_spec()
        # Chỉ tạo client của provider được chọn (Ollama không cần Anthropic key...)
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
        Sinh code dựa trên user request + lịch sử execution.
        Nếu lần trước lỗi, error context được đưa vào messages
        để LLM tự sửa (feedback loop).

        Dùng streaming: khi model đang viết, on_progress nhận phần code đã có
        (bóc từ JSON chưa hoàn chỉnh) để UI hiện code ngay, không phải chờ hết.
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

            # Bị cắt cụt thì JSON chắc chắn hỏng, và retry sẽ ra cùng kết quả
            # → dừng ngay để khỏi đốt thêm token.
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
                # Cho LLM một cơ hội sửa lại đúng format
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
        """Gọi provider ở chế độ stream; on_progress nhận code đang viết dở (bóc từ JSON chưa đóng)."""
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
        Xây dựng conversation history cho LLM.
        Pattern: user_request → [code → error_feedback]* → ...
        Mỗi iteration thêm 1 cặp (assistant_code, user_feedback).
        """
        messages = [{"role": "user", "content": state.user_request}]

        for i, (code, result) in enumerate(
            zip(state.generated_code, state.execution_results)
        ):
            # LLM đã sinh code này
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

            # Feedback từ execution
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
                # Code chạy OK nhưng có thể cần thêm bước
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
        Parse JSON response từ LLM.
        Raise ValueError nếu không dùng được — KHÔNG trả raw text làm code,
        vì chạy chuỗi JSON hỏng như Python chỉ sinh SyntaxError.
        """
        # Strip markdown fences nếu LLM vẫn thêm
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

        # code rỗng chỉ hợp lệ khi LLM báo DONE
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
    Lấy giá trị (có thể chưa đóng) của "key": "..." trong JSON đang stream dở.
    Vd text = '{"thinking": "Plot", "code": "import ma'  → key "code" → 'import ma'.
    Dừng ở dấu " đóng chuỗi hoặc ở escape chưa đủ ký tự. Trả None nếu chưa thấy key.
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
            break  # escape bị cắt giữa chừng
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
    # Ghép cặp surrogate (emoji 🐝) và bỏ surrogate lẻ đang dở
    # để lưu SQLite / gửi JSON không lỗi
    joined = "".join(out)
    return joined.encode("utf-16", "surrogatepass").decode("utf-16", "replace")

