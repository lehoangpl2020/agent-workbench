# AGENTS.md

Guidance for everyone who changes this repository, human or coding agent. [CLAUDE.md](CLAUDE.md) imports this file and adds a few Claude-specific notes. For users, start with [README.md](README.md).

## 1. Purpose and scope

Agent Workbench is a small code-execution agent plus a web UI for observing it. A model writes Python, a sandbox runs it, and the result or error goes back to the model until it answers `DONE` or a limit is reached. The goals are:

- a readable reference for how such an agent loop works, with every step visible (logs, live flow, replay);
- something others can clone and run locally with their own API keys.

It is a learning and showcase project, **not production software**. Do not describe it as production-ready, secure or fully tested. Document gaps in the README or `docs/`, and label anything not implemented as *planned* or *experimental*.

Out of scope unless a maintainer asks: new frameworks, queues, databases, authentication, multi-agent orchestration, RAG, or large refactors.

## 2. Architecture and repository structure

The backend is the package `src/agent_workbench/`, organized in layers. **Backend paths below and in the rest of
this file are relative to `src/agent_workbench/`.** The full map, the dependency rule (with a diagram), the design
principles and step-by-step recipes for extending the project are in
[docs/project-structure.md](docs/project-structure.md); read it before adding a module.

```text
domain/        schemas.py (data models + ExecutionStatus), events.py (event names, `flow` tags, payloads:
               the contract with runs/manager.py, SSE and web/src/lib/api.ts)
observability/ runlog.py (log entries + redact())
storage/       run_store.py (SQLite: runs, iterations, run_logs), workspace.py (per-run directory + path-traversal guard)
llm/           catalog.py (providers/models + default), base.py (ChatClient contract, errors, ProviderSettings),
               anthropic_chat.py / openai_chat.py / ollama_chat.py (adapters), registry.py (readiness, create())
execution/     base.py (shared execute() flow), local.py, docker_ephemeral.py, docker_persistent.py
tools/         image.py (opt-in image tool the sandboxed code calls through the server)
core/          agent.py (the agent loop), rules.py (pure stop rules), planner.py (one model call → CodeBlock),
               prompts.py (system prompt + context builder), parsing.py (validates the model's JSON reply)
runs/          manager.py (RunManager: background, Stop, SSE), detail.py (JSON for GET /api/runs/{id}),
               metrics.py (tokens, time, cost of one run; recomputed from run_logs + iterations)
config.py      Settings.from_env(): every environment variable except provider keys
api/           app.py (app factory, serves the UI), bootstrap.py (composition root), deps.py, sse.py,
               routes/ (runs, system, tools, legacy)
__main__.py    `python -m agent_workbench`

scripts/       client.py (CLI client), example.py (run the agent without the server)
docker/        server.Dockerfile, sandbox.Dockerfile       run.sh   shortcuts for Git Bash/WSL
web/src/       React + TypeScript + Vite + Tailwind + shadcn/ui
tests/         unit/, integration/, contract/ (pytest; ScriptedPlanner, no paid API calls)
docs/          architecture, API, providers, troubleshooting, project structure
```

Who decides what, which matters when explaining or changing the loop:

| Concern | Decided by | Where |
|---|---|---|
| What code to write, how to fix errors, when to answer `DONE` | the **model** | `core/prompts.py` (system prompt, context) and `core/parsing.py` (reply validation), called by `core/planner.py` |
| Running code, timeouts, kill, installing packages, collecting artifacts | the **application** | `execution/` |
| Continue/stop conditions, final status, false-success check | the **application** | `core/agent.py` |
| Background execution, one run at a time, Stop, events → SQLite + SSE | the **application** | `runs/manager.py` |

Read [docs/architecture.md](docs/architecture.md) before explaining or changing the architecture, and compare it with the code.

## 3. Development, build and test commands

Run everything from the repository root.

