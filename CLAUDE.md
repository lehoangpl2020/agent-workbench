# CLAUDE.md — Agent Workbench

Hướng dẫn lâu dài cho Claude khi làm việc trong repo **Agent Workbench**. Bản rút gọn: [AGENTS.md](AGENTS.md). Nếu mâu thuẫn thì ưu tiên chỉ dẫn mới nhất của sếp.

## 0. Mục tiêu, người học và cách trao đổi

- **Mục tiêu repo:** (1) học AI Agent Engineering qua một agent chạy code thật; (2) showcase công khai trên GitHub; (3) cho người khác tự chạy bản local bằng key của họ.
- **Người học:** Senior .NET backend engineer, mới học Python và AI Agent. Không mặc định sếp biết cú pháp Python hay framework AI; đối chiếu C#/.NET khi giúp dễ hiểu (ghi rõ đó là suy luận thêm).
- Trả lời **tiếng Việt**, gọi người học là "sếp", xưng "em", giữ thuật ngữ kỹ thuật tiếng Anh. Ngắn gọn, thẳng. Chỉ hỏi khi thông tin thực sự đổi hướng giải quyết.
- **Bản chất trước, framework sau.** Khi đọc code, tách phần application thực thi khỏi phần model quyết định; chỉ nhận xét cơ chế thực sự có trong code, phần thiếu thì nói là thiếu.
- **Không bịa:** tiến độ học, kết quả kiểm chứng, tính năng chưa có. Chỉ nói "đã chạy/đã kiểm chứng" khi thực sự chạy; phân biệt offline/mock, gọi model/API thật, và toàn bộ luồng.
- **Nguồn gốc và attribution:** project khởi đầu từ code thực hành của khóa Mentora × ProtonX và được mở rộng thêm ([NOTICE.md](NOTICE.md)). Không viết như thể toàn bộ source do sếp viết. Giữ nguyên mọi copyright/license notice có trong file gốc. **Chưa có LICENSE**; không tự thêm MIT hay license khác khi chưa làm rõ quyền với phần code gốc.
- **Repo public:** không đưa vào slide/transcript/tài liệu nội bộ của khóa, `.env`, key, dữ liệu run thật, log hay screenshot có dữ liệu riêng. Không đọc hay in nội dung `.env`; không bảo sếp dán key vào chat.
- **Tài liệu:** README tiếng Anh ở gốc. Ghi chú học chi tiết tiếng Việt ở `docs/vi/`: [QUICKSTART](docs/vi/QUICKSTART.vi.md), [ARCHITECTURE](docs/vi/ARCHITECTURE.vi.md) (luồng code, trạng thái, log, giới hạn), [PROVIDERS](docs/vi/PROVIDERS.vi.md), [TROUBLESHOOTING](docs/vi/TROUBLESHOOTING.vi.md), [README.vi](docs/vi/README.vi.md) (API, chế độ chạy, bảo mật). [FEATURE_MAP](docs/vi/FEATURE_MAP.vi.md) và [NEXT_STEPS](docs/vi/NEXT_STEPS.vi.md) là ghi chú kế hoạch/lịch sử, **không** phải danh sách tính năng đã có. Trước khi giải thích kiến trúc, đọc ARCHITECTURE.vi.md và đối chiếu với code; đừng trả lời theo trí nhớ.

## 1. Project này là gì

Code Execution Agent theo vòng lặp **Plan → Execute → Evaluate → Retry/Done**:

1. `planner.py` gọi model user chọn cho run (Claude / OpenAI / Ollama, stream), nhận JSON `{thinking, code, language}`. Catalog: `model_catalog.py`; adapter: `llm_providers.py`; hướng dẫn: [PROVIDERS.vi.md](docs/vi/PROVIDERS.vi.md).
2. `executor.py` chạy code trong sandbox (hoặc subprocess ở local), có timeout thật, auto `pip install`, thu artifacts.
3. `agent.py` đưa stdout/stderr/lỗi trở lại cho model ở iteration sau; model trả `DONE` thì kết thúc.
4. `runs.py` + `store.py` + `server.py` biến loop đó thành Run API (chạy nền, Stop, SSE, lịch sử SQLite, activity log).
5. `web/` là UI React: Composer, Live Flow, Replay, Logs, Files, History.

