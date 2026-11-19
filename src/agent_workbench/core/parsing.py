"""
What comes back from the model: validate the JSON reply and extract code that is still being streamed.

Pure functions, no model calls and no I/O.
"""

import json
import re

from agent_workbench.domain.schemas import CodeBlock


def parse_response(content: str) -> CodeBlock:
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
