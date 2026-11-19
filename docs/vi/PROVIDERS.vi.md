# Providers & models (Anthropic · OpenAI · Ollama)

Người dùng chọn **Provider** và **Model** khi tạo run. Provider/model đó được lưu vào run và giữ nguyên cho mọi iteration (viết code, sửa lỗi, đánh giá DONE). Run mới mặc định dùng **Claude Sonnet 4.6** (`anthropic` / `claude-sonnet-4-6`), kể cả request từ CLI/API cũ không gửi lựa chọn.

## 1. Thêm/bớt model: chỉ sửa `model_catalog.py`

| Muốn | Sửa |
|---|---|
| Thêm/bớt model của provider có sẵn | Thêm/xóa một dòng `ModelSpec(...)` trong `CATALOG` (`model_catalog.py`) |
| Đổi model chọn sẵn khi user đổi provider | `provider_default=True` (mỗi provider đúng 1 model) |
| Đổi default của cả app | `DEFAULT_PROVIDER`, `DEFAULT_MODEL` |
| Tham số riêng của model | `max_output_tokens`, `options` (`reasoning_effort` cho OpenAI; `num_ctx`, `think` cho Ollama) |
| Thêm provider mới | `PROVIDERS` + một adapter mới trong `llm_providers.py` |

Sau khi sửa, build lại server (mục 4). UI tự lấy danh sách qua `GET /api/providers`; frontend không có danh sách riêng. `tests/test_providers.py::test_catalog_is_consistent` kiểm tra catalog hợp lệ.

Model Ollama phải được **tự pull trước** (`ollama pull <model>`). App không bao giờ tự tải model.

## 2. Cấu hình (biến môi trường của backend)

| Biến | Dùng cho | Ghi chú |
|---|---|---|
| `ANTHROPIC_API_KEY` (hoặc `ANTHROPIC_AUTH_TOKEN`) | Anthropic | |
| `OPENAI_API_KEY` | OpenAI | `OPENAI_BASE_URL` tùy chọn (mặc định `https://api.openai.com/v1`) |
| `OLLAMA_BASE_URL` | Ollama | Xem mục 3. Mặc định trong code: `http://localhost:11434`; trong `docker-compose.yml`: `http://host.docker.internal:11434` |

Điền key vào `.env` (mẫu ở `.env.example`). Không dán key vào chat, không commit `.env`. Thiếu key của provider nào thì chỉ provider đó báo *not configured*; các provider khác vẫn chạy.

## 3. Kết nối Ollama (Ollama chạy trên Windows)

Địa chỉ phải đúng **từ chỗ backend đang chạy**, không phải từ trình duyệt:

| Backend chạy ở | `OLLAMA_BASE_URL` |
|---|---|
| Docker (`docker compose`) | `http://host.docker.internal:11434` (đã đặt sẵn trong compose; compose có thêm `extra_hosts` cho Docker Engine trên Linux/WSL) |
| Python trực tiếp trên Windows | `http://localhost:11434` |
| WSL2, networking `mirrored` | `http://localhost:11434` |
| WSL2, NAT (mặc định) | `http://<IP Windows>:11434`. Lấy IP bằng `ip route show default \| awk '{print $3}'` trong WSL. Ollama phải lắng nghe ngoài loopback: đặt biến `OLLAMA_HOST=0.0.0.0` trên Windows rồi khởi động lại Ollama, và cho phép cổng 11434 qua firewall |

Kiểm tra từ chính môi trường backend:

```bash
docker compose exec agent-server curl -s http://host.docker.internal:11434/api/version   # backend Docker
curl -s http://localhost:11434/api/tags                                                  # backend Windows/WSL mirrored
```

Hoặc mở UI: dòng trạng thái dưới ô Model ghi *ready*, *Not pulled yet* hoặc *Cannot connect to Ollama*. Bấm **Re-check** để kiểm tra lại (chỉ gọi `/api/tags`, không tải model).

## 4. Chạy

```bash
docker compose up -d --build
# Nếu Docker báo "additional privileges requested: pass --allow=fs.read=..." (bake builder):
docker build -f Dockerfile.server -t agent-workbench-agent-server . && docker compose up -d --no-build agent-server
```

CLI:

```bash
python client.py "Compute 17 * 23"                                       # default Claude Sonnet 4.6
python client.py --provider ollama --model qwen3.5:4b --stream "Compute 17 * 23"
python client.py --provider openai --model gpt-6-luna "Compute 17 * 23"
```

## 5. Lỗi được phân biệt

Trả về khi tạo run (`POST /api/runs`, `/api/execute*`), nên không có run nào được tạo:

| HTTP | `detail.code` | Ý nghĩa |
|---|---|---|
| 422 | `invalid_provider` / `invalid_model` | Provider/model không có trong catalog (backend không tin giá trị tùy ý từ client) |
| 400 | `not_configured` | Thiếu API key |
| 400 | `connection` | Không kết nối được Ollama tại `OLLAMA_BASE_URL` |
| 400 | `model_not_pulled` | Ollama chạy nhưng chưa pull model |

Lỗi khi đang gọi model: run kết thúc **Failed**, log `llm` ghi `error_kind` + `http_status`:

| `error_kind` | Ý nghĩa |
|---|---|
| `auth` | Key sai hoặc hết hạn (401) |
| `permission` | Provider từ chối quyền truy cập (403) |
| `model_not_found` | Sai model ID hoặc key không có quyền dùng model đó (404) |
| `rate_limit` | 429: rate limit hoặc hết credit |
| `connection` / `timeout` | Không kết nối được / kết nối được nhưng quá lâu không có dữ liệu |
| `bad_request`, `provider_error` | 400 khác / 5xx |

Không có fallback: lỗi ở provider/model nào thì báo đúng ở đó, không tự chuyển sang provider khác.

## 6. Khác biệt giữa các provider (adapter trong `llm_providers.py`)

| | Anthropic | OpenAI | Ollama |
|---|---|---|---|
| API | Messages API, SDK `anthropic` (`AsyncAnthropic`) | Responses API `POST /v1/responses` (httpx, SSE) | `POST /api/chat` (httpx, NDJSON) |
| System prompt | `system` | `instructions` | message `role: system` |
| Giới hạn output | `max_tokens` | `max_output_tokens` (tính cả reasoning tokens) | `options.num_predict` |
| Ép JSON | Không (system prompt + parse + format retry như cũ) | `text.format` json_schema `strict` | `format` = JSON schema |
| Riêng | Không gửi `thinking`/`temperature` | `reasoning.effort`, `store: false`, không gửi `temperature` | `think: false`, `options.num_ctx` |
| Tokens ghi log | `usage` của response | `usage` trong `response.completed` | `prompt_eval_count`, `eval_count` |

Tokens chỉ được ghi khi provider thực sự trả về. Nội dung thinking của model (nếu có) không được hiển thị.

Run cũ (tạo trước khi có multi-provider) giữ nguyên model đã lưu, provider để trống (*provider not recorded*); app không gán default mới cho các run đó. Replay chỉ đọc dữ liệu đã lưu, không gọi model.
