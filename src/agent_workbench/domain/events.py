"""
The contract between the agent loop, the persistence layer (runs.py), the SSE stream and the web UI.

Everything that crosses a module boundary as a bare string or dict is named here:
  - Event: names of the events passed to `emit(event, data)` and sent over SSE;
  - Flow: the `flow` tag in a log entry's data, which the UI uses to place a step in Live Flow / Replay;
  - the payload of each event, as TypedDicts (documentation, plus tests/test_event_contract.py);
  - the text form of an artifact size, which is stored, sent to the model and parsed back.

web/src/lib/api.ts mirrors Event (SSE_EVENTS) and Flow (FLOWS); a test compares both sides, so adding a
name here without adding it there fails the build instead of silently breaking the UI.
Only ADD events, flows and payload keys. Never change the meaning of an old one (AGENTS.md, invariant 5).
"""

import re
from typing import Any, NotRequired, TypedDict


class Event:
    """Event names. The first five are the legacy events that old clients rely on."""

    SESSION = "session"
    ITERATION = "iteration"
    CODE = "code"
    RESULT = "result"
    MODEL_DONE = "model_done"
    ERROR = "error"
    DONE = "done"
    # Added later
    STATUS = "status"
    ACTIVITY = "activity"
    CODE_PROGRESS = "code_progress"
    LOG = "log"


# Same order as SSE_EVENTS in web/src/lib/api.ts
EVENTS = (
    Event.SESSION, Event.STATUS, Event.ITERATION, Event.CODE, Event.RESULT, Event.MODEL_DONE,
    Event.ACTIVITY, Event.CODE_PROGRESS, Event.LOG, Event.ERROR, Event.DONE,
)


class Flow:
    """`flow` tags in log data. A log entry without one is a plain note. Runs recorded before a tag existed have no
    tag on those entries; the UI still recognizes them (web/src/lib/studio.ts, legacyFlow)."""

    STARTED = "started"
    WRITE = "write"
    FIX = "fix"
    REVIEW = "review"
    CODE = "code"
    DONE_REPLY = "done_reply"
    EXECUTING = "executing"
    INSTALLING = "installing"
    RERUNNING = "rerunning"
    INSTALL_FAILED = "install_failed"
    ARTIFACTS = "artifacts"
    CHECKING = "checking"
    RESULT = "result"
    FINISHED = "finished"
    # Added so the UI no longer has to recognize these steps by their message text
    ITERATION = "iteration"
    CALLING = "calling"
    FIRST_TOKEN = "first_token"
    RESPONSE = "response"
    PARSED = "parsed"
    HANDOFF = "handoff"
    EXITED = "exited"
    KILLED = "killed"
    NO_FILES = "no_files"
    STOP = "stop"


# Same order as FLOWS in web/src/lib/api.ts
FLOWS = (
    Flow.STARTED, Flow.WRITE, Flow.FIX, Flow.REVIEW, Flow.CODE, Flow.DONE_REPLY, Flow.EXECUTING,
    Flow.INSTALLING, Flow.RERUNNING, Flow.INSTALL_FAILED, Flow.ARTIFACTS, Flow.CHECKING, Flow.RESULT,
    Flow.FINISHED, Flow.ITERATION, Flow.CALLING, Flow.FIRST_TOKEN, Flow.RESPONSE, Flow.PARSED, Flow.HANDOFF,
    Flow.EXITED, Flow.KILLED, Flow.NO_FILES, Flow.STOP,
)


# ─── Log data that metrics.py aggregates ──────────────────────────
# planner.py writes exactly ONE `source="llm"` log per model call (successful or failed) with this value under the
# `metric` key of its data, plus ok, attempt (> 0 = resent after invalid JSON), duration_ms, first_token_ms and the
# token counts the provider reported. metrics.summarize_run() counts by this tag, not by message text, so rewording
# a message cannot change a run's totals. Only ADD keys; a run stored before the tag existed has no measured calls.
METRIC_LLM_CALL = "llm_call"


# ─── Payloads (what `emit(event, data)` receives) ─────────────────
class SessionEvent(TypedDict):
    session_id: str
    max_iterations: int
    timeout_seconds: int
    provider: str
    model: str


class IterationEvent(TypedDict):
    iteration: int
    phase: str                      # "planning" | "executing"
    intent: NotRequired[str]        # planning only: write | fix | review
    detail: NotRequired[str]        # planning only: e.g. the error being fixed


class ActivityEvent(TypedDict):
    iteration: int
    phase: str
    text: str
    at: NotRequired[str]            # added by RunManager when it stores the activity


class CodeProgressEvent(TypedDict):
    iteration: int
    code: str
    explanation: str
    chars: int


class CodeEvent(TypedDict):
    iteration: int
    language: str
    code: str
    code_preview: str
    explanation: str


class ResultEvent(TypedDict):
    iteration: int
    exit_code: int
    stdout: str
    stderr: str
    stdout_preview: str
    stderr_preview: str
    time_ms: float
    timed_out: bool
    false_success: bool
    artifacts: dict[str, str]       # {path: artifact_label(size)}


class ModelDoneEvent(TypedDict):
    iteration: int
    explanation: str


class ErrorEvent(TypedDict):
    message: str


class LogEvent(TypedDict):
    ts: str
    iteration: int | None
    source: str                     # runtime | llm | model | sandbox
    level: str                      # INFO | WARN | ERROR
    message: str
    data: dict[str, Any]
    id: NotRequired[int]            # added by RunManager when it stores the entry


class StatusEvent(TypedDict):
    session_id: str
    status: str


class DoneEvent(TypedDict):
    """AgentResponse as JSON. A run that already finished replays a shorter form (see server.run_events)."""

    session_id: str
    status: str
    answer: str
    message: str
    code_blocks: list[dict]
    execution_results: list[dict]
    iterations: int
    provider: str
    model: str


PAYLOADS: dict[str, type] = {
    Event.SESSION: SessionEvent, Event.ITERATION: IterationEvent, Event.ACTIVITY: ActivityEvent,
    Event.CODE_PROGRESS: CodeProgressEvent, Event.CODE: CodeEvent, Event.RESULT: ResultEvent,
    Event.MODEL_DONE: ModelDoneEvent, Event.ERROR: ErrorEvent, Event.LOG: LogEvent,
    Event.STATUS: StatusEvent, Event.DONE: DoneEvent,
}


# ─── Artifact size, in text form ──────────────────────────────────
# `ExecutionResult.artifacts` is {path: "<file: N bytes>"}. The same text is stored, returned by the legacy
# API and shown to the model in the next prompt, so its format is part of the prompt (prompts.py).
_ARTIFACT_SIZE = re.compile(r"(\d+)")


def artifact_label(size: int) -> str:
    return f"<file: {size} bytes>"


def artifact_size(label: str) -> int:
    match = _ARTIFACT_SIZE.search(label)
    return int(match.group(1)) if match else 0
