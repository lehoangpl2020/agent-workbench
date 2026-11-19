# Kiến trúc Agent Workbench

Ghi chú để lần theo code. Cơ chế Code Execution Agent của bài học giữ nguyên: **Plan → Execute → Evaluate → Retry/Done**.

## Thành phần

| File | Vai trò | Ai quyết định |
|---|---|---|
| `planner.py` | Gọi model của run (Claude / OpenAI / Ollama qua `llm_providers.py`, catalog ở `model_catalog.py`) ở chế độ stream → JSON `{thinking, code, language}`. 1 planner cố định cho cả run. Stream phần code đang viết qua `on_progress`. | **Model**: viết code gì, khi nào trả lời `DONE` |
| `executor.py` | Chạy code: `LocalExecutor` / `SandboxExecutor` (container mới) / `PersistentSandboxExecutor` (`docker exec`). Timeout thật, kill khi Stop, auto `pip install`, thu artifacts. | Application |
| `agent.py` | **Agent loop duy nhất** `CodeAgent.run()`. Phát event qua `emit(event, data)`. Quyết định trạng thái cuối. | Application |
| `runs.py` | `RunManager`: chạy loop như background task, 1 run một lúc, Stop = `task.cancel()`, chuyển event → SQLite + SSE. | Application |
| `store.py` | SQLite (`runs`, `iterations`, `run_logs`): lịch sử + activity log sống qua restart. | — |
| `runlog.py` | Tạo log entry `{ts, iteration, source, level, message, data}`, che secret. | — |
| `workspace.py` | Thư mục riêng mỗi run + chặn path traversal khi đọc artifact. | — |
| `server.py` | FastAPI: Run API, API cũ (`/api/execute`, `/stream`), phục vụ Web UI. | — |
| `web/` | React + TS + Vite + Tailwind + shadcn/ui. Đọc state từ API, SSE chỉ là tín hiệu để refetch. | — |

## Luồng một run

```text
UI  POST /api/runs ─► RunManager.start() ─► asyncio.Task( CodeAgent.run(emit) )
                                                    │
   ┌──────────── mỗi iteration ─────────────────────┤
   │ 1. Plan     emit iteration(planning, intent=write|fix|review)   ← "Waiting for LLM"
   │             planner stream → emit code_progress (code đang viết)
   │             model trả DONE?  → SUCCESS (chỉ khi đã có lần chạy thành công)
   │ 2. Execute  emit code, activity(executing) → executor.execute()  ← "Runtime"
   │             (installing → rerunning) → collecting artifacts
   │ 3. Evaluate emit activity(checking) → false-success check → emit result
   │             lỗi hạ tầng → ERROR;  còn lại → iteration sau (model xem output/lỗi)
   ├─ đã chạy đủ max_iterations lần, lần cuối THÀNH CÔNG
   │     → 1 iteration "final review": chỉ gọi model (DONE → SUCCESS), KHÔNG chạy code nữa
   └─ đã chạy đủ max_iterations lần, lần cuối lỗi → MAX_RETRIES (hoặc TIMEOUT nếu bị timeout)
                                                    │
emit(event) ─► RunManager._persist() → SQLite ─► GET /api/runs/{id}  (UI refetch)
           └─► queue của mỗi SSE client ─► GET /api/runs/{id}/events
```

- **Sync và SSE dùng chung loop:** `/api/execute` = start + chờ task; `/api/execute/stream` = start + đọc queue. Đã có test so sánh kết quả nghiệp vụ của hai đường.
- **Stop:** `task.cancel()` → `CancelledError` đi vào executor → kill process thật (`_KILL_SNIPPET` trong sandbox, `proc.kill()` ở local, `container.remove(force)` ở ephemeral) → agent bắt lỗi → `stopped`.
- **Timeout:** `timeout -k 2 <T>` chạy trong sandbox (exit 124), cộng thêm lưới an toàn `asyncio.wait_for` ở Python.
- **Không chặn event loop:** Claude dùng `AsyncAnthropic`; Docker SDK / subprocess chạy trong `asyncio.to_thread`, nên `/health` và Stop vẫn trả lời khi code đang chạy.

## Trạng thái

**Iteration** là một lần gọi model. **`max_iterations`** (UI: *Max code runs*) là số lần **chạy code** tối đa. Khi lần chạy cuối thành công, model có thêm một iteration *final review* để xem output và trả `DONE`; code trả về ở lượt đó không được chạy. Số lần gọi model tối đa: `max_iterations + 1`, chưa tính retry khi JSON sai format (retry diễn ra bên trong cùng một iteration).

| Ai quyết định | Quyết định |
|---|---|
| **Model** | Viết code gì; output đã đủ chưa (`DONE`) |
| **Runtime** (`agent.py`) | Chạy hay không chạy code; khi nào hết lượt; false-success check; trạng thái cuối |