Mục đích: **học cơ chế Agent**, không phải sản phẩm production. Ưu tiên code dễ đọc, dễ lần theo hơn là tối ưu.

## 2. Ai quyết định cái gì (rất quan trọng khi giải thích)

Khi sếp hỏi "agent này hoạt động thế nào", luôn tách hai phần:

| Phần | Ai quyết định | Nằm ở đâu |
|---|---|---|
| Viết code gì, sửa lỗi ra sao, khi nào trả `DONE` | **Model** | `planner.py` (system prompt + parse) |
| Chạy code, timeout, kill, cài package, thu artifact | **Application** | `executor.py` |
| Điều kiện tiếp tục/dừng loop, trạng thái cuối, false-success check | **Application** | `agent.py` |
| Chạy nền, một run một lúc, Stop, chuyển event → SQLite + SSE | **Application** | `runs.py` |

Đối chiếu C#/.NET khi giúp dễ hiểu (nhớ ghi rõ là suy luận thêm, không phải kiến thức của project). Ví dụ: `RunManager` ≈ hosted service giữ một job nền; `emit(event, data)` ≈ publish domain event; `store.py` ≈ repository trên SQLite; `ExecutionStatus` ≈ enum trạng thái.

## 3. Sơ đồ module

```text
schemas.py     Pydantic: AgentRequest/State/Response, CodeBlock, ExecutionResult, ExecutionStatus
planner.py     LLMPlanner(spec): ChatClient.stream → CodeBlock; on_progress (code đang viết), on_log
model_catalog.py  CATALOG/PROVIDERS, DEFAULT (claude-sonnet-4-6), resolve() validate lựa chọn
llm_providers.py  AnthropicChat / OpenAIChat (Responses API) / OllamaChat, ProviderError(kind), ProviderRegistry
executor.py    LocalExecutor / SandboxExecutor (container mới) / PersistentSandboxExecutor (docker exec)
agent.py       CodeAgent.run(): loop duy nhất, phát event qua emit(event, data)
runs.py        RunManager: asyncio.Task nền, Stop = task.cancel(), _persist() → SQLite + queue SSE
store.py       SQLite: bảng runs, iterations, run_logs (có migration cho DB cũ)
runlog.py      Tạo log entry {ts, iteration, source, level, message, data}; redact() che secret
workspace.py   Thư mục riêng mỗi run; resolve path, chặn path traversal khi đọc artifact
server.py      FastAPI: Run API, API cũ (/api/execute, /api/execute/stream), /health, phục vụ UI
client.py      CLI (sync + SSE), cần httpx
example.py     Chạy agent trực tiếp, không qua server
web/src/       App.tsx, components/ (RunView, ActivityLog, studio/* = Live Flow/Replay...), lib/api.ts, hooks/useRun.ts
tests/         conftest.py (ScriptedPlanner), test_agent_loop, test_api, test_logs, test_docker_executor
```

Dữ liệu mỗi run (`RUNS_DIR/<run_id>/`): `code/iter_NN.py`, `output/` (= `/workspace/output` trong sandbox qua symlink), `snapshots/NN/` (bản file đổi ở iteration NN để Replay xem đúng phiên bản).

## 4. Trạng thái run

**Iteration** là một lần gọi model. **`max_iterations`** (UI: *Max code runs*) là số lần **chạy code** tối đa. Nếu lần chạy cuối thành công, model có thêm một iteration *final review* để trả `DONE`; code của lượt đó không được chạy. Nếu lần chạy cuối lỗi hoặc timeout thì dừng ngay, không gọi model thêm. Số lần gọi model tối đa là `max_iterations + 1` (chưa tính format retry). Logic nằm ở `CodeAgent._loop`; bảng ví dụ ở docs/vi/ARCHITECTURE.vi.md mục Trạng thái.

| `status` (API) | UI | Khi nào |
|---|---|---|
| `success` | Completed | Model trả `DONE` sau ít nhất 1 lần chạy thành công (kể cả ở lượt final review) |
| `max_retries` | Code run limit reached | Đã chạy đủ `max_iterations` lần mà model chưa `DONE` (lần cuối lỗi, hoặc final review vẫn muốn thêm bước); giữ output thành công gần nhất làm kết quả tạm |
| `timeout` | Timed out | Đã chạy đủ `max_iterations` lần và lần chạy cuối bị kill vì timeout |
| `error` | Failed | Planner lỗi, sandbox lỗi (`system_error`), model `DONE` khi chưa chạy được gì, server restart giữa chừng |
| `stopped` | Stopped | User bấm Stop |

