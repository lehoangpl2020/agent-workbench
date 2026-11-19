#!/usr/bin/env bash
# Runs the Code Execution Agent / Agent Workbench
#   ./run.sh local    - run the server with Python; code runs in a NON-isolated subprocess (dev only, default)
#   ./run.sh docker   - build + run the server (API + Web UI) and the sandbox with docker compose
#   ./run.sh hybrid   - sandbox in Docker, server in Python
#   ./run.sh web      - run the Vite dev server for the UI (http://localhost:5173, proxies to :8668)
#   ./run.sh check    - run the offline tests (mock planner, no model API calls)
#   ./run.sh test     - send one task to the running server (a REAL model call: the server default, local Ollama qwen3.5:4b)
set -euo pipefail
cd "$(dirname "$0")"

MODE="${1:-local}"

load_env() {
  if [ -f .env ]; then
    set -a; source .env; set +a
  fi
  # No key is mandatory: a provider without a key just reports "not configured"
  # (local Ollama needs no key). See docs/providers.md.
  if [ -z "${ANTHROPIC_API_KEY:-}${OPENAI_API_KEY:-}" ]; then
    echo "Note: no ANTHROPIC_API_KEY/OPENAI_API_KEY in .env — only local Ollama can be used." >&2
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
    echo "Web UI + API: http://localhost:8668"
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
    # The sandbox bind-mounts ./data/runs to see the code/output the host server writes
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
    echo "Usage: ./run.sh [docker|local|hybrid|web|check|test]" >&2
    exit 1
    ;;
esac
