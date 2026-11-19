# NOTICE: origin and attribution

Agent Workbench started from **practice code of the "AI Agent Engineering" course by Mentora × ProtonX**. This file records, as accurately as I can, what came from the starter and what was added afterwards. It is not a legal analysis.

## Starter (course material)

The starting point was a small code-execution agent skeleton, imported into my private learning repository on 2026-11-18 (commit message: "add agent code project demo"). It contained these files:

`agent.py`, `client.py`, `example.py`, `executor.py`, `planner.py`, `schemas.py`, `server.py`, `run.sh`, `Dockerfile.sandbox`, `Dockerfile.server`, `docker-compose.yml`, `requirements.txt` and a README (in Vietnamese).

- The starter files had **no license header, copyright notice or LICENSE file** in the copy I received. Nothing was removed from them when this repository was created, so there is no notice to preserve; if you know of license terms that apply to the course code, please tell me.
- I cannot verify the exact authorship of the starter beyond its being course material from Mentora × ProtonX. I do not claim it as my own work.
- Most starter files were later **modified substantially** (for example the planner hardening against invalid model JSON, multi-provider support, the stop-condition semantics, localhost-only defaults). Those modifications are mine, but the files still contain starter code.

## Extensions (author, with AI coding assistants)

Added after the starter, in my own repository:

- `web/`: the React + TypeScript web UI (composer, Live Flow / Agent Studio, Replay, Logs, Files, History).
- `runs.py`, `store.py`, `runlog.py`, `workspace.py`: background Run API, SQLite history, activity log with redaction, per-run workspaces with path-traversal protection.
- `model_catalog.py`, `llm_providers.py`: Anthropic / OpenAI / Ollama provider support and per-run model selection.
- `tests/`: the offline test suite (scripted planner).
- `.env.example`, `.gitignore`, `.dockerignore`, `requirements-dev.txt`, `AGENTS.md`, `CLAUDE.md`.
- Documentation: `README.md`, `NOTICE.md` and the files in `docs/`.
- Changes to the Docker/Compose setup for localhost-only access and for running independently of other Compose projects.

The extensions were written by the repository owner with the assistance of AI coding assistants (Claude Code).

## History

This repository was created with a fresh Git history so that it contains only this project. The development history lives in a separate private learning repository. The attribution above is kept here so it is not lost with the old history.

## Third-party software

Dependencies are installed from their own registries (see `requirements.txt` and `web/package-lock.json`) and keep their own licenses. The UI uses shadcn/ui-style components built on Radix UI and Tailwind CSS (components live in `web/src/components/ui/`).

## Not affiliated

This is not an official Mentora or ProtonX project, and they have not endorsed it. "Mentora", "ProtonX", "Anthropic", "Claude", "OpenAI" and "Ollama" are names of their respective owners.

## License status

This repository currently has **no license**. See the License section of [README.md](README.md).
