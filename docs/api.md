# API, CLI and security notes

Interactive Swagger docs are served at <http://localhost:8000/docs> when the server is running.

## HTTP API

| Method | Path | Description |
|---|---|---|
| POST | `/api/runs` | Create a run and execute it in the background (`409` if a run is active) |
| GET | `/api/runs`, `/api/runs/{id}` | History / details of a run + iterations + artifacts |
| GET | `/api/runs/{id}/events` | SSE progress (`activity`, `code_progress`, `iteration`, `code`, `result`, `done`, ...) |
| POST | `/api/runs/{id}/stop` | Stop the run and kill the running process |
| GET | `/api/runs/{id}/artifacts/{path}` | View/download a file (`?iteration=N`, `?download=1`) |
| GET | `/api/runs/{id}/logs` | Activity log (`?after=<id>` returns only newer entries, `?iteration=N`) |
| GET | `/api/runs/{id}/logs/download` | Download the activity log as text (`?iteration=N`) |
| POST | `/api/execute` | Legacy API: run and wait for the result (sync) |
| POST | `/api/execute/stream` | Legacy API: SSE (`session`, `iteration`, `code`, `result`, `done`, `error` + the newer events) |
| GET | `/api/config` | Defaults and limits used by the UI form |
| GET | `/api/providers` | Provider/model catalog (`model_catalog.py`) + readiness: key present, Ollama reachable / model pulled |
| GET | `/health` | Health check |

`POST /api/runs` and `/api/execute*` accept optional `provider` and `model` fields. If omitted, Claude Sonnet 4.6 is used. A choice outside the catalog returns `422`; a missing key, an unreachable Ollama or an unpulled model returns `400` with `detail.code`. Run details, history, responses and the `session` event include `provider`, `model` (+ `provider_name`, `model_name`). See [providers.md](providers.md).

```bash
curl -X POST http://localhost:8000/api/execute -H "Content-Type: application/json" \
  -d '{"message": "Calculate pi to 100 decimal places", "max_iterations": 5, "timeout_seconds": 30}'
curl -X POST http://localhost:8000/api/execute -H "Content-Type: application/json" \
  -d '{"message": "Calculate pi", "provider": "ollama", "model": "qwen3.5:4b"}'
```

Response `status`: `success` (Completed) · `max_retries` (Code run limit reached) · `timeout` · `error` · `stopped`; plus `answer` (the result, or a partial result) and `message` (why the run ended).

### Stop conditions

- `max_iterations` (UI: *Max code runs*) is the **maximum number of code runs**, not the number of model calls. The field name is kept so that older clients do not break.
- If the last run succeeds, the model is called **once more for a final review** to look at the output and answer `DONE`. Code returned in that turn is **not run**. So `max_iterations=1` can still end in `success`, and the maximum number of model calls is `max_iterations + 1` (not counting retries for malformed JSON).
- If the last run fails or times out, the run stops immediately and the model is not called again.
- A trivial task such as "2 + 2" costs **two model calls**: one to write the code and one to confirm `DONE`.

