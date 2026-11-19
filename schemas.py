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
    Trạng thái của một run. Giữ nguyên các giá trị cũ để client cũ không vỡ.

    UI hiển thị:
      success     → Completed              (model báo DONE sau ít nhất 1 lần chạy thành công)
      error       → Failed                 (lỗi planner / sandbox, không tự sửa được)
      stopped     → Stopped                (user bấm Stop)
      timeout     → Timed out              (hết lượt chạy code, lần chạy cuối bị timeout)
      max_retries → Code run limit reached (hết lượt chạy code mà model chưa báo DONE)
    Tên `max_retries` giữ nguyên vì là giá trị API cũ; ý nghĩa: đã dùng hết max_iterations lần chạy code.
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
        """Model báo DONE: không còn code cần chạy, yêu cầu đã xong."""
        return not self.code.strip() and self.explanation.strip().upper().startswith("DONE")


class ExecutionResult(BaseModel):
    stdout: str = ""
    stderr: str = ""
    exit_code: int = -1
    execution_time_ms: float = 0
    # {relative_path: "<file: N bytes>"} — file mới/đổi trong iteration này
    artifacts: dict[str, str] = Field(default_factory=dict)
    timed_out: bool = False
    # exit_code=0 nhưng stdout trông như lỗi (vd print("Error: ...")) → coi là lỗi
    false_success: bool = False
    # Lỗi hạ tầng (sandbox không chạy, image thiếu...) → LLM không sửa được → dừng loop
    system_error: bool = False


class AgentState(BaseModel):
    session_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    user_request: str = ""
    messages: list[dict] = Field(default_factory=list)
    generated_code: list[CodeBlock] = Field(default_factory=list)
    execution_results: list[ExecutionResult] = Field(default_factory=list)
    current_iteration: int = 0
    max_iterations: int = 5
    timeout_seconds: int = 30
    # Provider/model cố định cho cả run (mọi iteration, kể cả sửa lỗi và đánh giá DONE)
    provider: str = ""
    model: str = ""
    status: ExecutionStatus = ExecutionStatus.PENDING
    final_answer: str = ""
    # Giải thích ngắn vì sao run kết thúc (hiển thị ở UI)
    message: str = ""
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class AgentRequest(BaseModel):
    message: str = Field(min_length=1, max_length=20_000)
    session_id: Optional[str] = None
    # None → dùng default của server (MAX_ITERATIONS / EXECUTION_TIMEOUT).
    # max_iterations = số lần CHẠY CODE tối đa; model được gọi tối đa max_iterations + 1 lần
    # (lượt cuối chỉ để xem output và trả DONE). Tên field giữ nguyên để client cũ không vỡ.
    max_iterations: Optional[int] = Field(default=None, ge=1, le=20)
    timeout_seconds: Optional[int] = Field(default=None, ge=1, le=300)
    # None → default trong model_catalog.py (Claude Sonnet 4.6). Backend validate theo catalog.
    provider: Optional[str] = Field(default=None, max_length=64)
    model: Optional[str] = Field(default=None, max_length=128)


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
