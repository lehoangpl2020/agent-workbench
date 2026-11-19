# Architecture

Agent Workbench is a code-execution agent. The mechanism is a single loop: **Plan → Execute → Evaluate → Retry/Done**. This document is a map for reading the code; it describes what is implemented.

## Components

| File | Role | Who decides |
|---|---|---|
| `planner.py` | Calls the run's model (Claude / OpenAI / Ollama through `llm_providers.py`, catalog in `model_catalog.py`) in streaming mode and returns JSON `{thinking, code, language}`. One fixed planner per run. Streams the code that is being written through `on_progress`. | **Model**: what code to write, and when to answer `DONE` |
| `executor.py` | Runs the code: `LocalExecutor` / `SandboxExecutor` (a new container per run) / `PersistentSandboxExecutor` (`docker exec`). Real timeout, kill on Stop, auto `pip install`, artifact collection. | Application |
| `prompts.py` / `parsing.py` | Pure functions: the system prompt and the conversation built from a run's history (`build_messages`), and validation of the model's JSON reply (`parse_response`). No model calls, no I/O; `tests/test_characterization.py` pins their output. | **Model** sees what `prompts.py` builds; changing it changes model behavior |
| `agent.py` | **The single agent loop**, `CodeAgent.run()`. Emits events through `emit(event, data)`. Decides the final status. The stop rules are pure functions at the top of the file (`next_turn`, `done_outcome`, `limit_outcome`), covered by `tests/test_stop_conditions.py` without a model or a subprocess. | Application |
| `image_tool.py` | Optional (`IMAGE_TOOL=true`) OpenAI image tool (`IMAGE_MODEL`). The run's code POSTs to `/api/runs/{id}/tools/generate_image` (`server.py`); the server calls OpenAI with its own key and saves the PNG in `output/`. The loop is unchanged: the model still only writes code, and the file is collected as an artifact. Details in [api.md](api.md#image-tool). | Application: the key, the per-run cap, where the file goes. **Model**: whether and what to draw |
| `runs.py` | `RunManager`: runs the loop as a background task, one run at a time, Stop = `task.cancel()`, events → SQLite + SSE. | Application |
| `store.py` | SQLite (`runs`, `iterations`, `run_logs`): history and activity log that survive restarts. | n/a |
| `runlog.py` | Builds log entries `{ts, iteration, source, level, message, data}` and redacts secrets. | n/a |
| `metrics.py` | Totals of one run (model calls, tokens, model and sandbox time, estimated cost): `summarize_run()`, and `load_pricing()` for `MODEL_PRICING`. No state of its own; see [Run totals](#run-totals-tokens-time-cost). | n/a |
| `workspace.py` | A private directory per run, plus path-traversal protection when reading artifacts. | n/a |
| `server.py` | FastAPI: Run API, legacy API (`/api/execute`, `/stream`), serves the web UI. | n/a |
| `web/` | React + TypeScript + Vite + Tailwind + shadcn/ui. Reads state from the API; SSE is only a signal to refetch. | n/a |

## Flow of one run

```text
UI  POST /api/runs ─► RunManager.start() ─► asyncio.Task( CodeAgent.run(emit) )
                                                    │
   ┌──────────── every iteration ───────────────────┤
   │ 1. Plan     emit iteration(planning, intent=write|fix|review)   ← "Waiting for LLM"
   │             the planner streams → emit code_progress (code being written)
   │             did the model answer DONE?  → SUCCESS (only if a run has already succeeded)
   │ 2. Execute  emit code, activity(executing) → executor.execute()  ← "Runtime"
   │             (installing → rerunning) → collecting artifacts
   │ 3. Evaluate emit activity(checking) → false-success check → emit result
   │             infrastructure error → ERROR;  otherwise → next iteration (the model sees the output/error)
   ├─ max_iterations code runs used, last run SUCCEEDED
   │     → one "final review" iteration: only calls the model (DONE → SUCCESS), runs NO more code
   └─ max_iterations code runs used, last run failed → MAX_RETRIES (or TIMEOUT if it timed out)
                                                    │
emit(event) ─► RunManager._persist() → SQLite ─► GET /api/runs/{id}  (the UI refetches)
           └─► the queue of each SSE client ─► GET /api/runs/{id}/events
```

- **Sync and SSE share one loop:** `/api/execute` = start + wait for the task; `/api/execute/stream` = start + read the queue. A test compares the business result of the two paths.
- **Stop:** `task.cancel()` → `CancelledError` reaches the executor → the real process is killed (`_KILL_SNIPPET` in the sandbox, `proc.kill()` locally, `container.remove(force)` for ephemeral containers) → the agent catches the error → `stopped`.
- **Timeout:** `timeout -k 2 <T>` inside the sandbox (exit 124), plus an `asyncio.wait_for` safety net in Python.
- **The event loop is never blocked:** Claude is called through `AsyncAnthropic`; the Docker SDK and subprocesses run in `asyncio.to_thread`, so `/health` and Stop still respond while code is running.

## Run status

An **iteration** is one model call. **`max_iterations`** (UI: *Max code runs*) is the maximum number of **code runs**. When the last run succeeds, the model gets one extra *final review* iteration to look at the output and answer `DONE`; the code returned in that turn is not run. The maximum number of model calls is `max_iterations + 1`, not counting retries for malformed JSON (those happen inside the same iteration).

| Who decides | Decision |
|---|---|
| **Model** | What code to write; whether the output is enough (`DONE`) |
| **Runtime** (`agent.py`) | Whether to run code; when the turns are used up; the false-success check; the final status |

| Run status (API) | UI | When |
|---|---|---|
| `success` | Completed | The model answered `DONE` after at least one successful code run (including in the final-review turn) |
| `max_retries` | Code run limit reached | `max_iterations` code runs were used and the model has not said `DONE`: either the last run failed, or in the final-review turn the model still wanted more steps. The latest successful output is kept as a partial result |
| `timeout` | Timed out | `max_iterations` code runs were used and the last run was killed by the timeout |
| `error` | Failed | Planner error / sandbox error / the model said `DONE` before any run succeeded / the server restarted mid-run |
| `stopped` | Stopped | The user pressed Stop |

Example with `max_iterations = 2`:

| What happens | Model calls | Code runs | Result |
|---|---|---|---|
| run OK → `DONE` | 2 | 1 | `success` |
| error → fix, run OK → final review `DONE` | 3 | 2 | `success` |
| error → error | 2 | 2 | `max_retries` (no third model call) |
| run OK → more steps, run OK → final review still wants more steps | 3 | 2 | `max_retries` (the turn-3 code is not run) |

A run whose exit code is 0 but whose first stdout line looks like an error (for example `print("Error: ...")`) is treated as a failure (the "false success" check) and fed back to the model. This is a heuristic and can misfire.

## Data and artifacts

```text
<RUNS_DIR>/<run_id>/code/iter_01.py     code of each iteration
<RUNS_DIR>/<run_id>/output/             where the code writes files (= /workspace/output in the sandbox)
<RUNS_DIR>/<run_id>/snapshots/01/       copy of the files changed in iteration 1 → lets you view that exact iteration
```

- Docker Compose: bind mount `./data/db` → `/data/db` (SQLite at `data/db/agent.db` on the host, readable with DB Browser for SQLite; see [troubleshooting](troubleshooting.md#opening-the-sqlite-database-in-db-browser-for-sqlite)) and volume `agent-runs` (server `/data/runs` = sandbox `/workspace/runs`).
- On every run, `/workspace/output` is symlinked to the current run's `output/`, so a prompt that says "save to /workspace/output" stays valid while files from different runs do not mix.
- `GET /api/runs/{id}/artifacts/{path}` only returns files inside that run's `output/` (or snapshot), after resolving the path. Symlinks pointing outside and `../` both return 404.

## Activity log

Every real step calls `emit("log", entry)` exactly where it happens. `RunManager` stores the entry in `run_logs` (which assigns an `id`) and pushes it through SSE. The UI appends entries by `id`; after a refresh or reconnect it calls `GET /logs?after=<last id>`.

| source | Emitted by | Examples |
|---|---|---|
| `runtime` | `agent.py`, `runs.py` | Run started (model, executor, limits), sending the error/result back to the model, Stop, Run finished |
| `llm` | `planner.py` | Calling model, First token, Response received (timing, stop_reason, tokens when available), parse OK/error, and a WARN when the prompt uses 90% or more of an Ollama model's `num_ctx` |
| `model` | `agent.py` | The short explanation the model returned (the model's own words, not a runtime action) |
| `sandbox` | `executor.py` | Writing `code/iter_NN.py`, start of execution, package install, re-run, exit code/time/timeout, artifacts + sizes |

Messages and data go through `redact()`, which masks `sk-ant-…` keys, auth headers, and the values of environment variables whose names contain KEY/TOKEN/SECRET/PASSWORD.

## Run totals (tokens, time, cost)

There is no table and no counter for these. `GET /api/runs/{id}` calls `metrics.summarize_run()`, which recomputes the totals on every read from two things that are already stored:

| Number | Source |
|---|---|
| Model calls, tokens, model time, first token | `llm` log entries whose `data.metric` is `llm_call` (`events.METRIC_LLM_CALL`). `planner.py` writes **one** per model call, successful or failed, with `ok`, `attempt` (> 0 = resent after invalid JSON), `duration_ms`, `first_token_ms` and the token counts the provider reported |
| Sandbox time | `iterations.execution_time_ms`, measured by `executor.py` (it includes an automatic `pip install` in persistent mode) |
| Whole run | `runs.finished_at - runs.created_at` (null while the run is running) |
| Cost | tokens × `MODEL_PRICING["provider/model"]` |

How to read them:

- **A missing value is `null`, never 0.** A run stored before the `metric` tag existed gets `llm: null` and the UI says "No data". A provider that reports no usage gives `null` tokens and `cost.status = "no_usage"`.
- `usage_complete: false` means some call reported no usage (the provider left it out, or the call failed), so tokens are a floor and the cost is `partial` (the UI shows `≥`).
- Totals count by the `metric` tag, not by message text, so rewording a log message cannot change them. A new place that calls a model must write the same entry or its calls are not counted.
- Providers differ: Anthropic reports cache tokens apart from `input_tokens`; OpenAI counts `cached_tokens` **inside** `input_tokens`, so the normal input is `input - cached`. Reasoning/thinking tokens are already inside `output_tokens` and are not added again. With no cache price configured, cache tokens are priced like normal input.
- `cost.status`: `ok` · `partial` · `no_pricing` (no price for this model) · `no_usage` · `no_data`. A price of `0` is a valid setting (a free local model) and is not the same as "no price set".
- The cost is an estimate from prices the user configured. The code contains no prices.

## SSE events

`session`, `iteration`, `code`, `result`, `model_done`, `error` and `done` are the legacy events and old clients keep working. The newer events are `activity` (the current action), `code_progress` (code being streamed), `log` (an activity-log entry) and `status`.

The names, the `flow` tags of log entries and the payload of each event are declared in `events.py` (TypedDicts); `web/src/lib/api.ts` mirrors the names, and `tests/test_event_contract.py` checks both sides and the payloads the agent actually emits. `RunManager._persist` is a table from event to the SQLite update it causes.

## Live Flow and Replay (UI)

- **Live Flow** shows the model, the agent runtime and the Python sandbox as three actors. A data card moves only when a real log entry arrives; the code file only reaches the sandbox after the backend has parsed the response and written `code/iter_NN.py`. After a refresh or reconnect the view is rebuilt from the stored snapshot and logs; history is not replayed as if it were live.
- **Replay** of a finished run only reads the SQLite history and the per-iteration file snapshots. It never calls a model and never runs code. Partially streamed code is not stored per step, so Replay shows code from the moment the response was parsed. Old runs without detailed logs are labeled **Partial history**; files without a per-iteration snapshot are labeled **Snapshot unavailable**. `prefers-reduced-motion` is honored.
- Both views are derived from stored events and logs (`web/src/lib/studio.ts`). Each step is placed by the `flow` tag of its log entry (`events.py`); only runs stored before a tag existed are recognized by their message text (`legacyFlow` in `studio.ts`), so a changed message can still alter how an old run is shown; `web/src/lib/studio.test.ts` tests these views against runs recorded from the backend, and `tests/test_ui_fixtures.py` keeps those recordings in sync with what the backend emits. Components and hooks are not tested automatically.

## Current limitations

- Only one run at a time (the backend returns 409, the UI disables the Run button).
- The persistent sandbox is one shared container: code from one run could in theory read another run's directory. Use ephemeral mode for stronger separation.
- There is no authentication. As mitigation the default is `127.0.0.1` only (Compose publishes `127.0.0.1:8668`, `python server.py` defaults to `HOST=127.0.0.1`) and CORS only allows the Vite dev server.
- Local mode is not isolated: model code runs with the permissions of the user running the server.
- No agent-quality evaluation, cost limits, or observability beyond the log and the UI. **Not production-ready.**