`pending` và `running` là trạng thái chưa kết thúc. Tập `TERMINAL_STATUSES` nằm ở `schemas.py`. `false_success` (exit 0 nhưng stdout trông như lỗi, ví dụ `print("Error: ...")`) được coi là lỗi và đưa lại cho model.

## 5. Bất biến không được phá

Các điểm này có test bảo vệ hoặc là quyết định kiến trúc có chủ ý. Muốn đổi thì nói rõ với sếp trước.

1. **Một agent loop duy nhất.** `/api/execute` = start + chờ task; `/api/execute/stream` = start + đọc queue; Run API = start + SSE. `test_sync_and_sse_have_same_business_result` so sánh kết quả của hai đường.
2. **Không chặn event loop.** Claude qua `AsyncAnthropic`; Docker SDK/subprocess qua `asyncio.to_thread`. Nhờ vậy `/health` và Stop vẫn trả lời khi code đang chạy (`test_stop_kills_code_and_server_stays_responsive`).
3. **Stop kill process thật:** `CancelledError` đi vào executor → `_KILL_SNIPPET` trong sandbox / `proc.kill()` ở local / `container.remove(force)` ở ephemeral → agent bắt lỗi → `stopped`.
4. **Timeout hai lớp:** `timeout -k 2 <T>` trong sandbox (exit 124) và `asyncio.wait_for` ở Python làm lưới an toàn.
5. **Tương thích ngược:** event cũ (`session`, `iteration`, `code`, `result`, `model_done`, `error`, `done`), `/api/execute*` và các giá trị `ExecutionStatus` giữ nguyên. Event mới (`activity`, `code_progress`, `log`, `status`) chỉ thêm, không đổi nghĩa event cũ. UI coi SSE là tín hiệu để refetch; nguồn sự thật là `GET /api/runs/{id}`.
6. **Che secret.** Mọi log message và `data` đi qua `redact()`: che `sk-ant-…`, header auth, và giá trị biến môi trường có tên chứa KEY/TOKEN/SECRET/PASSWORD. Executor local cũng lọc các biến môi trường như vậy khỏi subprocess. Log mới thêm vào phải đi qua đường này (`test_secrets_are_redacted`).
7. **Chặn path traversal / symlink thoát khỏi thư mục run** khi trả artifact (`test_symlink_pointing_outside_is_blocked`, `test_artifacts_are_isolated_per_run`).
8. **Một run một lúc.** Backend trả `409`, UI khóa nút Run.
9. **Lịch sử sống qua restart.** Run đang chạy mà server restart được đánh dấu `error`. DB cũ phải migrate được (`test_old_database_is_migrated`). Đổi schema SQLite thì thêm migration và test.
10. **Provider/model cố định cho cả run.** Validate theo `model_catalog.py` (422 nếu sai), preflight 400 nếu thiếu key / Ollama không kết nối / model chưa pull, không fallback. Request không gửi lựa chọn → Claude Sonnet 4.6. Run cũ có `provider` NULL, giữ nguyên `model` đã lưu (`test_providers.py`).
11. **Docker image chỉ copy `*.py` ở thư mục gốc** (`COPY *.py .` trong `Dockerfile.server`). Module mới đặt ở gốc, hoặc sửa Dockerfile nếu tạo thư mục con. Import trong project là import phẳng (`from schemas import ...`), không phải package `code_agent`.
12. **Chỉ máy local truy cập được.** Server chạy code do model sinh ra và không có auth: compose publish `127.0.0.1:8000` (`BIND_ADDRESS`), `python server.py` mặc định `HOST=127.0.0.1`, CORS chỉ cho Vite dev (`CORS_ORIGINS`), không có `*`. Không đổi các mặc định này (`test_cors_rejects_unknown_origin`, `test_server_defaults_to_localhost_only`).
13. **Điều kiện dừng** như mục 4: `max_iterations` đếm lần chạy code; final review không chạy code; lần cuối lỗi thì không gọi model thêm (`test_single_code_run_can_still_succeed`, `test_failed_last_run_stops_without_extra_model_call`, `test_success_without_done_hits_run_limit_and_keeps_partial`).

