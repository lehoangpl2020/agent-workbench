"""
What the model is told: the system prompt and the conversation built from a run's history.

Pure functions of the run state. They never call a model, so they can be tested without one, and
tests/test_characterization.py pins their output. Changing any text here changes model behavior:
do it in its own commit, never together with a structural refactor.
"""

import json

from agent_workbench.domain.schemas import AgentState

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

# Appended to SYSTEM_PROMPT only when the image tool is on (IMAGE_TOOL=true), so a default run sends exactly the
# text above. {max_images} and {timeout} are filled from the server settings and the run's own limits.
IMAGE_TOOL_PROMPT = """
## Image tool
Code cannot draw photos, illustrations, 3D-looking scenes or artwork. For those, ask the image model instead of
using matplotlib/Pillow drawing. Keep using code for charts, diagrams and anything built from data.

    import os, requests
    r = requests.post(os.environ["IMAGE_TOOL_URL"], timeout=200, json={{
        "prompt": "...", "size": "1024x1024", "quality": "medium", "filename": "cover.png"}})
    print(r.status_code, r.json())

- prompt: describe subject, style, lighting, camera angle and composition in detail (English works best).
- size: "1024x1024", "1536x1024" (landscape) or "1024x1536" (portrait). quality: "low", "medium" or "high".
  background: "transparent" for a cut-out. filename is optional; the PNG is saved in /workspace/output/.
- On success the JSON has path, filename, bytes and requests_left. On failure it has "detail": read it and change
  the prompt if it is a safety block. Do NOT use try/except to hide a failure.
- Each call costs money and takes 20-120 seconds. Make one image per code run, at most {max_images} requests in this
  run, and do not regenerate an image unless the user asked.
- This run's code timeout is {timeout}s. If it is below 120s a call will probably be killed: use quality "low" and,
  if it still times out, say in your answer that the user must raise the timeout.
"""


def system_prompt(*, image_tool_max: int | None = None, timeout_seconds: int = 30) -> str:
    """The system prompt for one model call. `image_tool_max` = requests allowed per run, None = tool is off."""
    if image_tool_max is None:
        return SYSTEM_PROMPT
    return SYSTEM_PROMPT + IMAGE_TOOL_PROMPT.format(max_images=image_tool_max, timeout=timeout_seconds)


# How much of a failed run's stderr the model gets back. A traceback ends with the line that names the error,
# so a long one is cut at the START, not the end.
MAX_STDERR_CHARS = 3000
TRUNCATION_NOTE = "[earlier output truncated]\n"


def _tail(text: str, limit: int) -> str:
    return text if len(text) <= limit else TRUNCATION_NOTE + text[-limit:]


def build_messages(state: AgentState) -> list[dict]:
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
                        f"STDERR:\n{_tail(result.stderr, MAX_STDERR_CHARS)}\n"
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