| Task | Command |
|---|---|
| Run the full stack (Docker) | `docker compose up -d --build` → http://localhost:8668 (set `HOST_PORT` if 8668 is taken) |
| Run without Docker (not isolated) | `PYTHONPATH=src USE_DOCKER=false python -m agent_workbench` |
| Backend tests (offline, scripted planner) | `.venv/Scripts/python -m pytest tests -q` (Windows) or `.venv/bin/python -m pytest tests -q` |
| Real-sandbox tests | see the docstring of `tests/integration/test_docker_executor.py` (needs `DOCKER_SANDBOX_TESTS=1`, runs inside the server container) |
| UI development server | `cd web && npm run dev` → http://localhost:5173 (proxies to :8668) |
| UI type-check + production build | `cd web && npm run build` |
| UI unit tests (pure logic in `web/src/lib`) | `cd web && npm test` |

If Docker reports `additional privileges requested: pass "--allow=fs.read=..."`, build the images directly; see [docs/troubleshooting.md](docs/troubleshooting.md).

Environment variables (all read once in `config.py` by `Settings.from_env()`, except provider keys and URLs, which `ProviderSettings.from_env()` (`llm/base.py`) reads). Never read or print the contents of `.env`; only the names matter.

| Variable | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | none | Anthropic provider (`ANTHROPIC_AUTH_TOKEN` is also accepted); read in `llm/` |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL` | none, `https://api.openai.com/v1` | OpenAI provider |
| `IMAGE_TOOL` | `false` | `true` makes the OpenAI image tool (`tools/image.py`) available; each run still opts in with the UI checkbox (`image_tool` on the request, stored in `runs.image_tool`). Also needs `OPENAI_API_KEY`; unavailable with ephemeral sandbox containers |
| `IMAGE_MODEL`, `IMAGE_MAX_PER_RUN` | `gpt-image-1-mini`, `4` | Image model (OpenAI retires them fast: this one is listed for shutdown on 2026-12-01, see `tools/image.py`) and the maximum image requests per run (failed ones count) |
| `IMAGE_TOOL_URL` | `http://127.0.0.1:<PORT>` (code), `http://agent-server:8000` (Compose) | The server as the **sandbox** reaches it; passed to the code as `IMAGE_TOOL_URL` plus the run's path |
| `OLLAMA_BASE_URL` | `http://localhost:11434` (code), `http://host.docker.internal:11434` (Compose) | Ollama, as seen from where the backend runs |
| `MAX_ITERATIONS` | `5` | Maximum number of **code runs** (a request may override it, 1–20); the model may be called once more |
| `EXECUTION_TIMEOUT` | `30` | Seconds per code run (a request may override it, 1–300) |
| `MAX_OUTPUT_TOKENS` | per model in the catalog | Overrides the output-token limit for every model (passed to `LLMPlanner`) |
| `MODEL_PRICING` | none | Price table for the cost estimate: JSON `{"provider/model": {"input", "output", "cache_read"?, "cache_write"?}}` in USD per 1M tokens, or a path to such a file. The code has no prices; without one the UI shows tokens and time only (`runs/metrics.py`) |
| `USE_DOCKER` | `false` | `true` uses a Docker sandbox |
| `SANDBOX_MODE` | `ephemeral` (code), `persistent` (Compose) | `ephemeral` or `persistent` |
| `SANDBOX_CONTAINER_NAME` | `agent-workbench-sandbox` | Name of the persistent sandbox container |
| `SANDBOX_RUNS_DIR` | `/workspace/runs` | Runs directory as seen from inside the sandbox |
| `SANDBOX_RUNS_MOUNT` | volume `agent-runs` | Compose only; set `./data/runs` for hybrid mode |
| `DATA_DIR`, `DB_PATH`, `RUNS_DIR`, `STATIC_DIR` | under `./data`, `./static` | SQLite, runs, UI build |
| `PORT`, `HOST` | `8668`, `127.0.0.1` | Listen port/address for `python -m agent_workbench` |
| `BIND_ADDRESS`, `HOST_PORT` | `127.0.0.1`, `8668` | Compose only: published address and port |
| `CORS_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Browser origins allowed to call the API |
| `LOCAL_PYTHON` | `sys.executable` | Python used by `LocalExecutor` |
| `DOCKER_SANDBOX_TESTS` | unset | `1` enables the real-sandbox tests |

The code default for `SANDBOX_MODE` is `ephemeral`, but `docker-compose.yml` sets `persistent`. When reporting which mode is running, check `/health` instead of guessing.

## 4. Coding conventions and change boundaries

- **Backend:** Python 3.11 in the Docker image; Pydantic v2, FastAPI, async/await. All code lives in the `agent_workbench` package under `src/` and uses absolute imports (`from agent_workbench.domain.schemas import ...`); relative imports are not used. pytest puts `src/` on the path (`pyproject.toml`); to run anything else from the repository root, set `PYTHONPATH=src` (`./run.sh` does).
- **Layers:** a module may import only from its own package or a lower layer (`domain`/`observability` → `storage` → `llm`/`execution`/`tools` → `core` → `runs` → `config` → `api`); packages on the same layer do not import each other. `tests/contract/test_layering.py` enforces this. Only `api/bootstrap.py` picks concrete classes and wires them together; see [docs/project-structure.md](docs/project-structure.md).
- **Frontend:** React 19, TypeScript, Vite, Tailwind 4, shadcn/ui (Radix). Base UI components live in `web/src/components/ui/` and the alias `@/` points to `web/src`. API types are declared in `web/src/lib/api.ts`; change them together with the backend response.
- **Language:** all code, comments, UI text, errors, logs, tests and documentation are in English. Use a short comment to explain *why*, a limit or a non-obvious behavior; do not narrate what the code does. Keep identifiers, API fields and schemas unchanged when you only edit wording.
- **Docker:** `docker/server.Dockerfile` copies `src/` and `scripts/` and sets `PYTHONPATH=/app/src`, so a new module anywhere in the package needs no Dockerfile change. Put new backend modules in the package (in the layer they belong to), never in the repository root.
- Keep changes small and focused. Do not refactor beyond the task. Do not add dependencies to `requirements.txt` or `web/package.json` without a clear need and a note in the PR.
- Do not edit generated or installed files: `web/dist/`, `static/`, `data/`, `.venv/`, `node_modules/`, `__pycache__/`, `*.tsbuildinfo`.
- Adding a setting: add it to `Settings` in `config.py` and the table above; do not read `os.environ` anywhere else (redaction in `observability/runlog.py` is the one deliberate exception).
- Adding an API field: update `domain/schemas.py`/the route in `api/routes/`, `web/src/lib/api.ts`, the related tests, and `docs/api.md` for a new endpoint.
- Adding an event, a `flow` tag or a payload key: declare it in `domain/events.py` and mirror it in `web/src/lib/api.ts` (`SSE_EVENTS`, `FLOWS`); `tests/contract/test_event_contract.py` fails if the two sides differ. Only add; never change the meaning of an old one.
- Adding a log or event: emit it where the action really happens (`emit("log", entry)`), with the right `source` (`runtime`, `llm`, `model`, `sandbox`), and pass it through `redact()`.
- Tests live in `tests/unit/` (one module, no app or subprocess), `tests/integration/` (the app or the loop end to end) and `tests/contract/` (events vs UI, snapshots, UI fixtures, layer rule). Shared helpers (`ScriptedPlanner`, `make_app`, `wait_until`) are in `tests/conftest.py`.
- Tests use `ScriptedPlanner` (`tests/conftest.py`): a script is a list of `CodeBlock`, `Exception` (planner error) or `Hang()` (a slow model, to test Stop while planning). Do not add tests that need a real model API or Docker unless they are gated by a skip flag such as `DOCKER_SANDBOX_TESTS`.

## 5. Agent runtime invariants

These are covered by tests or are deliberate decisions. Change one only with an explicit discussion in the PR, and update the code, tests and docs together.

1. **One agent loop.** `CodeAgent.run()` in `core/agent.py`. The sync API, SSE and the Run API all use it; never add a second loop. `test_sync_and_sse_have_same_business_result` compares the two paths.
2. **Never block the event loop.** Anthropic is called through `AsyncAnthropic`; the Docker SDK, subprocesses and heavy I/O run in `asyncio.to_thread`. `/health` and Stop must keep responding while code runs (`test_stop_kills_code_and_server_stays_responsive`).
3. **Stop kills the real process** (sandbox process, subprocess or container), not only the task.
4. **Two-layer timeout:** `timeout -k 2 <T>` in the sandbox (exit 124) plus `asyncio.wait_for` in Python as a safety net.
5. **Backward compatibility.** Keep the legacy events (`session`, `iteration`, `code`, `result`, `model_done`, `error`, `done`), the `/api/execute*` endpoints and the `ExecutionStatus` values. Only add events; never change the meaning of an old one. The UI treats SSE as a signal to refetch; `GET /api/runs/{id}` is the source of truth.
6. **Redact secrets.** Every log message and its `data` go through `redact()` (`observability/runlog.py`) before they are stored or sent. The local executor also strips environment variables whose names contain KEY/TOKEN/SECRET/PASSWORD (`test_secrets_are_redacted`).
7. **Block path traversal and escaping symlinks** when serving artifacts (`storage/workspace.py`): resolve the path and only return files inside `output/` or the snapshot of that run (`test_symlink_pointing_outside_is_blocked`, `test_artifacts_are_isolated_per_run`).
8. **One run at a time.** The backend returns `409`, the UI disables Run. Changing this means changing the backend, the UI and the tests together.
9. **History survives restarts.** A run still `running` after a restart is marked `error`. Old databases must migrate (`test_old_database_is_migrated`); a schema change needs a migration and a test.
10. **Provider and model are fixed for a whole run**, validated against `llm/catalog.py` (422 if invalid), preflighted (400 for a missing key, unreachable Ollama or an unpulled model), and never silently replaced by another provider. A request without a choice uses the default in `llm/catalog.py`: Ollama `qwen3.5:4b` (the UI preselects the same one from `GET /api/providers`). If the default is unavailable the request fails with a clear error; it never falls back to Claude, OpenAI or another Ollama model. Old runs with no provider keep it empty; the default is never written into history (`test_providers.py`).
11. **Localhost only by default.** The server runs model-written code and has no auth: Compose publishes `127.0.0.1:${HOST_PORT:-8668}`, `python -m agent_workbench` listens on `HOST=127.0.0.1`, and CORS never contains `*` (`test_cors_rejects_unknown_origin`, `test_server_defaults_to_localhost_only`).
12. **Stop conditions.** `max_iterations` counts code runs. If the last run succeeds, one extra final-review model call is made and its code is not run; if the last run fails or times out, the loop stops without another model call (`test_single_code_run_can_still_succeed`, `test_failed_last_run_stops_without_extra_model_call`, `test_success_without_done_hits_run_limit_and_keeps_partial`).

Run statuses: `success` (Completed), `max_retries` (Code run limit reached), `timeout`, `error` (Failed), `stopped`; `pending` and `running` are not terminal. The table with examples is in [docs/architecture.md](docs/architecture.md#run-status).

## 6. UI, streaming and replay requirements

- The UI must show only what actually happened: Live Flow cards move on real log events, and a code file appears in the sandbox only after the backend parsed the response and wrote `code/iter_NN.py`. No fake progress.
- Streaming: code being written is shown live via `code_progress`; a refresh or reconnect rebuilds the view from `GET /api/runs/{id}` and `GET /logs?after=<id>`, it does not replay history as if live.
- Replay only reads stored history and per-iteration snapshots. It never calls a model and never runs code. Old runs without detailed logs are labeled *Partial history*; files without a snapshot are labeled *Snapshot unavailable*.
- Honor `prefers-reduced-motion`.
- Live Flow places each step by the `flow` tag of its log entry (`domain/events.py`, `web/src/lib/studio.ts`). Only runs stored before a tag existed are recognized by their message text, in `legacyFlow()`: do not rely on that for new log entries, and give a new kind of step its own tag. Changing the text of a message no longer changes the UI for new runs. `web/src/lib/studio.test.ts` tests that logic against runs recorded from the backend (`web/src/lib/__fixtures__/`); `tests/contract/test_ui_fixtures.py` fails when the backend's output no longer matches those fixtures (regenerate with `UPDATE_SNAPSHOTS=1`, then run `npm test`). Components and hooks have no automated tests, so say so when you change them.
- Never put secrets in the frontend.

## 7. Security and secret handling

- Never read, print or commit `.env`, API keys or tokens. Do not paste them into issues, logs or screenshots. `.env.example` is the only env file that may be committed.
- Do not run commands that dump secrets (`docker compose config`, `docker inspect`, `printenv`, `cat .env`). See [docs/troubleshooting.md](docs/troubleshooting.md) for safe ways to check a key.
- Do not call paid model APIs (Anthropic, OpenAI) to verify a change without the maintainer's explicit authorization for that check. Offline tests are enough for most changes; use the policy in section 8 when a real model is needed.
- Do not change the localhost-only defaults, mount more of the host into containers, or weaken sandbox settings (`cap_drop`, `no-new-privileges`, resource limits) without discussing it first.
- The server mounts `/var/run/docker.sock`, which is very powerful. It is acceptable only for local development.
- Prompts, generated code and stdout are stored unredacted in SQLite. Do not commit `data/` or run history.
- Report security issues privately to the maintainer instead of opening a public issue with details.

## 8. Verification and contribution workflow

- Say precisely what was verified. Distinguish four levels and name the one you ran: **offline tests** (`pytest`, scripted planner and mock transports, but the code still runs for real in `LocalExecutor`); **real Ollama checks** (a local model is actually called); **real Docker sandbox checks** (code runs in the sandbox container); and **full end-to-end** (UI → server → real model → real sandbox → displayed result). Claim the full flow only if you ran all of it.
- After changing Python code run `pytest tests -q`. After changing `web/` run `npm run build` (it includes `tsc -b`) and `npm test`.
- Verify commands and relative links in documentation against the repository.

### Real-model verification policy (Claude Code, Codex and any other assistant)

This concerns the models the *application or its verification scripts* call. It does not change which model powers the assistant itself.

- **Normal path: offline/scripted tests.** They need no model and must pass whether or not Ollama is running.
- **When a real model is necessary,** use local Ollama with `qwen3.5:4b` (the app default). Use a trivial task and conservative limits (for example `max_iterations` 2 and a short `timeout_seconds`). Run one small check, not a benchmark.
- **Other installed Ollama models** (`qwen3.8:latest`, `gemma4:12b`) only when the task requires comparing models or investigating model-specific behavior.
- **Never pull models** automatically; the app and assistants do not run `ollama pull`. Ask the maintainer to pull a missing model.
- **No paid APIs without explicit authorization.** Do not call Anthropic or OpenAI (directly, through `scripts/client.py`/`./run.sh test` against a non-Ollama selection, or from the UI) unless the maintainer explicitly authorizes that specific verification.
- **If Ollama is unavailable or not enough for a check, report that limitation.** Do not silently switch to another provider or model, and do not present an unrun check as passed.
- Commit messages use a conventional prefix: `feat:`, `fix:`, `docs:`, `chore:`, `test:`. Keep commits focused and describe the why.
- Do not rewrite shared history or force-push.
- Avoid destructive Docker commands on volumes (`docker compose down -v` deletes run history and artifacts).

## 9. Attribution and license

The project started from practice code of the Mentora × ProtonX AI Agent Engineering course and was extended afterwards. [NOTICE.md](NOTICE.md) records what came from where. Keep existing copyright and license notices in files, and do not describe all of the code as written by the maintainer. There is currently **no LICENSE file**: do not add a license, or change the License section of the README, without the maintainer's decision.

## 10. Known limitations

Only one run at a time; the persistent sandbox is shared by all runs and has network access; the server container mounts the Docker socket; local mode is not isolated; no authentication, cost limits, agent-quality evaluation or observability beyond the log and UI; no automated tests for React components and hooks. See [docs/architecture.md](docs/architecture.md) and [docs/api.md](docs/api.md#security-notes).
