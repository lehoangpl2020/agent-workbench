# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

The shared project guidance is in [AGENTS.md](AGENTS.md); read it first. This file only adds what is specific to Claude.

## Working style

- Read the relevant code before answering questions about behavior; compare it with [docs/architecture.md](docs/architecture.md) instead of answering from memory. Before adding or moving a module, read [docs/project-structure.md](docs/project-structure.md): it says which layer the code belongs to. When explaining the agent loop, separate what the model decides from what the application decides.
- Prefer small, verifiable changes. When asked to implement or fix something, change the repository rather than only describing the change.
- Use the dedicated file and search tools for reading and editing files. Use the shell for git, docker, npm and pytest.
- Ask a question only when the answer would change the approach. Otherwise state a reasonable assumption and continue.
- Report outcomes faithfully: say which checks you ran (offline tests, real Ollama check, Docker sandbox, full end-to-end, UI build) and which you did not. If a check fails, show the failure. Follow the real-model verification policy in [AGENTS.md](AGENTS.md#real-model-verification-policy-claude-code-codex-and-any-other-assistant).

## Guardrails

- Do not read or print `.env` or any secret, and do not ask for keys to be pasted into the chat.
- Ask before: calling a paid model API (Anthropic or OpenAI); adding dependencies; changing a runtime invariant, the SQLite schema, the default model or the default sandbox mode; deleting Docker volumes; adding a license or editing attribution in [NOTICE.md](NOTICE.md); committing or pushing.
- Never describe the project as production-ready, secure or fully tested; list the missing pieces instead.
- Keep repository content in English, including comments, UI text, logs and tests.

## Useful checks

```bash
.venv/Scripts/python -m pytest tests -q     # offline; .venv/bin/python on Linux/macOS
.venv/Scripts/python -m pytest tests/unit -q   # fast subset: pure modules only
.venv/Scripts/python -m pytest tests/unit/test_parsing.py::test_markdown_fences_are_stripped -q   # one test
.venv/Scripts/python -m pytest tests -q -k stop   # tests whose name matches
UPDATE_SNAPSHOTS=1 .venv/Scripts/python -m pytest tests/contract -q   # regenerate snapshots/UI fixtures, then rerun npm test
cd web && npm run build                     # type-check + build
cd web && npm run typecheck                 # tsc -b only
cd web && npm test                          # unit tests of web/src/lib (no component tests)
cd web && npx vitest run src/lib/studio.test.ts   # one test file
```

No linter or formatter is configured (neither Python nor web); match the style of the surrounding code.

## Path of one run through the code

Useful when a change touches more than one layer (details in [docs/architecture.md](docs/architecture.md#flow-of-one-run)):

1. `POST /api/runs` (`api/routes/runs.py`) calls `start_run()` in `api/deps.py`, which resolves the provider/model against `llm/catalog.py` (422), rejects a second run (409), preflights the provider through `llm/registry.py` (400) and calls `RunManager.start()` in `runs/manager.py`. The legacy `/api/execute*` routes use the same helper.
2. `RunManager` starts an `asyncio.Task` running `CodeAgent.run(emit)` in `core/agent.py`. Each iteration: `core/planner.py` calls the model (prompt from `core/prompts.py`, reply checked by `core/parsing.py`), `execution/` runs the code, and `core/rules.py` decides whether to continue.
3. Every `emit(event, data)` goes to `RunManager._persist()` → `storage/run_store.py` (SQLite) and to each SSE client's queue. The event names and payloads are the contract in `domain/events.py`.
4. The UI (`web/src/lib/api.ts`, `web/src/lib/studio.ts`) treats SSE only as a signal and refetches `GET /api/runs/{id}` (built by `runs/detail.py`) and `GET /api/runs/{id}/logs?after=<id>`.

So a new kind of step usually touches `domain/events.py`, the place that emits it, `web/src/lib/api.ts` and `studio.ts`, and the contract tests together.
