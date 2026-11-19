# Quickstart: Agent Workbench

Chạy trong terminal (WSL Ubuntu, Git Bash hoặc PowerShell) tại thư mục chứa `docker-compose.yml`. Cần Docker Desktop đang bật.
Kiến trúc và luồng code: [ARCHITECTURE.vi.md](ARCHITECTURE.vi.md).

## 1. Cấu hình môi trường

Copy `.env.example` thành `.env` cạnh `docker-compose.yml` (file này đã được git ignore) và tự điền key của provider muốn dùng. Không dán key vào chat:

```bash
ANTHROPIC_API_KEY=<key của bạn>   # Claude (default: Claude Sonnet 4.6)
OPENAI_API_KEY=<key của bạn>      # tùy chọn
# Ollama local: không cần key; compose mặc định trỏ http://host.docker.internal:11434
```

Tùy chọn trong `.env`: `OLLAMA_BASE_URL`, `MAX_ITERATIONS` (5, số lần chạy code tối đa), `EXECUTION_TIMEOUT` (30). Danh sách model nằm trong `model_catalog.py`; cách thêm model, kết nối Ollama từ Docker/WSL và các lỗi thường gặp: [PROVIDERS.vi.md](PROVIDERS.vi.md).

## 2. Build và start

```bash
docker compose up -d --build
docker compose ps        # agent-server (healthy) + agent-workbench-sandbox (Up)
```

Nếu Docker báo `additional privileges requested: pass "--allow=fs.read=..."`: `docker build -f Dockerfile.server -t agent-workbench-agent-server . && docker compose up -d --no-build agent-server`.

## 3. Mở app

**http://localhost:8000**: Web UI và API cùng một cổng (API docs: http://localhost:8000/docs).

Chỉ máy của bạn mở được địa chỉ này (port publish ở `127.0.0.1`). Server chạy code do model sinh ra và không có auth, nên đừng mở ra mạng LAN.

## 4. Thử demo

1. Gõ `Calculate 2 + 2 and print the result`, bấm **Run**. Kết quả: **Completed**, Preview hiện `4`. Dưới ô prompt có **Provider** / **Model** (mặc định Claude Sonnet 4.6) và dòng *Runs with …* cho biết model sẽ dùng; thử chọn `Ollama (local)` → `Qwen 3.5 4B` để chạy miễn phí trên máy.
2. Bấm **Draw a cute bee** (chỉ điền prompt), bấm **Run**. Ảnh `bee.png` hiện trong Preview; tải bằng nút **Download**.
3. Bấm **Plot sin(x)**, bấm **Run**.
4. Refresh trình duyệt rồi mở lại run trong **History**.
5. Timeout: đặt *Max code runs* = 1, *Execution timeout* = 3 với prompt chạy lâu, kết quả là **Timed out**. Stop: bấm **Stop** khi run đang *Executing*, kết quả là **Stopped** và process trong sandbox bị kill.

*Max code runs* là số lần chạy code tối đa. Nếu lần chạy cuối thành công, model được gọi thêm một lượt chỉ để xác nhận `DONE` (không chạy code nữa). Chi tiết: [ARCHITECTURE.vi.md](ARCHITECTURE.vi.md#trạng-thái). Gặp lỗi: [TROUBLESHOOTING.vi.md](TROUBLESHOOTING.vi.md).

CLI vẫn dùng được: `python client.py --stream "Calculate 2 + 2 and print the result"` (cần `pip install httpx`). Chọn model: `--provider ollama --model qwen3.5:4b`.

## 5. Kiểm tra (offline, không gọi Claude API)

```bash
python -m venv .venv && .venv/bin/pip install -r requirements-dev.txt   # Windows: .venv\Scripts\pip
.venv/bin/python -m pytest tests -q
```

## 6. Stop

```bash
docker compose down        # giữ lịch sử + artifacts (volume agent-db, agent-runs)
docker compose down -v     # xóa luôn dữ liệu
```