| Run status (API) | UI | Khi nào |
|---|---|---|
| `success` | Completed | Model trả lời `DONE` sau ít nhất 1 lần chạy thành công (kể cả ở lượt final review) |
| `max_retries` | Code run limit reached | Đã chạy đủ `max_iterations` lần mà model chưa `DONE`: hoặc lần chạy cuối lỗi, hoặc ở lượt final review model vẫn muốn thêm bước. Vẫn giữ output thành công gần nhất làm kết quả tạm |
| `timeout` | Timed out | Đã chạy đủ `max_iterations` lần và lần chạy cuối bị kill vì timeout |
| `error` | Failed | Planner lỗi / sandbox lỗi / model `DONE` khi chưa chạy được gì / server restart giữa chừng |
| `stopped` | Stopped | User bấm Stop |

Ví dụ với `max_iterations = 2`:

| Diễn biến | Lần gọi model | Lần chạy code | Kết quả |
|---|---|---|---|
| chạy OK → `DONE` | 2 | 1 | `success` |
| lỗi → sửa, chạy OK → final review `DONE` | 3 | 2 | `success` |
| lỗi → lỗi | 2 | 2 | `max_retries` (không gọi model lần 3) |
| chạy OK → thêm bước, chạy OK → final review vẫn muốn thêm bước | 3 | 2 | `max_retries` (code lượt 3 không chạy) |

## Dữ liệu và artifacts

```text
<RUNS_DIR>/<run_id>/code/iter_01.py     code từng iteration
<RUNS_DIR>/<run_id>/output/             thư mục code ghi file (= /workspace/output trong sandbox)
<RUNS_DIR>/<run_id>/snapshots/01/       bản sao file đổi ở iteration 1 → xem lại đúng iteration
```

- Docker Compose: volume `agent-db` (SQLite, chỉ server thấy) và `agent-runs` (server `/data/runs` = sandbox `/workspace/runs`).
- Mỗi lần chạy, `/workspace/output` được symlink vào `output/` của run hiện tại, nên prompt "save to /workspace/output" vẫn đúng mà file của các run không lẫn nhau.
- `GET /api/runs/{id}/artifacts/{path}` chỉ trả file nằm trong `output/` (hoặc snapshot) của đúng run đó, sau khi resolve path. Symlink ra ngoài và `../` đều trả 404.

## Activity log

Mỗi bước thật phát `emit("log", entry)` ngay tại chỗ nó xảy ra. `RunManager` lưu entry vào `run_logs` (lấy `id`) rồi đẩy qua SSE. UI nối entry theo `id`; khi refresh hoặc kết nối lại thì gọi `GET /logs?after=<id cuối>`.

| source | Ai phát | Ví dụ |
|---|---|---|
| `runtime` | `agent.py`, `runs.py` | Run started (model, executor, giới hạn), gửi lỗi/kết quả về model, Stop, Run finished |
| `llm` | `planner.py` | Calling model, First token, Response received (thời gian, stop_reason, tokens nếu có), parse OK/lỗi |
| `model` | `agent.py` | Câu giải thích ngắn model trả về (nội dung của model, không phải hành động runtime) |
| `sandbox` | `executor.py` | Ghi `code/iter_NN.py`, bắt đầu chạy, cài package, chạy lại, exit code/thời gian/timeout, artifacts + kích thước |

Message và data đều đi qua `redact()`: che `sk-ant-…`, header auth, và giá trị biến môi trường có tên chứa KEY/TOKEN/SECRET/PASSWORD.

## Event SSE

`session`, `iteration`, `code`, `result`, `model_done`, `error`, `done` là event cũ, client cũ vẫn chạy. Event mới: `activity` (hành động hiện tại), `code_progress` (code đang stream), `log` (activity log entry), `status`.

## Giới hạn hiện tại

- Chỉ 1 run tại một thời điểm (backend trả 409, UI khóa nút Run).
- Persistent sandbox dùng chung 1 container: code của run này về lý thuyết đọc được thư mục run khác. Muốn cách ly chặt hơn thì dùng ephemeral mode.
- Không có authentication. Bù lại, mặc định chỉ `127.0.0.1` truy cập được (compose publish `127.0.0.1:8000`, `python server.py` mặc định `HOST=127.0.0.1`) và CORS chỉ cho Vite dev server.
- Local mode không cách ly: code của model chạy với quyền user đang chạy server.
- Chưa có eval, giới hạn chi phí hay observability ngoài log và UI. **Chưa phải production-ready.** Lộ trình: [FEATURE_MAP.vi.md](FEATURE_MAP.vi.md).
