"""
RunWorkspace — a private directory for each run on disk.

    <RUNS_DIR>/<run_id>/
        code/iter_01.py        code of each iteration (written by the server)
        output/                where the code writes files (= /workspace/output in the sandbox)
        snapshots/01/...       copies of files created/changed after iteration 1 → lets you view that exact iteration later

Every artifact path from a client goes through resolve_artifact() to block path traversal.
"""

import mimetypes
import os
import shutil
import uuid
from pathlib import Path

# Files larger than this are not snapshotted (they can still be viewed in output/)
MAX_SNAPSHOT_BYTES = 20 * 1024 * 1024


class ArtifactNotFound(Exception):
    pass


def _validate_run_id(run_id: str) -> str:
    # run_id is always a UUID → it cannot contain "/" or ".." when joined into a path
    return str(uuid.UUID(run_id))


class RunWorkspace:
    def __init__(self, runs_dir: str | Path, run_id: str):
        self.run_id = _validate_run_id(run_id)
        self.root = Path(runs_dir) / self.run_id
        self.code_dir = self.root / "code"
        self.output_dir = self.root / "output"
        self.snapshots_dir = self.root / "snapshots"

    # ── Create directories ─────────────────────────
    def create(self) -> "RunWorkspace":
        self.code_dir.mkdir(parents=True, exist_ok=True)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.snapshots_dir.mkdir(parents=True, exist_ok=True)
        # The sandbox runs as another user (uid 1000) → it needs write permission on output/
        for d in (self.root, self.code_dir, self.output_dir):
            try:
                os.chmod(d, 0o777)
            except OSError:
                pass
        return self

    def write_code(self, iteration: int, code: str, extension: str = "py") -> Path:
        path = self.code_dir / f"iter_{iteration:02d}.{extension}"
        path.write_text(code, encoding="utf-8")
        try:
            os.chmod(path, 0o644)
        except OSError:
            pass
        return path

    # ── List / compare files ───────────────────────
    def scan(self) -> dict[str, tuple[int, int]]:
        """{relative_path: (size, mtime_ns)} for every regular file in output/ (symlinks skipped)."""
        files: dict[str, tuple[int, int]] = {}
        if not self.output_dir.exists():
            return files
        for root, dirs, names in os.walk(self.output_dir, followlinks=False):
            for name in names:
                p = Path(root) / name
                if p.is_symlink() or not p.is_file():
                    continue
                st = p.stat()
                rel = p.relative_to(self.output_dir).as_posix()
                files[rel] = (st.st_size, st.st_mtime_ns)
        return files

    @staticmethod
    def changed_files(before: dict, after: dict) -> list[str]:
        return sorted(p for p, meta in after.items() if before.get(p) != meta)

    def snapshot(self, iteration: int, paths: list[str]) -> None:
        """Copies the files created/changed in this iteration to snapshots/NN/."""
        dest_root = self.snapshots_dir / f"{iteration:02d}"
        for rel in paths:
            src = self.output_dir / rel
            if src.is_symlink() or not src.is_file():
                continue
            if src.stat().st_size > MAX_SNAPSHOT_BYTES:
                continue
            dest = dest_root / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, dest)

    def list_artifacts(self) -> list[dict]:
        return [
            {"path": rel, "size": size, "mime": guess_mime(rel)}
            for rel, (size, _) in sorted(self.scan().items())
        ]

    # ── Safe file reads ────────────────────────────
    def resolve_artifact(self, rel_path: str, iteration: int | None = None) -> Path:
        """
        Returns the absolute path of the artifact, ONLY if it is inside output/ (or a snapshot)
        of this run. Blocks: "../", absolute paths, symlinks pointing outside.
        """
        if not rel_path or "\x00" in rel_path:
            raise ArtifactNotFound(rel_path)
        if iteration is None:
            base = self.output_dir
        else:
            base = self.snapshots_dir / f"{int(iteration):02d}"
        base = base.resolve()
        candidate = base / rel_path
        if candidate.is_symlink():
            raise ArtifactNotFound(rel_path)
        target = candidate.resolve()
        if not target.is_relative_to(base) or not target.is_file():
            raise ArtifactNotFound(rel_path)
        return target


def guess_mime(path: str) -> str:
    mime, _ = mimetypes.guess_type(path)
    return mime or "application/octet-stream"
