#!/usr/bin/env bash
# Chạy Code Execution Agent / Agent Workbench
#   ./run.sh local    - chạy server bằng Python, code chạy bằng subprocess KHÔNG cách ly (chỉ để dev, mặc định)
#   ./run.sh docker   - build + chạy server (API + Web UI) + sandbox bằng docker compose
#   ./run.sh hybrid   - sandbox bằng Docker, server bằng Python
#   ./run.sh web      - chạy Vite dev server cho UI (http://localhost:5173, proxy tới :8000)
#   ./run.sh check    - chạy test offline (mock planner, không gọi Claude API)
#   ./run.sh test     - gửi thử 1 task tới server đang chạy (gọi Claude API thật)
set -euo pipefail
cd "$(dirname "$0")"

MODE="${1:-local}"

load_env() {
  if [ -f .env ]; then
    set -a; source .env; set +a
  fi
  # Không bắt buộc key nào: thiếu key của provider nào thì chỉ provider đó báo "not configured"
  # (Ollama local không cần key). Xem PROVIDERS.vi.md.
  if [ -z "${ANTHROPIC_API_KEY:-}${OPENAI_API_KEY:-}" ]; then
    echo "Lưu ý: chưa có ANTHROPIC_API_KEY/OPENAI_API_KEY trong .env — chỉ dùng được Ollama local." >&2
  fi
}

setup_venv() {
  if [ ! -d .venv ]; then
    python3 -m venv .venv
    .venv/bin/pip install -q --upgrade pip
    .venv/bin/pip install -q -r requirements-dev.txt
  fi
  source .venv/bin/activate
}

case "$MODE" in
  docker)
    load_env
    echo "Web UI + API: http://localhost:8000"
    docker compose up --build
    ;;
  local)
    load_env
    setup_venv
    USE_DOCKER=false python server.py
    ;;
  hybrid)
    load_env
    setup_venv
    mkdir -p data/runs
    # Sandbox bind-mount ./data/runs để thấy code/output do server trên host ghi ra
    SANDBOX_RUNS_MOUNT=./data/runs docker compose up sandbox -d --build
    USE_DOCKER=true SANDBOX_MODE=persistent SANDBOX_CONTAINER_NAME=agent-workbench-sandbox \
      RUNS_DIR=./data/runs python server.py
    ;;
  web)
    (cd web && npm install && npm run dev)
    ;;
  check)
    setup_venv
    python -m pytest tests -q
    ;;
  test)
    setup_venv
    python client.py --health
    python client.py --stream "${2:-Calculate 2 + 2 and print the result}"
    ;;
  *)
    echo "Cách dùng: ./run.sh [docker|local|hybrid|web|check|test]" >&2
    exit 1
    ;;
esac
