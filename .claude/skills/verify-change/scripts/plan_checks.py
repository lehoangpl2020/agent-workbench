"""
Maps the files changed in Agent Workbench to the verification checks they need.

Reads git state only; runs no tests. Usage, from the repository root:

    python .claude/skills/verify-change/scripts/plan_checks.py              # auto base
    python .claude/skills/verify-change/scripts/plan_checks.py --base HEAD~1
    python .claude/skills/verify-change/scripts/plan_checks.py --json

Auto base: the merge-base with `main` when on another branch (so committed branch work counts), otherwise HEAD
(uncommitted work only). Untracked files are always included.
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import subprocess
import sys

PKG = "src/agent_workbench/"

# (area, patterns, checks, note). A file can match several areas; checks are deduplicated.
RULES: list[tuple[str, list[str], list[str], str | None]] = [
    ("python", ["src/*.py", "tests/*.py", "scripts/*.py", "pyproject.toml", "tests/contract/snapshots/*"],
     ["pytest"], None),
    ("web", ["web/*"], ["web-build", "web-test"], None),
    ("contract", [PKG + "domain/events.py", "web/src/lib/api.ts", "web/src/lib/studio.ts",
                  "web/src/lib/__fixtures__/*", PKG + "runs/manager.py", PKG + "runs/detail.py",
                  PKG + "core/agent.py"],
     ["pytest", "web-test"],
     "Events, log entries and UI fixtures are tied together: run both pytest and npm test."),
    ("ui-untested", ["web/src/components/*", "web/src/hooks/*", "web/src/App.tsx", "web/src/main.tsx"],
     [], "React components/hooks have no automated tests: only type-checked by the build."),
    ("model-facing", [PKG + "core/prompts.py", PKG + "core/parsing.py", PKG + "core/planner.py",
                      PKG + "llm/ollama_chat.py", PKG + "llm/registry.py", PKG + "llm/catalog.py",
                      PKG + "core/agent.py"],
     ["ollama-candidate"],
     "Model-facing code changed: a small real Ollama check (qwen3.5:4b) may be justified."),
    ("paid-adapter", [PKG + "llm/anthropic_chat.py", PKG + "llm/openai_chat.py", PKG + "tools/image.py"],
     [], "Paid provider path: verify offline only unless the maintainer authorizes a real call."),
    ("sandbox", [PKG + "execution/docker_*.py", PKG + "execution/base.py", "docker/*", "docker-compose.yml"],
     ["docker-candidate"],
     "Sandbox execution changed: the gated Docker tests may be justified (ask the user first)."),
    ("docs", ["*.md"], ["doc-links"], "Check relative links, and commands you changed, against the repo."),
]

# Files whose change needs the maintainer's approval (CLAUDE.md guardrails).
APPROVAL = [
    ("requirements*.txt", "dependency change"),
    ("web/package.json", "dependency change (if dependencies changed)"),
    (PKG + "storage/run_store.py", "possible SQLite schema change: needs a migration and a test"),
    (PKG + "llm/catalog.py", "possible default-model change"),
    (PKG + "config.py", "possible default change (e.g. sandbox mode)"),
    ("NOTICE.md", "attribution change"),
    ("LICENSE*", "license change"),
]

GENERATED = ["web/dist/*", "static/*", "data/*", ".venv/*", "*/node_modules/*", "*__pycache__*", "*.tsbuildinfo"]

SECRET_LIKE = [".env", ".env.*"]

CHECK_COMMANDS = {
    "pytest": ".venv/Scripts/python -m pytest tests -q   (.venv/bin/python on Linux/macOS)",
    "web-build": "cd web && npm run build",
    "web-test": "cd web && npm test",
    "doc-links": "python .claude/skills/verify-change/scripts/check_links.py <changed .md files>",
    "ollama-candidate": "decide: real Ollama check (see SKILL.md step 3)",
    "docker-candidate": "decide: gated Docker sandbox tests, ask the user first (see SKILL.md step 3)",
}


def git(*args: str) -> str:
    return subprocess.run(["git", *args], capture_output=True, text=True, check=True).stdout


def resolve_base(base: str | None) -> str:
    if base:
        return base
    branch = git("rev-parse", "--abbrev-ref", "HEAD").strip()
    if branch not in ("main", "HEAD"):
        try:
            return git("merge-base", "main", "HEAD").strip()
        except subprocess.CalledProcessError:
            pass
    return "HEAD"


def changed_files(base: str) -> list[str]:
    files = set(git("diff", "--name-only", base).split())
    files |= set(git("ls-files", "--others", "--exclude-standard").split())
    # Our own skill files are not part of the application.
    return sorted(f for f in files if not f.startswith(".claude/"))


def match(path: str, patterns: list[str]) -> bool:
    return any(fnmatch.fnmatch(path, p) for p in patterns)


def plan(files: list[str]) -> dict:
    areas: dict[str, list[str]] = {}
    checks: list[str] = []
    notes: list[str] = []
    for area, patterns, area_checks, note in RULES:
        hits = [f for f in files if match(f, patterns)]
        if not hits:
            continue
        areas[area] = hits
        checks += [c for c in area_checks if c not in checks]
        if note and note not in notes:
            notes.append(note)
    approval = [f"{f}: {why}" for f in files for p, why in APPROVAL if fnmatch.fnmatch(f, p)]
    generated = [f for f in files if match(f, GENERATED)]
    secret = [f for f in files if match(f.rsplit("/", 1)[-1], SECRET_LIKE) and not f.endswith(".env.example")]
    unmatched = [f for f in files if not any(f in hits for hits in areas.values())]
    return {"files": files, "areas": areas, "checks": checks, "notes": notes, "approval": approval,
            "generated": generated, "secret_like": secret, "unclassified": unmatched}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", help="git ref to compare the working tree against")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    args = ap.parse_args()

    try:
        base = resolve_base(args.base)
        files = changed_files(base)
    except subprocess.CalledProcessError as e:
        print(f"git failed: {e.stderr.strip()}", file=sys.stderr)
        return 2

    result = {"base": base, **plan(files)}
    if args.json:
        print(json.dumps(result, indent=2))
        return 0

    print(f"Base: {base}")
    if not files:
        print("No changed files. If you meant committed work, pass --base <ref> (e.g. HEAD~1).")
        return 0
    print(f"Changed files ({len(files)}):")
    for area, hits in result["areas"].items():
        print(f"  [{area}]")
        for f in hits:
            print(f"    {f}")
    if result["unclassified"]:
        print("  [unclassified]")
        for f in result["unclassified"]:
            print(f"    {f}")

    print("\nChecks:")
    for c in result["checks"] or ["(none required; review the unclassified files)"]:
        print(f"  - {c}: {CHECK_COMMANDS.get(c, '')}")
    if result["notes"]:
        print("\nNotes:")
        for n in result["notes"]:
            print(f"  - {n}")
    if result["approval"]:
        print("\nNeeds maintainer approval (CLAUDE.md guardrails), confirm what actually changed:")
        for a in result["approval"]:
            print(f"  - {a}")
    if result["generated"]:
        print("\nGenerated/installed files changed (should not be edited by hand):")
        for g in result["generated"]:
            print(f"  - {g}")
    if result["secret_like"]:
        print("\nWARNING: secret-like files changed; do not read, print or commit them:")
        for s in result["secret_like"]:
            print(f"  - {s}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
