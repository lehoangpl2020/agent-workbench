---
name: verify-change
description: Verify a change in Agent Workbench before calling it done. Maps the diff to the right checks (offline pytest, web build and unit tests, doc link check, and only when justified a small real Ollama check or the gated Docker sandbox tests), runs them, and reports which of the four verification levels from AGENTS.md was actually reached. Use this whenever you have edited code or docs in this repository and are about to report the work, and whenever the user asks to verify, check, test, validate or "make sure it works", asks whether a change is safe to commit or open a PR for, or asks what was tested, even if they don't say "verify".
---

# verify-change

AGENTS.md section 8 asks every contributor to say *precisely* what was verified. This skill turns that into a
routine: find what changed, run the checks that change needs (no more, no less), and report the outcome
without rounding up. A report that claims more than was run is worse than no report, because the maintainer
relies on it to decide what still needs checking.

The four levels, from weakest to strongest (use these names in the report):

1. **Offline tests**: pytest with `ScriptedPlanner` and mock transports, plus `npm run build` and `npm test`.
   Code still runs for real in `LocalExecutor`, but no model is called.
2. **Real Ollama check**: a local model is actually called.
3. **Real Docker sandbox check**: code runs in the sandbox container.
4. **Full end-to-end**: UI → server → real model → real sandbox → displayed result. Claim it only if you ran
   all of it, including looking at the result in the UI.

Levels 2–4 are not "better" by default. Most changes are fully covered by level 1. Run a higher level only when
the change touches what that level exercises, and say why.

## Step 1: Find the change and get a plan

Run the planner script from the repository root. It only reads git state.

```bash
python .claude/skills/verify-change/scripts/plan_checks.py            # working tree vs HEAD, or vs merge-base with main on a branch
python .claude/skills/verify-change/scripts/plan_checks.py --base HEAD~1   # e.g. the user just committed on main
```

It prints the changed files grouped by area, the checks they call for, and flags such as "needs maintainer
approval" or "generated file edited". If it reports no changes but the user is clearly asking about recent work,
ask which commits to verify, or use `--base` with a ref that makes sense from `git log`.

Treat the plan as a strong default, not a cage. If you know from the session that a change has effects the
paths don't show (for example a log message text changed inside `core/agent.py`, which changes the UI
fixtures), add the matching checks.

## Step 2: Run the offline checks

These are always safe and cheap. Run every one the plan lists; don't skip one because a related one passed.

| Changed | Command (from the repository root) |
|---|---|
| Any Python in `src/`, `tests/`, `scripts/`, or `pyproject.toml` | `.venv/Scripts/python -m pytest tests -q` (Windows) or `.venv/bin/python -m pytest tests -q` |
| Anything in `web/` | `cd web && npm run build` (includes `tsc -b`) and `cd web && npm test` |
| Contract surfaces: `domain/events.py`, `web/src/lib/api.ts`, `web/src/lib/studio.ts`, log/`flow` emission, fixtures | both of the above, since `test_event_contract.py` and `test_ui_fixtures.py` tie the two sides together |
| Markdown files | `python .claude/skills/verify-change/scripts/check_links.py <changed .md files>`, and read any shell commands you added or changed in the docs against the repo (script names, flags, paths) |

`pytest tests/unit -q` is a fine quick loop while iterating, but the report must be based on the full
`pytest tests -q` run.

**When a snapshot or fixture test fails** (`tests/contract/test_characterization.py`,
`tests/contract/test_ui_fixtures.py`): first decide whether the change was *meant* to alter that output.
- Not intended: that's a real regression. Report it and fix the code, not the snapshot.
- Intended: regenerate with `UPDATE_SNAPSHOTS=1 .venv/Scripts/python -m pytest tests/contract -q`, look at the
  `git diff` of the snapshot/fixture files to confirm only the expected parts changed, then rerun the full
  pytest and `cd web && npm test`. Say in the report that snapshots were regenerated and which files changed.
  Regenerated snapshots hide regressions if nobody reads the diff, so the diff review is the actual check.

**When something fails for an environmental reason** (no `.venv`, `node_modules` missing, port taken): report it
as "not run: <reason>" with the error. Don't install dependencies or change config to make it pass unless the
user asks; `npm install` from the existing lockfile is fine if `node_modules` is simply absent.

Show the failing output (the relevant traceback or the last lines of the summary), not just "1 failed".

## Step 3: Decide whether a real model or the sandbox is needed

### Real Ollama check: only when model-facing behavior changed

Worth doing when the change affects what the model sees or how its reply is handled: `core/prompts.py`,
`core/parsing.py`, `core/planner.py`, `llm/ollama_chat.py`, `llm/registry.py`, `llm/catalog.py`, or the agent
loop's handling of replies in `core/agent.py`. Scripted tests prove the plumbing, but not that a real model
still produces parseable replies under the new prompt or format.

