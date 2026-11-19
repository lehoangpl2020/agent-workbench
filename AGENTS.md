# AGENTS.md — Agent Workbench

Quy tắc ngắn cho AI assistant khi làm việc trong repo này. Bản đầy đủ và giải thích nằm trong [CLAUDE.md](CLAUDE.md); tổng quan cho người đọc ở [README.md](README.md) (tiếng Anh), nguồn gốc ở [NOTICE.md](NOTICE.md).

## Mục tiêu của repo

1. **Học AI Agent Engineering**: hiểu cơ chế agent bằng cách đọc, chạy, sửa và đo một agent thật.
2. **Showcase**: repo public, README rõ ràng, chỉ nêu những gì thực sự có trong code; phần chưa làm ghi là *planned*.
3. **Chia sẻ bản tự chạy local**: người khác clone về, điền key của chính họ, chạy bằng `docker compose`.

Project khởi đầu từ code thực hành của khóa Mentora × ProtonX và được mở rộng thêm; không được mô tả toàn bộ source là của riêng tác giả (xem NOTICE.md). Chưa có LICENSE: không tự thêm license nào khi chưa làm rõ quyền với phần code gốc.

## Project là gì

Code Execution Agent: model (Claude) sinh code Python → sandbox chạy → lỗi/kết quả được đưa lại cho model → lặp tới khi model báo `DONE` hoặc hết giới hạn. Có FastAPI backend và Web UI React xem tiến trình realtime. Đây là **project học, không phải production**.

## Ngôn ngữ

- Trả lời **tiếng Việt**, gọi người học là "sếp", xưng "em". Giữ thuật ngữ kỹ thuật tiếng Anh.
- Tài liệu và comment trong project viết tiếng Việt; giữ nguyên phong cách đó. Tên biến, hàm, field API dùng tiếng Anh.

## Lệnh thường dùng

Chạy ở thư mục gốc repo (nơi có `docker-compose.yml`).

| Việc | Lệnh |
|---|---|
| Chạy đầy đủ (Docker) | `docker compose up -d --build` → http://localhost:8000 |
| Chạy local, không Docker | `USE_DOCKER=false python server.py` |
| Test offline (mock planner) | `.venv/Scripts/python -m pytest tests -q` (Windows) hoặc `.venv/bin/python -m pytest tests -q` |
| Test sandbox thật | Xem docstring đầu `tests/test_docker_executor.py` (cần `DOCKER_SANDBOX_TESTS=1`, chạy trong container) |
| UI dev | `cd web && npm run dev` → http://localhost:5173 (proxy sang :8000) |
| Typecheck + build UI | `cd web && npm run build` |

## Quy tắc làm việc

- **Không đọc, không in, không commit `.env`.** API key chỉ đi qua biến môi trường. Không bảo sếp dán key vào chat. `.env.example` là mẫu duy nhất được commit.
- Chỉ nói "đã kiểm chứng" khi thực sự chạy. Luôn nêu rõ: **test offline/mock** (planner giả, code vẫn chạy thật bằng `LocalExecutor`) hay **gọi Claude API thật** hay **chạy qua sandbox Docker thật**.
- Không chạy lệnh gọi Claude API thật (`client.py`, `./run.sh test`, chạy run từ UI) khi sếp chưa yêu cầu: tốn tiền.
- Sửa code xong phải chạy `pytest tests -q`; sửa `web/` thì chạy thêm `npm run build` (có `tsc -b`).
- Thay đổi nhỏ, bám stack hiện có. **Không tự thêm** framework, database, queue, multi-agent, auth hay hạ tầng mới.
- Không tự đổi model mặc định, không thêm dependency vào `requirements.txt` / `web/package.json` khi chưa được yêu cầu.
- Không gọi project là production-ready. Các thiếu sót đã biết nằm ở mục "Giới hạn hiện tại" trong [ARCHITECTURE.vi.md](docs/vi/ARCHITECTURE.vi.md).

## Bất biến không được phá

1. **Một agent loop duy nhất** (`CodeAgent.run()` trong `agent.py`). Sync API, SSE và Run API đều dùng chung loop này; không viết loop thứ hai.
2. **Không chặn event loop.** Docker SDK, subprocess và I/O nặng chạy qua `asyncio.to_thread`; Claude gọi bằng `AsyncAnthropic`.
3. **Stop phải kill process thật** (sandbox, subprocess hoặc container), không chỉ hủy task.
4. **Giữ tương thích event/API cũ:** `session`, `iteration`, `code`, `result`, `model_done`, `error`, `done` và `/api/execute*`. Chỉ thêm event mới, không đổi nghĩa event cũ. Giá trị `ExecutionStatus` cũng giữ nguyên.
5. **Che secret** mọi log/message qua `redact()` (`runlog.py`) trước khi lưu hoặc gửi đi.
6. **Chặn path traversal** khi trả artifact (`workspace.py`): resolve path, chỉ trả file nằm trong `output/` hoặc snapshot của đúng run đó.
7. **Chỉ 1 run tại một thời điểm** (trả `409` khi đang có run). Muốn đổi thì phải sửa cả backend, UI và test.
8. **Provider/model cố định cho cả run**, validate theo `model_catalog.py`, không fallback sang provider khác. Request không gửi lựa chọn → Claude Sonnet 4.6. Run cũ không có provider thì để trống, không gán default.
9. Server chỉ copy `*.py` ở thư mục gốc vào image (`COPY *.py .` trong `Dockerfile.server`). Module Python mới đặt ở gốc, hoặc sửa Dockerfile nếu tạo thư mục con.
10. **Chỉ máy local truy cập được:** compose publish `127.0.0.1:8000`, `python server.py` mặc định `HOST=127.0.0.1`, CORS không có `*`. Server chạy code do model sinh ra và không có auth.
11. **Điều kiện dừng:** `max_iterations` = số lần **chạy code** tối đa. Lần chạy cuối thành công → thêm 1 lượt final review (không chạy code); lần cuối lỗi → dừng, không gọi model thêm. Chi tiết: ARCHITECTURE.vi.md mục Trạng thái.

## Cấu trúc nhanh

```text
schemas.py     data model + ExecutionStatus      planner.py   gọi model của run (stream) → CodeBlock
model_catalog.py  provider/model + default          llm_providers.py  adapter Anthropic/OpenAI/Ollama
agent.py       agent loop                        executor.py  Local / Sandbox / PersistentSandbox
runs.py        RunManager (nền, Stop, SSE)       store.py     SQLite (runs, iterations, run_logs)
runlog.py      log entry + redact                workspace.py thư mục run + chặn traversal
server.py      FastAPI + phục vụ UI              client.py    CLI client
web/src/       React + TS + Vite + Tailwind + shadcn/ui
tests/         pytest, ScriptedPlanner (không gọi Claude API)
```

## Quy ước

- Commit message kiểu `docs: ...`, `fix: ...`, `feat: ...`. Chỉ commit/push khi sếp yêu cầu.
- Repo public: không đưa vào slide/transcript/tài liệu nội bộ của khóa học, dữ liệu run thật, log hay `.env`. Không ghi tiến độ học hay kết quả kiểm chứng chưa từng xảy ra.
- Docs: README tiếng Anh ở gốc; ghi chú học chi tiết tiếng Việt ở `docs/vi/`.
- Test mới dùng `ScriptedPlanner` trong `tests/conftest.py`; không viết test cần Claude API thật hoặc Docker thật trừ khi gắn cờ bỏ qua như `DOCKER_SANDBOX_TESTS`.
- Không sửa `web/dist/`, `static/`, `data/`, `.venv/`, `node_modules/` (đều là file sinh ra).
