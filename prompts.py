"""
What the model is told: the system prompt and the conversation built from a run's history.

Pure functions of the run state. They never call a model, so they can be tested without one, and
tests/test_characterization.py pins their output. Changing any text here changes model behavior:
do it in its own commit, never together with a structural refactor.
"""

import json

from schemas import AgentState

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