## 6. Cấu hình (biến môi trường)

Đọc ở `server.py` (trừ khi ghi khác). Không đọc hay in nội dung `.env`; chỉ cần biết tên biến.

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `ANTHROPIC_API_KEY` | không có | Cho provider Anthropic (cũng chấp nhận `ANTHROPIC_AUTH_TOKEN`), đọc ở `llm_providers.py` |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL` | không có, `https://api.openai.com/v1` | Cho provider OpenAI |
| `OLLAMA_BASE_URL` | `http://localhost:11434` (code), `http://host.docker.internal:11434` (compose) | Ollama nhìn từ chỗ backend chạy |
| `MAX_ITERATIONS` | `5` | Số lần **chạy code** tối đa (request có thể ghi đè, 1–20); model được gọi tối đa thêm 1 lần |
| `EXECUTION_TIMEOUT` | `30` | Giây mỗi lần chạy code (request có thể ghi đè, 1–300) |
| `MAX_OUTPUT_TOKENS` | theo model trong catalog | Ghi đè giới hạn token đầu ra cho mọi model (`planner.py`) |
| `USE_DOCKER` | `false` | `true` → dùng sandbox Docker |
| `SANDBOX_MODE` | `ephemeral` (code), `persistent` (docker-compose) | `ephemeral` hoặc `persistent` |
| `SANDBOX_CONTAINER_NAME` | `agent-workbench-sandbox` | Tên container persistent |
| `SANDBOX_RUNS_DIR` | `/workspace/runs` | Đường dẫn thư mục runs nhìn từ trong sandbox |
| `SANDBOX_RUNS_MOUNT` | volume `agent-runs` | Chỉ dùng trong compose, hybrid mode đặt `./data/runs` |
| `DATA_DIR`, `DB_PATH`, `RUNS_DIR`, `STATIC_DIR` | dưới `./data`, `./static` | Nơi lưu SQLite, runs, bản build UI |
| `PORT` | `8000` | Cổng khi chạy `python server.py` |
| `HOST` | `127.0.0.1` | Địa chỉ nghe khi chạy `python server.py` (trong container, Dockerfile dùng `0.0.0.0` và compose giới hạn ở port publish) |
| `BIND_ADDRESS` | `127.0.0.1` | Chỉ trong compose: địa chỉ publish port 8000 |
| `HOST_PORT` | `8000` | Chỉ trong compose: cổng publish trên máy host (container luôn nghe 8000) |
| `CORS_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Origin trình duyệt được gọi API |
| `LOCAL_PYTHON` | `sys.executable` | Python dùng cho `LocalExecutor` |
| `DOCKER_SANDBOX_TESTS` | không | `1` để bật test sandbox thật |

Lưu ý: mặc định trong code là `ephemeral`, nhưng `docker-compose.yml` đặt `persistent`. Khi báo "đang chạy mode nào" hãy kiểm tra `/health` (trả `sandbox_mode`), đừng suy đoán.

## 7. Lệnh chạy và kiểm chứng

Chạy ở thư mục gốc repo (nơi có `docker-compose.yml`). Môi trường của sếp là Windows (PowerShell/Git Bash); `./run.sh` dùng `.venv/bin/activate` nên chạy trong WSL/Git Bash hoặc dùng lệnh trực tiếp bên dưới.

```bash
# Chạy đầy đủ (khuyến nghị): UI + API tại http://localhost:8000, cần key của provider muốn dùng trong .env
docker compose up -d --build
docker compose ps                    # agent-server (healthy) + agent-workbench-sandbox (Up)
curl http://localhost:8000/health    # xem docker, sandbox_mode
docker compose logs -f agent-server  # log iteration/executor; docker logs agent-workbench-sandbox luôn trống

# Local, không Docker (code chạy bằng subprocess, chỉ dùng khi dev)
USE_DOCKER=false python server.py

# Test offline (planner giả, KHÔNG gọi Claude API)
.venv/Scripts/python -m pytest tests -q        # Windows
.venv/bin/python -m pytest tests -q            # Linux/macOS/WSL

# Test sandbox thật: xem docstring tests/test_docker_executor.py (chạy trong container với DOCKER_SANDBOX_TESTS=1)

