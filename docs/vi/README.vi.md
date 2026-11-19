# Agent Workbench — tài liệu chi tiết (tiếng Việt)

> Bản tiếng Anh tóm tắt: [README ở thư mục gốc](../../README.md). File này là README đầy đủ bằng tiếng Việt (API, chế độ chạy, bảo mật). Các lệnh `docker compose`, `python`, `pytest` chạy ở **thư mục gốc repo**.

## Code Execution Agent

Agent tự động sinh và chạy code, có khả năng tự sửa lỗi qua feedback loop.
Có Web UI (React) để gửi yêu cầu, xem tiến trình realtime từng iteration, code, logs và tải artifacts.

- Chạy nhanh: [QUICKSTART.vi.md](QUICKSTART.vi.md): `docker compose up -d --build` rồi mở http://localhost:8000
- Kiến trúc và luồng code: [ARCHITECTURE.vi.md](ARCHITECTURE.vi.md)
- Provider/model (Claude, OpenAI, Ollama): [PROVIDERS.vi.md](PROVIDERS.vi.md)
- Lỗi thường gặp: [TROUBLESHOOTING.vi.md](TROUBLESHOOTING.vi.md)

> **Project học, không phải production.** Server chạy code do model sinh ra và **không có authentication**. Mặc định chỉ máy của bạn truy cập được (`127.0.0.1`); đừng mở ra mạng LAN/Internet. Chi tiết ở mục [Security](#security).

### Xem Activity log

Tab **Logs** hiện log của cả run theo thời gian thực. Mỗi dòng có timestamp, iteration, mức `INFO/WARN/ERROR` và nguồn:
`RUNTIME` (agent loop), `LLM CALL` (gọi Claude: thời gian, first token, tokens nếu API trả về, parse), `MODEL` (câu giải thích ngắn model trả về) và `SANDBOX` (ghi file, chạy code, cài package, artifacts).
Có thể lọc theo iteration hoặc chỉ xem WARN/ERROR, bật/tắt auto-scroll, Copy và Download. stdout/stderr nằm ở vùng **Process output** thu gọn được. Log lưu trong SQLite (`run_logs`) nên refresh hoặc mở run cũ vẫn xem được; message được che secret trước khi lưu.

### Xem Live Flow (Agent Studio)

Mở một run, chọn **Live Flow**. Màn hình gồm:

- **Thanh điều khiển**: `Live` / `Replay`, hành động hiện tại, thời gian chờ thật (`activity_at`), iteration và **Stop** khi run đang chạy.
- **Sân khấu**: Model ↔ Agent runtime (nhãn điều phối nhỏ, có checklist của iteration) ↔ Python sandbox. Thẻ dữ liệu (`Task`, `Error`, `Output`, `iter_NN.py`, `exit N`, `DONE`) chỉ di chuyển khi có log thật; file code chỉ sang sandbox sau khi backend parse xong và ghi `code/iter_NN.py`. Ô sandbox hiện lệnh, stdout/stderr cuối, exit code và thumbnail file đã lưu.
- **Panel chi tiết**: nội dung của bước đang xem: task/feedback gửi model, metadata lời gọi model, code (đang stream khi live), output, ảnh + Download, lý do kết thúc.
- **Timeline**: các bước nhóm theo iteration; bấm hoặc dùng phím ← → để chọn bước. Khi run đang chạy, bấm một bước sẽ ghim panel, **Back to live** để theo dõi tiếp.
- **How it works**: giải thích bốn phần (runtime, model, sandbox, artifacts), thu gọn mặc định.

Live hiển thị lần lượt các event đến cách nhau vài ms (mỗi lần chuyển dữ liệu dừng ~0,5 giây) rồi đứng ở trạng thái thật hiện tại; refresh/reconnect dựng lại từ snapshot + log, không phát lại lịch sử.

Với run đã kết thúc, chọn **Replay** (hoặc bấm một bước trên timeline): **Play/Pause** (dừng cả animation lẫn việc chuyển bước), **Restart**, tốc độ 1× / 2× / 4×. Panel và timeline chỉ hiện dữ liệu đã có tại bước đang xem; bước sau là ô xám không nhãn. Timestamp là thời gian gốc; ở 1× khoảng chờ được rút gọn còn 0,45–2,4 giây (tối thiểu 1 giây sau mỗi lần chuyển dữ liệu), ghi trong tooltip `?`. Replay chỉ đọc lịch sử SQLite và bản file theo iteration, không gọi model và không chạy code. Code stream dở không được lưu theo bước nên Replay chỉ hiện code từ lúc response được parse. Run cũ thiếu log chi tiết có nhãn **Partial history**; file thiếu bản lưu theo iteration có nhãn **Snapshot unavailable**. Hỗ trợ `prefers-reduced-motion` (thẻ đứng yên ở đích, chú thích vẫn mô tả bước).

## Kiến trúc

```
User Request
     │
     ▼
┌─────────────────────────────────────┐
│         Agent Orchestrator          │
│                                     │
│  ┌──────────┐    ┌───────────────┐  │
│  │   LLM    │───▶│    Sandbox    │  │
│  │ Planner  │    │   Executor    │  │
│  └──────────┘    └───────────────┘  │
│       ▲                │            │
│       │   error +      │            │
│       │   context      │            │
│       └────────────────┘            │
│              Feedback Loop          │
└─────────────────────────────────────┘
     │
     ▼
  Response
```

### Components

| Component | File | Mô tả |
|-----------|------|-------|
| **LLM Planner** | `planner.py` | Gọi model đã chọn (Claude / OpenAI / Ollama) sinh Python code từ user request. Nhận error context để tự sửa. |
| **Model catalog** | `model_catalog.py` | Nơi duy nhất khai báo provider/model, default Claude Sonnet 4.6. Xem [PROVIDERS.vi.md](PROVIDERS.vi.md). |
| **Provider adapters** | `llm_providers.py` | Anthropic (SDK), OpenAI Responses API, Ollama `/api/chat` → cùng 1 contract; phân loại lỗi; trạng thái sẵn sàng. |
| **Sandbox Executor** | `executor.py` | 3 modes: `PersistentSandboxExecutor`, `SandboxExecutor`, `LocalExecutor`. |
| **Agent Orchestrator** | `agent.py` | Điều phối feedback loop: Plan → Execute → Evaluate → Retry/Done. Agent loop duy nhất cho mọi API. |
| **Run Manager** | `runs.py` | Chạy loop nền, 1 run/lúc, Stop, chuyển event → SQLite + SSE. |
| **Store / Workspace** | `store.py`, `workspace.py` | Lịch sử SQLite; thư mục + artifacts riêng từng run. |
| **FastAPI Server** | `server.py` | Run API, API cũ (sync + SSE), phục vụ Web UI. |
| **Web UI** | `web/` | React + TypeScript + Vite + Tailwind + shadcn/ui. |
| **Client** | `client.py` | CLI client hỗ trợ sync + SSE streaming. |

### Executor Modes

| Mode | Env vars | Mô tả |
|------|----------|-------|
| **Local** | `USE_DOCKER=false` (default khi chạy `python server.py`) | Subprocess trên chính máy chạy server, **không cách ly**. Chỉ dùng để dev; UI hiện cảnh báo *Local mode* |
| **Ephemeral** | `USE_DOCKER=true`, `SANDBOX_MODE=ephemeral` | Tạo container mới mỗi lần, xóa sau khi xong |
| **Persistent** | `USE_DOCKER=true`, `SANDBOX_MODE=persistent` | Sandbox chạy sẵn, dùng `docker exec`, debug được |

---

## Quick Start

Cách chạy chính thức là **Docker Compose** (mục 1). Local mode (mục 3) chỉ để dev.

### 1. Docker Compose — Persistent Sandbox (khuyến nghị)

Sandbox container chạy sẵn, luôn thấy trong `docker ps`, debug trực tiếp được.

Copy `.env.example` thành `.env` cạnh `docker-compose.yml` rồi điền key của provider muốn dùng; compose tự đọc file này. Ollama local không cần key.

```bash
docker compose up -d --build     # Web UI + API: http://localhost:8000 (chỉ máy này truy cập được)
```

Verify:
```powershell
# Health check — phải thấy sandbox_mode: persistent
curl http://localhost:8000/health

# Phải trả về:
# {"status":"ok","docker":true,"sandbox_mode":"persistent","sandbox_container":"agent-workbench-sandbox"}

# Kiểm tra 2 container đang chạy
docker compose ps
# agent-server (healthy), agent-workbench-sandbox (Up)
```

Lịch sử (SQLite) và artifacts nằm trong volume `agent-db`, `agent-runs` → còn nguyên sau `docker compose down` / restart.

Port được publish là `127.0.0.1:8000`, nên máy khác trong mạng không gọi được. Muốn cố ý demo cho máy khác thì đặt `BIND_ADDRESS=0.0.0.0` trong `.env`, và hiểu rằng ai vào được port đó đều chạy được code và dùng API key của bạn.

> **Lưu ý:** `python server.py` (mục 2, 3) **không tự đọc `.env`**. Chỉ `docker compose` và `./run.sh` nạp file này. Khi chạy bằng Python, đặt key bằng biến môi trường của shell.

### 2. Chạy server bằng Python + sandbox bằng Docker (hybrid)

Khi muốn debug server code trực tiếp mà sandbox vẫn chạy Docker.

Sandbox phải thấy cùng thư mục run với server → bind-mount `./data/runs` (hoặc dùng `./run.sh hybrid` trong Git Bash/WSL).

**PowerShell:**
```powershell
pip install -r requirements.txt

# Bật sandbox container, mount ./data/runs vào /workspace/runs
$env:SANDBOX_RUNS_MOUNT = "./data/runs"
docker compose up sandbox -d

# Key của provider muốn dùng (Python không đọc .env)
$env:ANTHROPIC_API_KEY = "<key của bạn>"
$env:USE_DOCKER = "true"
$env:SANDBOX_MODE = "persistent"
$env:SANDBOX_CONTAINER_NAME = "agent-workbench-sandbox"
$env:RUNS_DIR = "./data/runs"
python server.py        # API ở http://127.0.0.1:8000
```

### 3. Local mode (không Docker, chỉ để dev)

Code do model sinh ra chạy bằng subprocess **trên chính máy của bạn, với quyền của user hiện tại, không cách ly**. UI hiện cảnh báo *Local mode: code is not isolated*.

- Chỉ có các package đã cài trong môi trường Python chạy server. `requirements.txt` **không** gồm numpy/pandas/matplotlib…, nên các demo vẽ hình (*Draw a cute bee*, *Plot sin(x)*) sẽ lỗi `ModuleNotFoundError` trừ khi bạn tự cài các gói đó. Local mode không tự `pip install`.
- Muốn dùng Python khác cho code của model: đặt `LOCAL_PYTHON=<đường dẫn python>`.

**PowerShell:**
```powershell
pip install -r requirements.txt
$env:ANTHROPIC_API_KEY = "<key của bạn>"   # hoặc dùng Ollama local, không cần key
python server.py                             # API ở http://127.0.0.1:8000
```

**Bash/Linux:**
```bash
pip install -r requirements.txt
ANTHROPIC_API_KEY=<key của bạn> python server.py
```

Test:
```powershell
python client.py "Calculate 2 + 2 and print the result"
```

Web UI khi chạy local: `cd web && npm install && npm run dev` → http://localhost:5173 (proxy API sang :8000).
Hoặc `cd web && npm run build` rồi copy `web/dist` thành `static/` để server phục vụ UI ở :8000.

`python server.py` mặc định chỉ nghe ở `127.0.0.1` (đổi bằng `HOST`, không khuyến nghị). CORS chỉ cho Vite dev server (`CORS_ORIGINS`, mặc định `http://localhost:5173,http://127.0.0.1:5173`).

---

## Client Usage

```powershell
# Sync — đợi kết quả cuối
python client.py "Calculate pi to 100 decimal places"

# SSE streaming — xem realtime từng iteration
python client.py --stream "Generate a chart of sin(x)"

# Custom options
python client.py --stream --max-iterations 3 --timeout 60 "Your task"

# Chọn provider/model (không truyền → Claude Sonnet 4.6)
python client.py --provider ollama --model qwen3.5:4b "Your task"
python client.py --provider openai --model gpt-6-luna "Your task"

# Health check
python client.py --health

# Custom server URL
python client.py --base-url http://your-server:8000 "Your task"
```

---

## Debug Sandbox

Mỗi run có thư mục riêng, server (`/data/runs`) và sandbox (`/workspace/runs`) dùng chung volume `agent-runs`:

```bash
# Code + output của một run (lấy run id trên URL của UI: #/runs/<id>)
docker exec agent-workbench-sandbox ls -R /workspace/runs/<run_id>
docker exec agent-workbench-sandbox cat /workspace/runs/<run_id>/code/iter_01.py

# Vào shell sandbox để thử tay
docker exec -it agent-workbench-sandbox bash

# Log của agent (iteration, executor, auto-install)
docker compose logs -f agent-server
```

- `docker logs agent-workbench-sandbox` trống vì sandbox chỉ chạy `tail -f /dev/null`; log nằm ở **agent-server**.
- Package cài thêm (auto-install) còn lại trong container tới khi recreate sandbox.

---

## API

Swagger: http://localhost:8000/docs

| Method | Path | Mô tả |
|---|---|---|
| POST | `/api/runs` | Tạo run, chạy nền (`409` nếu đang có run) |
| GET | `/api/runs`, `/api/runs/{id}` | Lịch sử / chi tiết run + iterations + artifacts |
| GET | `/api/runs/{id}/events` | SSE tiến trình (`activity`, `code_progress`, `iteration`, `code`, `result`, `done`...) |
| POST | `/api/runs/{id}/stop` | Dừng run và kill process đang chạy |
| GET | `/api/runs/{id}/artifacts/{path}` | Xem/tải file (`?iteration=N`, `?download=1`) |
| GET | `/api/runs/{id}/logs` | Activity log (`?after=<id>` chỉ lấy phần mới, `?iteration=N`) |
| GET | `/api/runs/{id}/logs/download` | Tải activity log dạng text (`?iteration=N`) |
| POST | `/api/execute` | API cũ: chạy và đợi kết quả (sync) |
| POST | `/api/execute/stream` | API cũ: SSE (`session`, `iteration`, `code`, `result`, `done`, `error` + event mới) |
| GET | `/api/providers` | Catalog provider/model (`model_catalog.py`) + trạng thái: có key chưa, Ollama kết nối được/đã pull model chưa |
| GET | `/health` | Health check |

`POST /api/runs` và `/api/execute*` nhận thêm `provider`, `model` (tùy chọn). Không gửi → Claude Sonnet 4.6. Lựa chọn ngoài catalog → `422`; thiếu key / Ollama không kết nối / model chưa pull → `400` với `detail.code`. Run detail, history, response và event `session` trả `provider`, `model` (+ `provider_name`, `model_name`). Chi tiết: [PROVIDERS.vi.md](PROVIDERS.vi.md).

```bash
curl -X POST http://localhost:8000/api/execute   -H "Content-Type: application/json"   -d '{"message": "Calculate pi to 100 decimal places", "max_iterations": 5, "timeout_seconds": 30}'
curl -X POST http://localhost:8000/api/execute   -H "Content-Type: application/json"   -d '{"message": "Calculate pi", "provider": "ollama", "model": "qwen3.5:4b"}'
```

Response `status`: `success` (Completed) · `max_retries` (Code run limit reached) · `timeout` · `error` · `stopped`; kèm `answer` (kết quả hoặc kết quả tạm) và `message` (lý do kết thúc).

### Điều kiện dừng

- `max_iterations` (UI: *Max code runs*) là **số lần chạy code tối đa**, không phải số lần gọi model. Tên field giữ nguyên để client cũ không vỡ.
- Nếu lần chạy cuối thành công, model được gọi thêm **một lượt final review** để xem output và trả `DONE`. Code trả về ở lượt này **không được chạy**. Vì vậy `max_iterations=1` vẫn có thể ra `success`, và số lần gọi model tối đa là `max_iterations + 1` (chưa tính retry khi model trả JSON sai format).
- Nếu lần chạy cuối lỗi hoặc timeout, run dừng ngay, không gọi model thêm.
- Task đơn giản như "2 + 2" tốn **2 lần gọi model**: một lần viết code, một lần xác nhận `DONE`.

Bảng trạng thái đầy đủ: [ARCHITECTURE.vi.md](ARCHITECTURE.vi.md#trạng-thái).

---

## Security

Đây là project học. Các biện pháp hiện có và những gì **chưa** có:

| | Hiện trạng |
|---|---|
| Truy cập | Chỉ `127.0.0.1` (compose `127.0.0.1:8000`, `python server.py` mặc định `HOST=127.0.0.1`); CORS chỉ cho Vite dev. **Không có authentication.** |
| Persistent sandbox (compose) | Container riêng, user `sandbox` không phải root, `cap_drop: ALL`, `no-new-privileges`, memory 512 MB, 1 CPU. **Có network** (để auto `pip install`). Mọi run dùng chung 1 container, nên code của run này về lý thuyết đọc được thư mục run khác. |
| Ephemeral sandbox | Mỗi lần chạy 1 container mới, memory 256 MB, 1 CPU, **tắt network**. Chỉ dùng được khi server chạy trực tiếp trên host. |
| Local mode | **Không cách ly**: code chạy với quyền user của bạn. |
| Server (compose) | Mount `/var/run/docker.sock` để điều khiển sandbox, tức là có quyền rất rộng trên Docker của máy. |
| Timeout | Mặc định 30 giây mỗi lần chạy (`timeout -k` trong sandbox + lưới an toàn ở Python); Stop kill process thật. |
| Output | stdout cắt còn 10 KB, stderr 5 KB. |
| Secret | API key chỉ nằm ở backend; sandbox không nhận key; local mode lọc các biến môi trường chứa KEY/TOKEN/SECRET/PASSWORD khỏi subprocess; activity log được che secret. Prompt, code và stdout lưu trong SQLite thì **không** được che. |

---

## Dùng agent trực tiếp từ Python

Các module import phẳng (chạy trong thư mục project), không phải package `code_agent`. Ví dụ đầy đủ: [example.py](../../example.py).

```python
import asyncio
from agent import CodeAgent
from executor import LocalExecutor
from model_catalog import resolve
from planner import LLMPlanner
from schemas import AgentRequest

agent = CodeAgent(
    planner=LLMPlanner(resolve("anthropic", "claude-sonnet-4-6")),
    executor=LocalExecutor(timeout=30),   # hoặc PersistentSandboxExecutor(container_name="agent-workbench-sandbox")
)
result = asyncio.run(agent.run(AgentRequest(message="What is the sum of primes below 1000?")))
print(result.status, result.answer)
```

---

## Cấu trúc files

```
agent-workbench/
├── schemas.py          # Pydantic data models + trạng thái
├── planner.py          # LLM Planner (streaming, provider theo run)
├── model_catalog.py    # Danh sách provider/model + default (sửa ở đây để thêm/bớt model)
├── llm_providers.py    # Adapter Anthropic / OpenAI / Ollama, lỗi chuẩn hóa, trạng thái
├── executor.py         # Sandbox Executor (3 modes, timeout, kill, auto-install)
├── agent.py            # Agent loop (feedback loop) — duy nhất
├── runs.py             # RunManager: background run, Stop, event → SQLite/SSE
├── store.py            # SQLite history + activity log (run_logs)
├── runlog.py           # Format log entry, nguồn/mức log, che secret
├── workspace.py        # Thư mục + artifacts theo run, chặn path traversal
├── server.py           # FastAPI server + phục vụ web UI
├── client.py           # CLI client (sync + SSE)
├── example.py          # Test script (direct, no server)
├── web/                # React + Vite + Tailwind + shadcn/ui
├── tests/              # pytest (mock planner) + test sandbox thật (DOCKER_SANDBOX_TESTS=1)
├── Dockerfile.sandbox  # Sandbox container image
├── Dockerfile.server   # Build web UI + server image
├── docker-compose.yml  # Server + persistent sandbox + volumes
├── run.sh              # Lối tắt cho Git Bash/WSL: local | docker | hybrid | web | check | test
├── .env.example        # Mẫu cấu hình (copy thành .env, không commit .env)
└── docs/vi/                     # tài liệu tiếng Việt: QUICKSTART, ARCHITECTURE, PROVIDERS, TROUBLESHOOTING, NEXT_STEPS, FEATURE_MAP
```
