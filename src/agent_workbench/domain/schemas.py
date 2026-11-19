"""
Data models for Code Execution Agent.
"""

from pydantic import BaseModel, Field
from enum import Enum
from typing import Optional
from datetime import datetime, timezone
import uuid


class ExecutionStatus(str, Enum):
    """
    State of a run. The old values are kept as they are so that older clients do not break.

    What the UI shows:
      success     → Completed              (the model said DONE after at least one successful code run)
      error       → Failed                 (planner / sandbox error that cannot be fixed automatically)
      stopped     → Stopped                (the user pressed Stop)
      timeout     → Timed out              (code-run limit reached and the last run timed out)
      max_retries → Code run limit reached (code-run limit reached and the model has not said DONE)
    The name `max_retries` is kept because it is an existing API value; it means all max_iterations code runs were used.
    """

    PENDING = "pending"
    RUNNING = "running"
    SUCCESS = "success"
    ERROR = "error"
    TIMEOUT = "timeout"
    MAX_RETRIES = "max_retries"
    STOPPED = "stopped"


TERMINAL_STATUSES = {
    ExecutionStatus.SUCCESS,
    ExecutionStatus.ERROR,
    ExecutionStatus.TIMEOUT,
    ExecutionStatus.MAX_RETRIES,
    ExecutionStatus.STOPPED,
}


class CodeBlock(BaseModel):
    language: str = "python"
    code: str
    explanation: str = ""

    @property
    def is_done(self) -> bool:
        """The model said DONE: no more code to run, the request is complete."""
        return not self.code.strip() and self.explanation.strip().upper().startswith("DONE")


class ExecutionResult(BaseModel):
    stdout: str = ""
    stderr: str = ""
    exit_code: int = -1
    execution_time_ms: float = 0
    # {relative_path: "<file: N bytes>"} — files created/changed in this iteration
    artifacts: dict[str, str] = Field(default_factory=dict)
    timed_out: bool = False
    # exit_code=0 but stdout looks like an error (e.g. print("Error: ...")) → treated as a failure
    false_success: bool = False
    # Infrastructure error (sandbox not running, image missing...) → the LLM cannot fix it → stop the loop
    system_error: bool = False


class AgentState(BaseModel):
    session_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    user_request: str = ""
    generated_code: list[CodeBlock] = Field(default_factory=list)
    execution_results: list[ExecutionResult] = Field(default_factory=list)
    current_iteration: int = 0
    max_iterations: int = 5
    timeout_seconds: int = 30
    # Provider/model fixed for the whole run (every iteration, including fixes and the DONE review)
    provider: str = ""
    model: str = ""
    # The user ticked "Image tool" for this run: the prompt mentions it and its endpoint accepts this run's calls
    image_tool: bool = False
    status: ExecutionStatus = ExecutionStatus.PENDING
    final_answer: str = ""
    # Short explanation of why the run ended (shown in the UI)
    message: str = ""
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class AgentRequest(BaseModel):
    message: str = Field(min_length=1, max_length=20_000)
    session_id: Optional[str] = None
    # None → use the server default (MAX_ITERATIONS / EXECUTION_TIMEOUT).
    # max_iterations = max number of CODE RUNS; the model is called at most max_iterations + 1 times
    # (the last turn only reviews the output and answers DONE). The field name is kept so older clients do not break.
    max_iterations: Optional[int] = Field(default=None, ge=1, le=20)
    timeout_seconds: Optional[int] = Field(default=None, ge=1, le=300)
    # None → the default in model_catalog.py (Ollama qwen3.5:4b). The backend validates against the catalog.
    provider: Optional[str] = Field(default=None, max_length=64)
    model: Optional[str] = Field(default=None, max_length=128)
    # Opt-in per run (default off): lets the code of this run ask the OpenAI image model for pictures. Billed by OpenAI.
    image_tool: Optional[bool] = None


class AgentResponse(BaseModel):
    session_id: str
    status: ExecutionStatus
    answer: str
    message: str = ""
    code_blocks: list[CodeBlock] = []
    execution_results: list[ExecutionResult] = []
    iterations: int = 0
    provider: str = ""
    model: str = ""
