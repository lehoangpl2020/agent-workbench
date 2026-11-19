"""
RunWorkspace — thư mục riêng cho từng run trên disk.

    <RUNS_DIR>/<run_id>/
        code/iter_01.py        code của từng iteration (server ghi)
        output/                thư mục code ghi file vào (= /workspace/output trong sandbox)
        snapshots/01/...       bản sao file mới/đổi sau iteration 1 → xem lại đúng iteration

Mọi đường dẫn artifact từ client đều đi qua resolve_artifact() để chặn path traversal.
"""

import mimetypes
import os
import shutil
import uuid
from pathlib import Path

# File lớn hơn ngưỡng này không chụp snapshot (vẫn xem được ở output/)
MAX_SNAPSHOT_BYTES = 20 * 1024 * 1024


class ArtifactNotFound(Exception):
    pass


def _validate_run_id(run_id: str) -> str:
    # run_id luôn là UUID → không thể chứa "/" hay ".." khi ghép vào path
    return str(uuid.UUID(run_id))


class RunWorkspace:
    def __init__(self, runs_dir: str | Path, run_id: str):
        self.run_id = _validate_run_id(run_id)
        self.root = Path(runs_dir) / self.run_id
        self.code_dir = self.root / "code"
        self.output_dir = self.root / "output"
        self.snapshots_dir = self.root / "snapshots"

    # ── Tạo thư mục ────────────────────────────────
    def create(self) -> "RunWorkspace":
        self.code_dir.mkdir(parents=True, exist_ok=True)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.snapshots_dir.mkdir(parents=True, exist_ok=True)
        # Sandbox chạy bằng user khác (uid 1000) → cần quyền ghi vào output/
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

    # ── Liệt kê / so sánh file ─────────────────────
    def scan(self) -> dict[str, tuple[int, int]]:
        """{relative_path: (size, mtime_ns)} của mọi file thường trong output/ (bỏ qua symlink)."""
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
        """Copy file mới/đổi của iteration này sang snapshots/NN/."""
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

    # ── Đọc file an toàn ───────────────────────────
    def resolve_artifact(self, rel_path: str, iteration: int | None = None) -> Path:
        """
        Trả về path tuyệt đối của artifact, CHỈ khi nó nằm trong output/ (hoặc snapshot)
        của đúng run này. Chặn: "../", đường dẫn tuyệt đối, symlink trỏ ra ngoài.
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
