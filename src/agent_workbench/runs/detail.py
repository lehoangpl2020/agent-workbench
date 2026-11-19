"""The JSON of one run for GET /api/runs/{id}: the stored row plus artifact links and what is still on disk."""

from pathlib import Path
from urllib.parse import quote

from agent_workbench.runs.metrics import Pricing, summarize_run
from agent_workbench.llm.catalog import describe
from agent_workbench.storage.run_store import RunStore
from agent_workbench.storage.workspace import ArtifactNotFound, RunWorkspace, guess_mime


def build_run_detail(store: RunStore, runs_dir: Path, run_id: str, active_run_id: str | None,
                     pricing: Pricing | None = None) -> dict | None:
    """None when there is no such run. Artifact files are only checked, never read."""
    run = store.get_run(run_id)
    if not run:
        return None
    base = f"/api/runs/{run_id}/artifacts"
    workspace = RunWorkspace(runs_dir, run_id)
    last_changed: dict[str, int] = {}
    for it in run["iterations"]:
        for a in it["artifacts"]:
            last_changed[a["path"]] = it["number"]
            a["mime"] = guess_mime(a["path"])
            a["url"] = f"{base}/{quote(a['path'])}?iteration={it['number']}"
            try:
                workspace.resolve_artifact(a["path"], iteration=it["number"])
                a["snapshot_available"] = True
            except ArtifactNotFound:
                a["snapshot_available"] = False
    run["artifacts"] = [
        {
            **a,
            "iteration": last_changed.get(a["path"]),
            "url": f"{base}/{quote(a['path'])}",
            "download_url": f"{base}/{quote(a['path'])}?download=1",
        }
        for a in workspace.list_artifacts()
    ]
    run["active"] = active_run_id == run_id
    run.update(describe(run.get("provider"), run.get("model")))
    # Totals are recomputed from the stored log and iterations on every read (see runs/metrics.py)
    run["summary"] = summarize_run(run, store.list_logs(run_id, source="llm", limit=100_000), pricing)
    return run