The full status table is in [architecture.md](architecture.md#run-status).

## CLI client

```bash
# Sync: wait for the final result
python client.py "Calculate pi to 100 decimal places"

# SSE streaming: watch every iteration in real time
python client.py --stream "Generate a chart of sin(x)"

# Custom options
python client.py --stream --max-iterations 3 --timeout 60 "Your task"

# Choose a provider/model (default: Claude Sonnet 4.6)
python client.py --provider ollama --model qwen3.5:4b "Your task"
python client.py --provider openai --model gpt-6-luna "Your task"

# Health check, and a custom server URL
python client.py --health
python client.py --base-url http://localhost:8000 "Your task"
```

## Executor modes

| Mode | Environment | Description |
|---|---|---|
| **Local** | `USE_DOCKER=false` (the default for `python server.py`) | A subprocess on the machine running the server, **not isolated**. Development only; the UI shows a *Local mode* warning |
| **Ephemeral** | `USE_DOCKER=true`, `SANDBOX_MODE=ephemeral` | A new container for each run, removed afterwards |
| **Persistent** | `USE_DOCKER=true`, `SANDBOX_MODE=persistent` | A sandbox that is always running; code runs through `docker exec`, which makes it easy to debug (the Docker Compose default) |

Hybrid setup (server as Python, sandbox in Docker): the sandbox must see the same run directories as the server, so bind-mount `./data/runs`:

```powershell
pip install -r requirements.txt
$env:SANDBOX_RUNS_MOUNT = "./data/runs"
docker compose up sandbox -d
$env:ANTHROPIC_API_KEY = "<your key>"      # Python does not read .env
$env:USE_DOCKER = "true"
$env:SANDBOX_MODE = "persistent"
$env:SANDBOX_CONTAINER_NAME = "agent-workbench-sandbox"
$env:RUNS_DIR = "./data/runs"
python server.py                            # API on http://127.0.0.1:8000
```

`./run.sh hybrid` does the same in Git Bash/WSL.

## Using the agent directly from Python

The modules use flat imports (run from the repository root); there is no installable package. A complete example is in [example.py](../example.py).

```python
import asyncio
from agent import CodeAgent
from executor import LocalExecutor
from model_catalog import resolve
from planner import LLMPlanner
from schemas import AgentRequest

agent = CodeAgent(
    planner=LLMPlanner(resolve("anthropic", "claude-sonnet-4-6")),
    executor=LocalExecutor(timeout=30),   # or PersistentSandboxExecutor(container_name="agent-workbench-sandbox")
)
result = asyncio.run(agent.run(AgentRequest(message="What is the sum of primes below 1000?")))
print(result.status, result.answer)
```

## Debugging the sandbox

Each run has its own directory; the server (`/data/runs`) and the sandbox (`/workspace/runs`) share the `agent-runs` volume:

```bash
# Code + output of one run (the run id is in the UI URL: #/runs/<id>)
docker exec agent-workbench-sandbox ls -R /workspace/runs/<run_id>
docker exec agent-workbench-sandbox cat /workspace/runs/<run_id>/code/iter_01.py

# A shell inside the sandbox
docker exec -it agent-workbench-sandbox bash

# Agent logs (iterations, executor, auto-install)
docker compose logs -f agent-server
```

`docker logs agent-workbench-sandbox` is empty because the sandbox only runs `tail -f /dev/null`; the logs are in **agent-server**. Packages added by auto-install stay in the container until it is recreated.

## Security notes

This is a learning/showcase project. What exists today, and what does **not**:

| Area | Current state |
|---|---|
| Access | `127.0.0.1` only (Compose publishes `127.0.0.1:8000`, `python server.py` defaults to `HOST=127.0.0.1`); CORS only allows the Vite dev server. **No authentication.** |
| Persistent sandbox (Compose) | A separate container, non-root user `sandbox`, `cap_drop: ALL`, `no-new-privileges`, 512 MB memory, 1 CPU. **Network is enabled** (for auto `pip install`). All runs share one container, so code in one run could in theory read another run's directory. |
| Ephemeral sandbox | A new container per run, 256 MB memory, 1 CPU, **network disabled**. Only works when the server runs directly on the host. |
| Local mode | **Not isolated**: code runs with your user's permissions. |
| Server (Compose) | Mounts `/var/run/docker.sock` to control the sandbox, which gives it very broad control over the host's Docker. |
| Timeout | 30 seconds per code run by default (`timeout -k` in the sandbox + a Python safety net); Stop kills the real process. |
| Output | stdout is truncated to 10 KB and stderr to 5 KB. |
| Secrets | API keys exist only in the backend; the sandbox does not receive keys; local mode filters environment variables containing KEY/TOKEN/SECRET/PASSWORD out of the subprocess; the activity log is redacted. Prompts, code and stdout stored in SQLite are **not** redacted. |

These measures have not been independently reviewed. Do not expose the server beyond localhost.
