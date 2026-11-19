# Troubleshooting: Agent Workbench

Lỗi thường gặp khi cài và chạy. Cách chạy chuẩn: [QUICKSTART.vi.md](QUICKSTART.vi.md). Lỗi riêng của provider/model (key sai, Ollama không kết nối được, model chưa pull): [PROVIDERS.vi.md](PROVIDERS.vi.md) mục 3 và 5.

Mọi lệnh `docker compose` và `python ...` phải chạy **trong thư mục chứa `docker-compose.yml`**. Compose tìm `.env` ở đó, và code import kiểu phẳng (`from schemas import ...`).

## 1. Biến môi trường được đọc thế nào

| Cách chạy | Có đọc file `.env` không? | Ghi chú |
|---|---|---|
| `docker compose up` | **Có**, nhưng chỉ để thay các biến `${...}` trong `docker-compose.yml` | Biến đưa vào container: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OLLAMA_BASE_URL`, `MAX_ITERATIONS`, `EXECUTION_TIMEOUT`; `BIND_ADDRESS` dùng cho port. `USE_DOCKER`, `SANDBOX_MODE`… được cố định trong compose. |
| `./run.sh local\|hybrid\|docker` (Git Bash/WSL) | **Có** (`source .env`) | |
| `python server.py` | **Không** | Project không dùng python-dotenv. Đặt biến trong shell, hoặc dùng `envFile` của VS Code (mục 4). |

**Biến của shell được ưu tiên hơn `.env`.** Nếu phiên PowerShell hoặc `~/.bashrc` còn một `ANTHROPIC_API_KEY` cũ, compose sẽ dùng key đó.

### Kiểm tra key mà không làm lộ key

```bash
# Trong container: chỉ in độ dài
docker compose exec agent-server sh -c 'if [ -n "$ANTHROPIC_API_KEY" ]; then echo "key set (${#ANTHROPIC_API_KEY} chars)"; else echo "key EMPTY"; fi'
```

Hoặc mở UI: ô **Provider** cho biết provider nào *not configured*.

**Đừng** chạy `cat .env`, `docker compose config` (lệnh này in toàn bộ config đã thay biến, **gồm cả key**), `docker inspect <container>` (có phần `Env`) hay `printenv`, và đừng chụp màn hình kết quả của chúng. Lỡ làm lộ key thì revoke key trên console của provider và tạo key mới.

`.env` phải xuống dòng kiểu LF nếu dùng `run.sh`: file CRLF làm `source .env` dính ký tự `\r` vào cuối key.

## 2. Bảng lỗi

| Triệu chứng | Nguyên nhân | Cách xử lý |
|---|---|---|
| `WARN ... The "ANTHROPIC_API_KEY" variable is not set` khi `docker compose up` | Chạy sai thư mục, hoặc `.env` không có key đó | Bình thường nếu bạn không dùng provider đó (ví dụ chỉ dùng Ollama). Nếu cần: `cd` đúng thư mục, điền key vào `.env`, rồi `docker compose up -d --force-recreate agent-server` |
| Tạo run bị từ chối: `400`, `detail.code = not_configured` | Thiếu key của provider đã chọn | Như trên. Không có fallback sang provider khác |
| Run **Failed**, log `llm` có `error_kind: auth` | Key sai hoặc đã bị revoke | Sửa `.env`, kiểm tra biến shell cũ có đang ghi đè không, rồi `--force-recreate agent-server` |
| `model_not_found` | Sai model ID hoặc key không có quyền dùng model đó | Danh sách model nằm trong `model_catalog.py` (biến `LLM_MODEL` cũ không còn được dùng). Xem PROVIDERS.vi.md mục 1 |
| `Server unreachable` / `Connection refused` | Server chưa chạy hoặc đang crash | `docker compose ps`, `docker compose logs agent-server` |
| Máy khác trong mạng không mở được `:8000` | **Chủ đích.** Port chỉ publish ở `127.0.0.1` | Giữ nguyên. Muốn demo cho máy khác: `BIND_ADDRESS=0.0.0.0` trong `.env`. Server không có auth, nên ai vào được là chạy được code và dùng key của bạn |
| Gọi API từ một trang web khác bị lỗi CORS | **Chủ đích.** CORS chỉ cho `http://localhost:5173` và `http://127.0.0.1:5173` (Vite dev) | Đổi `CORS_ORIGINS` nếu thật sự cần |
| `Bind for 0.0.0.0:8000 failed` / `127.0.0.1:8000 ... port is already allocated` | Port 8000 bị chiếm, thường do server hybrid đang chạy | Dừng server Python, hoặc `docker compose stop agent-server` trước khi chạy hybrid |
| `409 Another run is in progress` | Chỉ 1 run chạy tại một thời điểm | Chờ, hoặc bấm **Stop** |
| Run **Failed** với `Sandbox error: Container 'agent-workbench-sandbox' not found. Run: docker compose up sandbox -d` | Sandbox chưa được tạo | `docker compose up -d sandbox` |
| `Sandbox cannot see /workspace/runs/<id>/code/iter_01.py` | Hybrid mode: server và sandbox không dùng chung thư mục runs | Bật sandbox với `SANDBOX_RUNS_MOUNT=./data/runs` và chạy server với `RUNS_DIR=./data/runs` (README mục 2), hoặc dùng `./run.sh hybrid` |
| `Conflict. The container name "/agent-workbench-sandbox" is already in use` | Còn container `agent-workbench-sandbox` cũ tạo ngoài compose | `docker ps -a --filter name=agent-workbench-sandbox`; chắc chắn là container cũ thì `docker rm -f agent-workbench-sandbox` |
| `Permission denied ... docker.sock` (hybrid trong WSL) | User WSL không thuộc group `docker` | `sudo usermod -aG docker $USER`, rồi `wsl --shutdown` và mở lại |
| `docker: command not found` trong WSL | Chưa bật WSL integration | Docker Desktop → Settings → Resources → WSL integration → bật distro |
| `agent-server` `Restarting` liên tục | Server lỗi khi khởi động, ví dụ không kết nối được Docker socket | `docker compose logs agent-server` |
| Docker báo `additional privileges requested: pass "--allow=fs.read=..."` | Bake builder | `docker build -f Dockerfile.server -t agent-workbench-agent-server . && docker compose up -d --no-build agent-server` |
| `ModuleNotFoundError: No module named 'seaborn'` (hoặc gói khác) trong **sandbox** | Gói không có trong image | Persistent sandbox tự `pip install` rồi chạy lại (cần network). Gói đã cài còn tới khi recreate sandbox |
| `ModuleNotFoundError: No module named 'matplotlib'` trong **local mode** | Local mode chỉ có các gói của môi trường Python chạy server, và không tự cài | Dùng Docker Compose, hoặc tự cài gói đó vào môi trường của `LOCAL_PYTHON` |
| UI hiện *Local mode: code is not isolated* | Server chạy `LocalExecutor` (`python server.py` không đặt `USE_DOCKER=true`) | Bình thường khi dev. Dùng Docker Compose nếu muốn sandbox |
| `ModuleNotFoundError: No module named 'schemas'` | Chạy `python server.py` sai thư mục | `cd` vào thư mục project |
| Status **Code run limit reached** dù output trông đúng | Model đã xem output ở lượt final review nhưng chưa trả `DONE`, hoặc lần chạy cuối bị lỗi | Xem log của iteration cuối. Tăng *Max code runs* hoặc làm prompt rõ hơn. Ngữ nghĩa: [ARCHITECTURE.vi.md](ARCHITECTURE.vi.md#trạng-thái) |
| Log `Exit code 0 but the output looks like an error — treating this run as failed` | Heuristic false-success: dòng đầu stdout (dưới 200 ký tự) chứa `error:`, `not found`, `could not`… | Hành vi có chủ ý (tầng 2 trong slide lab). Nếu bị bắt nhầm, yêu cầu code in nội dung khác ở dòng đầu |
| Run **Failed**: `Interrupted: the server restarted while this run was in progress.` | Server bị tắt hoặc restart khi run đang chạy | Chạy lại run. Hiện chưa hỗ trợ resume |
| `docker logs agent-workbench-sandbox` trống | Sandbox chỉ chạy `tail -f /dev/null`; code chạy bằng `docker exec` | Xem log ở `docker compose logs -f agent-server` hoặc tab **Logs** trên UI |
| PowerShell: `curl` báo lỗi lạ về `Invoke-WebRequest` | Trong Windows PowerShell 5.1, `curl` là alias | Dùng `curl.exe` hoặc `Invoke-RestMethod` |
| WSL: `ensurepip is not available` khi tạo venv | Thiếu `python3-venv` | `sudo apt install -y python3-venv` |

## 3. Xem và dọn dữ liệu

```bash
# Code + output của một run (run id lấy trên URL của UI: #/runs/<id>)
docker exec agent-workbench-sandbox ls -R /workspace/runs/<run_id>
docker exec -it agent-workbench-sandbox bash                 # shell trong sandbox

docker compose up -d --force-recreate sandbox     # sandbox sạch (bỏ các gói đã auto-install)
docker compose down                               # dừng, GIỮ lịch sử + artifacts (volume agent-db, agent-runs)
docker compose down -v                            # dừng và XÓA lịch sử + artifacts
```

Lịch sử run (prompt, code, output) nằm trong volume `agent-db`/`agent-runs` khi dùng compose, hoặc thư mục `data/` khi chạy bằng Python. Khi chia sẻ project bằng file zip, **đừng** gửi kèm `.env`, `data/` và `.venv/`.

## 4. Debug server bằng VS Code (hybrid)

Sandbox chạy trong Docker, server chạy bằng Python để đặt breakpoint.

1. Tạo venv và cài dependency một lần: `python -m venv .venv`, rồi `.venv\Scripts\pip install -r requirements-dev.txt` (Windows) hoặc `.venv/bin/pip …` (WSL). venv tạo bên Windows không dùng được trong WSL và ngược lại.
2. Bật sandbox dùng chung thư mục runs với server:

   ```powershell
   $env:SANDBOX_RUNS_MOUNT = "./data/runs"; docker compose up -d sandbox
   docker compose stop agent-server   # giải phóng port 8000 nếu đang chạy compose
   ```

3. Tạo `.vscode/launch.json` (gợi ý; project không có sẵn file này):

   ```jsonc
   {
     "version": "0.2.0",
     "configurations": [
       {
         "name": "agent-workbench: server (hybrid)",
         "type": "debugpy",
         "request": "launch",
         "program": "${workspaceFolder}/server.py",
         "cwd": "${workspaceFolder}",
         // VS Code nạp .env vào process; Python không tự làm việc này
         "envFile": "${workspaceFolder}/.env",
         // "env" được ưu tiên hơn envFile
         "env": {
           "USE_DOCKER": "true",
           "SANDBOX_MODE": "persistent",
           "SANDBOX_CONTAINER_NAME": "agent-workbench-sandbox",
           "RUNS_DIR": "./data/runs"
         },
         "justMyCode": false
       }
     ]
   }
   ```

4. Điểm đặt breakpoint hữu ích:
   - `planner.py` `LLMPlanner.generate_code`: xem `messages` gửi cho model;
   - `agent.py` `CodeAgent._loop`: điều kiện dừng;
   - `executor.py` `_run_with_auto_install`: auto-install.
5. F5, rồi mở http://127.0.0.1:8000. UI cần bản build trong `static/`; nếu chưa có thì chạy `cd web && npm run dev` và mở http://localhost:5173. Hoặc gọi bằng `python client.py --stream "..."`.

Dừng ở breakpoint quá lâu thì client CLI có thể báo `ReadTimeout` (timeout 600 giây). Xong việc: dừng debug rồi `docker compose up -d agent-server`.

## 5. Lệnh PowerShell tương đương

```powershell
# Nhập key cho phiên hiện tại mà không lưu ra file (biến shell được ưu tiên hơn .env)
$sec = Read-Host -AsSecureString "ANTHROPIC_API_KEY"
$env:ANTHROPIC_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))

curl.exe -s http://localhost:8000/health
Invoke-RestMethod http://localhost:8000/health

# SSE thô
curl.exe -N http://localhost:8000/api/execute/stream -H "Content-Type: application/json" -d '{\"message\": \"Calculate 2 + 2 and print the result\"}'

# CLI client chạy bên trong container (không cần Python trên máy)
docker compose exec agent-server python client.py --stream "Calculate 2 + 2 and print the result"
```

`Read-Host` chỉ dùng được khi bạn tự gõ trong terminal tương tác.