# UI
cd web && npm run dev       # http://localhost:5173, proxy /api và /health sang :8000
cd web && npm run build     # tsc -b + vite build, dùng làm typecheck
```

Phân biệt khi báo kết quả:

- **Offline/mock:** `pytest tests -q`. Planner là `ScriptedPlanner`, nhưng code **vẫn chạy thật** bằng `LocalExecutor`. Chứng minh được logic loop/API/log/Stop, **không** chứng minh được chất lượng model hay sandbox Docker.
- **Sandbox Docker thật:** `test_docker_executor.py`, hoặc chạy qua `docker compose`.
- **Gọi Claude API thật:** `client.py`, `./run.sh test`, hoặc bấm Run trên UI. Tốn tiền, chỉ làm khi sếp yêu cầu, và nói rõ đã làm.
- **Toàn bộ luồng:** chỉ nói khi đã chạy UI → server → model thật → sandbox thật → kết quả hiển thị.

Hiện chưa có test frontend; UI chỉ kiểm bằng `npm run build` và xem tay. Nói thẳng điều đó khi sửa `web/`.

## 8. Quy ước khi sửa code

- **Backend (Python 3.11):** Pydantic v2, FastAPI, async/await. Comment và docstring tiếng Việt, giữ giọng đó. Tên mới bằng tiếng Anh.
- **Frontend:** React 19 + TypeScript + Vite + Tailwind 4 + shadcn/ui (Radix). Component UI nền ở `web/src/components/ui/`, alias `@/` trỏ tới `web/src`. Kiểu dữ liệu API khai báo ở `web/src/lib/api.ts`; đổi response backend thì đổi cả kiểu này. Không để secret ở frontend.
- Thêm field vào API: cập nhật `schemas.py`/`server.py`, `web/src/lib/api.ts`, test liên quan, và mục API trong README nếu là endpoint mới.
- Thêm loại log/event: phát đúng nơi hành động thật xảy ra (`emit("log", entry)` tại chỗ), đúng `source` (`runtime`, `llm`, `model`, `sandbox`), và qua `redact()`.
- Thay đổi nhỏ, chạy được, kiểm chứng được. Không refactor lan rộng khi sếp chỉ nhờ sửa một chỗ.
- Test mới dùng `ScriptedPlanner` (`conftest.py`): kịch bản là danh sách `CodeBlock`, `Exception` (planner lỗi) hoặc `Hang()` (giả lập model chậm để test Stop khi planning). Dùng `DONE` có sẵn cho bước báo xong.
- Không sửa file sinh ra: `web/dist/`, `static/`, `data/`, `.venv/`, `node_modules/`, `__pycache__/`, `*.tsbuildinfo`. `__MACOSX/` và `.DS_Store` là rác từ file zip (đã gitignore), bỏ qua.

## 9. Giới hạn hiện tại (nói thẳng, không tô vẽ)

Theo docs/vi/ARCHITECTURE.vi.md và code:

- Chỉ 1 run cùng lúc.
- Persistent sandbox dùng chung một container: code của run này về lý thuyết đọc được thư mục run khác. Cần cách ly chặt hơn thì dùng ephemeral.
- Sandbox có network (để auto `pip install`). Muốn cách ly hoàn toàn phải đổi sang `network_mode: none` và chấp nhận mất auto-install.
- `agent-server` mount `/var/run/docker.sock` để điều khiển sandbox. Đây là quyền rất rộng trên máy host, chỉ chấp nhận được cho môi trường học/dev.
- Chưa có authentication (bù lại bằng việc chỉ nghe ở `127.0.0.1`), eval, giới hạn chi phí, observability ngoài log + UI.
- Local mode không cách ly; UI hiện cảnh báo khi `/api/config` trả `sandboxed: false`.
- Chưa có test frontend.

**Chưa phải production-ready.** Khi sếp hỏi "đưa lên dùng thật được chưa", liệt kê các thiếu sót trên thay vì trả lời "được".

## 10. Việc cần hỏi sếp trước khi làm

- Gọi Claude API thật hoặc chạy run từ UI (tốn tiền).
- Đổi model mặc định, thêm dependency Python/npm, thêm framework hoặc hạ tầng mới.
- Đổi hành vi đã nêu ở mục 5, đổi schema SQLite, đổi mode sandbox mặc định.
- Commit/push, thêm LICENSE, đổi nội dung attribution trong NOTICE.md, xóa volume Docker (`docker compose down -v` xóa lịch sử và artifacts).