Not worth doing for UI changes, docs, storage, metrics, or pure refactors with green offline tests.

The policy (AGENTS.md, "Real-model verification policy") is strict:
- Use local Ollama with **`qwen3.5:4b`** only. Other installed models only if the task is about comparing models.
- **Never** `ollama pull`. If the model is missing, stop and ask the maintainer to pull it.
- **Never** call Anthropic or OpenAI, directly or through the app, unless the maintainer authorized that
  specific check in this conversation. Changes to `llm/anthropic_chat.py`, `llm/openai_chat.py` or
  `tools/image.py` are verified offline (mock transports) and the report says the paid path was not exercised.
- One trivial task, conservative limits. It is a smoke check, not a benchmark.

Procedure:

1. Check Ollama and the model: `curl -s http://localhost:11434/api/tags` and look for `qwen3.5:4b` in the
   names. If it is unreachable or the model is missing, report that and stop here. Don't switch models.
2. Make sure the server runs **the changed code**. A Docker stack started earlier runs whatever was built
   then, so a check against it proves nothing about the working tree. Start a throwaway local server on a
   separate port with its own data directory, so the maintainer's history is untouched. Use the scratchpad
   directory if the session has one; otherwise any temp folder outside the repo:
   ```bash
   PYTHONPATH=src USE_DOCKER=false PORT=8669 DATA_DIR="<scratch>/verify-data" .venv/Scripts/python -m agent_workbench
   ```
   Run it in the background, wait until `curl -s http://localhost:8669/health` answers, and note the
   `sandbox_mode` it reports (`local`, which is not isolated; that's why the task must be trivial).
3. Send one task with explicit provider and model, so it can never fall through to a paid default:
   ```bash
   PYTHONPATH=src .venv/Scripts/python scripts/client.py --base-url http://localhost:8669 \
     --provider ollama --model qwen3.5:4b --max-iterations 2 --timeout 20 \
     --stream "Calculate 2 + 2 and print the result"
   ```
4. Record the status, the number of iterations, and whether the answer is right. A small model can fail a
   run for model reasons; if the status isn't `success`, read the run's logs
   (`GET /api/runs/{id}` and `/api/runs/{id}/logs`) to tell a model mistake from a bug in the change, and say
   which it was. Don't retry until it passes; one honest result is the point.
5. Stop the throwaway server.

### Real Docker sandbox check: only when execution in the sandbox changed

Worth doing for `execution/docker_persistent.py`, `execution/docker_ephemeral.py`, `execution/base.py`,
`docker/`, or `docker-compose.yml`. The gated tests are in `tests/integration/test_docker_executor.py`, and its
docstring has the exact command (it runs inside the server container with `DOCKER_SANDBOX_TESTS=1`).

This builds or reuses the containers and needs Docker running, so **ask the user before running it**, and say
what it will do. Never use `docker compose down -v` (it deletes run history), and don't run commands that dump
secrets (`docker compose config`, `docker inspect`, `printenv`). If the user declines or Docker isn't running,
the report says "Docker sandbox: not run".

### Full end-to-end

Only if the user asks for it, or the change is a UI behavior that offline tests can't see and the user wants
it confirmed in the browser. It needs a real model and the real sandbox, plus looking at the result in the UI.
React components and hooks have **no automated tests**, so for changes there the report must say that the UI
behavior was checked only by the build (types), unless you actually looked at it running.

## Step 4: Report

Use this structure so the maintainer can scan it. Keep it short; the detail goes into failures, not passes.

```markdown
## Verification

**Level reached:** Offline tests  <!-- or: Real Ollama check / Real Docker sandbox check / Full end-to-end -->

| Check | Result |
|---|---|
| `pytest tests -q` | ✅ 187 passed, 3 skipped (Docker-gated) |
| `npm run build` | ✅ |
| `npm test` | ✅ 24 passed |
| Doc links (`README.md`, `docs/api.md`) | ✅ 12 links resolve |
| Real Ollama (`qwen3.5:4b`) | not run: change doesn't touch prompts, parsing or adapters |
| Docker sandbox | not run: no execution/ changes |

**Not covered:** <what the checks can't see, e.g. "the new Composer button has no component test; only type-checked">

**Needs maintainer attention:** <flags from the plan, e.g. "requirements.txt changed: new dependency needs approval">
```

Rules for the report:
- The level is the highest one **actually run and passed** for this change. A failed check doesn't count toward
  the level; list it with its output.
- Every check the plan listed appears in the table, as passed, failed (with output below the table) or "not run:
  reason". Leaving a row out reads as "passed".
- Copy counts from the real output. Skipped tests are usually the Docker-gated ones; say so rather than hiding them.
- Never describe the change or the project as production-ready, secure or fully tested.
- Don't commit, push, or open a PR as part of verification. If the checks pass, the user decides what comes next.
