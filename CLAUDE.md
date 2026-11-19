# CLAUDE.md

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
cd web && npm run build                     # type-check + build
cd web && npm test                          # unit tests of web/src/lib (no component tests)
```
