# Providers and models (Anthropic, OpenAI, Ollama)

The user picks a **provider** and a **model** when creating a run. That choice is stored with the run and stays fixed for every iteration (writing code, fixing errors, the final DONE review). A new run defaults to **Ollama `qwen3.5:4b`** (`ollama` / `qwen3.5:4b`), including requests from the CLI or the legacy API that send no choice, and the UI preselects it. If the default is not available (Ollama unreachable or the model not pulled), creating the run fails with a clear error; the app never switches to another model or provider. Old runs keep their stored provider/model (or none); the default is never written into them.

## 1. Adding or removing models: edit `model_catalog.py`

| To... | Change |
|---|---|
| Add or remove a model of an existing provider | Add or delete a `ModelSpec(...)` line in `CATALOG` (`model_catalog.py`) |
| Change the model preselected when the user switches provider | Set `provider_default=True` (exactly one model per provider) |
| Change the app-wide default | `DEFAULT_PROVIDER`, `DEFAULT_MODEL` |
| Set per-model parameters | `max_output_tokens`, `options` (`reasoning_effort` for OpenAI; `num_ctx`, `think` for Ollama) |
| Add a new provider | `PROVIDERS` plus a new adapter in `llm_providers.py` |

After editing, rebuild the server image (see section 4). The UI reads the list from `GET /api/providers`; the frontend keeps no list of its own. `tests/test_providers.py::test_catalog_is_consistent` checks that the catalog is valid.

Ollama models must be **pulled by you beforehand** (`ollama pull <model>`). The app never downloads a model.

The Ollama catalog entries use the exact tags from `ollama list`: `qwen3.5:4b` (default), `qwen3.8:latest` and `gemma4:12b`. A tag is matched exactly (`qwen3.8` does not select `qwen3.8:latest` in the catalog). The per-model `options` (`num_ctx`, `think`) and the output cap are application settings; check a model's real capabilities with `ollama show <tag>` instead of inferring them from its name.

## 2. Configuration (backend environment variables)

| Variable | Used for | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`) | Anthropic | |
| `OPENAI_API_KEY` | OpenAI | `OPENAI_BASE_URL` is optional (default `https://api.openai.com/v1`) |
| `OLLAMA_BASE_URL` | Ollama | See section 3. Default in code: `http://localhost:11434`; in `docker-compose.yml`: `http://host.docker.internal:11434` |

Put keys in `.env` (template: `.env.example`). Never paste a key into a chat or an issue, and never commit `.env`. A provider without a key reports *not configured*; the other providers keep working.

## 3. Connecting to Ollama (Ollama running on the host)

The address must be correct **from where the backend runs**, not from your browser:

| Backend runs in | `OLLAMA_BASE_URL` |
|---|---|
| Docker (`docker compose`) | `http://host.docker.internal:11434` (already set in Compose, which also adds `extra_hosts` for Docker Engine on Linux/WSL) |
| Python directly on Windows | `http://localhost:11434` |
| WSL2 with `mirrored` networking | `http://localhost:11434` |
| WSL2 with NAT (default) | `http://<Windows host IP>:11434`. Get the IP with `ip route show default \| awk '{print $3}'` inside WSL. Ollama must listen beyond loopback: set `OLLAMA_HOST=0.0.0.0` on Windows, restart Ollama and allow port 11434 through the firewall |

Check from the backend's own environment:

```bash
docker compose exec agent-server curl -s http://host.docker.internal:11434/api/version   # Docker backend
curl -s http://localhost:11434/api/tags                                                  # Windows / WSL mirrored backend
```

Or open the UI: the status line under the Model field says *ready*, *Not pulled yet* or *Cannot connect to Ollama*. **Re-check** re-runs the check (it only calls `/api/tags` and never downloads a model).

## 4. Running

```bash
docker compose up -d --build
# If Docker reports "additional privileges requested: pass --allow=fs.read=..." (the Bake builder):
docker build -f Dockerfile.sandbox -t agent-workbench-sandbox:latest .
docker build -f Dockerfile.server -t agent-workbench-agent-server .
docker compose up -d --no-build
```

CLI:

```bash
python client.py "Compute 17 * 23"                                       # default: ollama / qwen3.5:4b
python client.py --provider ollama --model qwen3.8:latest --stream "Compute 17 * 23"
python client.py --provider anthropic --model claude-sonnet-4-6 "Compute 17 * 23"   # billed by Anthropic
python client.py --provider openai --model gpt-6-luna "Compute 17 * 23"
```

The model IDs above come from the catalog at the time of writing; `model_catalog.py` is the source of truth.

## 5. Errors

Returned when a run is created (`POST /api/runs`, `/api/execute*`), so no run exists afterwards:

| HTTP | `detail.code` | Meaning |
|---|---|---|
| 422 | `invalid_provider` / `invalid_model` | The provider/model is not in the catalog (the backend does not trust arbitrary values from the client) |
| 400 | `not_configured` | The API key is missing |
| 400 | `connection` | Cannot reach Ollama at `OLLAMA_BASE_URL` |
| 400 | `model_not_pulled` | Ollama is running but the model has not been pulled |

Errors while a model call is in progress end the run as **Failed**; the `llm` log entry records `error_kind` and `http_status`:

| `error_kind` | Meaning |
|---|---|
| `auth` | Wrong or expired key (401) |
| `permission` | The provider denied access (403) |
| `model_not_found` | Wrong model ID, or the key may not use that model (404) |
| `rate_limit` | 429: rate limit or out of credit |
| `connection` / `timeout` | Cannot connect / connected but no data for too long |
| `bad_request`, `provider_error` | Other 400s / 5xx |

There is no fallback: an error is reported for the provider/model that failed, and the app never switches to another provider.

## 6. How the providers differ (adapters in `llm_providers.py`)

| | Anthropic | OpenAI | Ollama |
|---|---|---|---|
| API | Messages API through the `anthropic` SDK (`AsyncAnthropic`) | Responses API `POST /v1/responses` (httpx, SSE) | `POST /api/chat` (httpx, NDJSON) |
| System prompt | `system` | `instructions` | a message with `role: system` |
| Output limit | `max_tokens` | `max_output_tokens` (includes reasoning tokens) | `options.num_predict` |
| Forcing JSON | `output_config.format` json_schema (catalog option `structured_output`; sent as `extra_body`), plus system prompt + parsing + one format retry as a safety net. Not yet checked against the real API | `text.format` json_schema `strict` | `format` = JSON schema |
| Specifics | Does not send `thinking` / `temperature`; the SDK client is created with explicit `max_retries=2` and a 600 s timeout (the SDK defaults), so a transient error may be retried inside one model call without a log entry | `reasoning.effort`, `store: false`, no `temperature` | `think: false`, `options.num_ctx` |
| Tokens logged | `usage` of the response | `usage` in `response.completed` | `prompt_eval_count`, `eval_count` |

Tokens are logged only when the provider actually returns them. The model's thinking content (if any) is not shown.

Old runs (created before multi-provider support) keep the stored model and have no provider (*provider not recorded*); the app does not assign a default to them. Replay only reads stored data and never calls a model.
