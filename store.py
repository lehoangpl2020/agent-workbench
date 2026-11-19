"""
RunStore — stores run + iteration history in SQLite (standard sqlite3 module, no ORM).

Tables:
  runs        one row per run: prompt, status, answer, message, timing...
  iterations  one row per iteration: code, stdout/stderr, exit_code, artifacts...

Each SQLite statement here takes only a few ms, so calling it directly from async code is acceptable
for a local app (not worth moving to a thread).
"""

import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
    id              TEXT PRIMARY KEY,
    prompt          TEXT NOT NULL,
    status          TEXT NOT NULL,
    max_iterations  INTEGER NOT NULL,
    timeout_seconds INTEGER NOT NULL,
    model           TEXT DEFAULT '',
    executor        TEXT DEFAULT '',
    answer          TEXT DEFAULT '',
    message         TEXT DEFAULT '',
    iteration_count INTEGER DEFAULT 0,
    created_at      TEXT NOT NULL,
    finished_at     TEXT
);
CREATE TABLE IF NOT EXISTS iterations (
    run_id            TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    number            INTEGER NOT NULL,
    status            TEXT NOT NULL,
    explanation       TEXT DEFAULT '',
    language          TEXT DEFAULT 'python',
    code              TEXT DEFAULT '',
    stdout            TEXT DEFAULT '',
    stderr            TEXT DEFAULT '',
    exit_code         INTEGER,
    execution_time_ms REAL,
    timed_out         INTEGER DEFAULT 0,
    false_success     INTEGER DEFAULT 0,
    artifacts         TEXT DEFAULT '[]',
    started_at        TEXT NOT NULL,
    finished_at       TEXT,
    PRIMARY KEY (run_id, number)
);
CREATE INDEX IF NOT EXISTS idx_runs_created ON runs(created_at DESC);
CREATE TABLE IF NOT EXISTS run_logs (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id    TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    ts        TEXT NOT NULL,
    iteration INTEGER,
    source    TEXT NOT NULL,      -- runtime | llm | model | sandbox
    level     TEXT NOT NULL,      -- INFO | WARN | ERROR
    message   TEXT NOT NULL,
    data      TEXT DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_run_logs_run ON run_logs(run_id, id);
"""

# Columns added after the first version → ALTER TABLE for old DBs (simple, no migration tool needed)
MIGRATIONS = {
    "runs": {
        "activity": "TEXT DEFAULT ''",            # what is happening now (shown in real time)
        "activity_phase": "TEXT DEFAULT ''",      # writing/fixing/streaming/executing/...
        "activity_iteration": "INTEGER",
        "activity_at": "TEXT",
        # The provider that was actually called. Runs created before multi-provider support stay NULL (never guessed/defaulted).
        "provider": "TEXT",
        # 1 = the user enabled the image tool for this run. Older runs get 0, which is true: they could not use it.
        "image_tool": "INTEGER DEFAULT 0",
    },
    "iterations": {
        "intent": "TEXT DEFAULT 'write'",         # write | fix | review
        "intent_detail": "TEXT DEFAULT ''",       # e.g. the error being fixed
    },
}

# Iteration states (shown in the Timeline)
ITER_PLANNING = "planning"      # calling the model
ITER_EXECUTING = "executing"    # running code
ITER_SUCCEEDED = "succeeded"    # exit_code = 0
ITER_FAILED = "failed"          # exit_code != 0
ITER_TIMED_OUT = "timed_out"    # killed because of the timeout
ITER_DONE = "done"              # the model said DONE (no code)
ITER_ACTIVE = (ITER_PLANNING, ITER_EXECUTING)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class RunStore:
    def __init__(self, db_path: str | Path):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        with self._lock:
            self._conn.executescript(SCHEMA)
            for table, columns in MIGRATIONS.items():
                existing = {r["name"] for r in self._conn.execute(f"PRAGMA table_info({table})")}
                for name, ddl in columns.items():
                    if name not in existing:
                        self._conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}")
            self._conn.commit()

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def _exec(self, sql: str, params: tuple = ()) -> None:
        with self._lock:
            self._conn.execute(sql, params)
            self._conn.commit()

    def _query(self, sql: str, params: tuple = ()) -> list[sqlite3.Row]:
        with self._lock:
            return self._conn.execute(sql, params).fetchall()

    # ── Runs ───────────────────────────────────────
    def create_run(self, run_id, prompt, max_iterations, timeout_seconds, model, executor,
                   provider: str | None = None, image_tool: bool = False) -> None:
        self._exec(
            "INSERT INTO runs (id, prompt, status, max_iterations, timeout_seconds, model, "
            "executor, provider, image_tool, created_at) VALUES (?, ?, 'running', ?, ?, ?, ?, ?, ?, ?)",
            (run_id, prompt, max_iterations, timeout_seconds, model, executor, provider, int(image_tool), now_iso()),
        )

    def finish_run(self, run_id, status, answer, message, iteration_count) -> None:
        """Writes the final state + closes every unfinished iteration (planning/executing)."""
        with self._lock:
            self._conn.execute(
                "UPDATE runs SET status=?, answer=?, message=?, iteration_count=?, finished_at=?, "
                "activity='', activity_phase='finished', activity_at=? WHERE id=?",
                (status, answer, message, iteration_count, now_iso(), now_iso(), run_id),
            )
            # Iteration still in progress when the run ended (Stop, error) → takes the run's state
            self._conn.execute(
                "UPDATE iterations SET status=?, finished_at=? WHERE run_id=? AND status IN (?, ?)",
                (status, now_iso(), run_id, *ITER_ACTIVE),
            )
            self._conn.commit()

    def mark_interrupted(self) -> int:
        """On server start: any run still 'running' was interrupted by the server shutting down."""
        rows = self._query("SELECT id, iteration_count FROM runs WHERE status IN ('running', 'pending')")
        for row in rows:
            msg = "Interrupted: the server restarted while this run was in progress."
            self.add_log(row["id"], {"ts": now_iso(), "iteration": None, "source": "runtime",
                                     "level": "ERROR", "message": msg, "data": {}})
            self.finish_run(row["id"], "error", "", msg, self._iteration_count(row["id"]))
        return len(rows)

    def _iteration_count(self, run_id) -> int:
        rows = self._query("SELECT COALESCE(MAX(number), 0) AS n FROM iterations WHERE run_id=?", (run_id,))
        return rows[0]["n"]

    def list_runs(self, limit: int = 100) -> list[dict]:
        rows = self._query(
            "SELECT id, prompt, status, max_iterations, timeout_seconds, message, iteration_count, "
            "provider, model, image_tool, created_at, finished_at FROM runs ORDER BY created_at DESC LIMIT ?",
            (limit,),
        )
        return [{**dict(r), "image_tool": bool(r["image_tool"])} for r in rows]

    def get_run(self, run_id) -> dict | None:
        rows = self._query("SELECT * FROM runs WHERE id=?", (run_id,))
        if not rows:
            return None
        run = dict(rows[0])
        run["image_tool"] = bool(run["image_tool"])
        run["iterations"] = [self._iteration_dict(r) for r in self._query(
            "SELECT * FROM iterations WHERE run_id=? ORDER BY number", (run_id,)
        )]
        # iteration_count in the runs table is only written at the end → take it from the iterations table
        run["iteration_count"] = max(run["iteration_count"] or 0, len(run["iterations"]))
        return run

    @staticmethod
    def _iteration_dict(row: sqlite3.Row) -> dict:
        d = dict(row)
        d["timed_out"] = bool(d["timed_out"])
        d["false_success"] = bool(d["false_success"])
        d["artifacts"] = json.loads(d["artifacts"] or "[]")
        return d

    # ── Activity log ───────────────────────────────
    def add_log(self, run_id: str, entry: dict) -> int:
        with self._lock:
            cur = self._conn.execute(
                "INSERT INTO run_logs (run_id, ts, iteration, source, level, message, data) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (run_id, entry["ts"], entry.get("iteration"), entry["source"], entry["level"],
                 entry["message"], json.dumps(entry.get("data") or {}, default=str)),
            )
            self._conn.commit()
            return cur.lastrowid

    def list_logs(self, run_id: str, after_id: int = 0, iteration: int | None = None,
                  limit: int = 5000, source: str | None = None) -> list[dict]:
        sql = "SELECT * FROM run_logs WHERE run_id=? AND id>?"
        params: list = [run_id, after_id]
        if iteration is not None:
            sql += " AND iteration=?"
            params.append(iteration)
        if source is not None:
            sql += " AND source=?"
            params.append(source)
        sql += " ORDER BY id LIMIT ?"
        params.append(limit)
        rows = self._query(sql, tuple(params))
        return [{**dict(r), "data": json.loads(r["data"] or "{}")} for r in rows]

    # ── Iterations ─────────────────────────────────
    def start_iteration(self, run_id, number, intent="write", intent_detail="") -> None:
        self._exec(
            "INSERT OR REPLACE INTO iterations (run_id, number, status, intent, intent_detail, started_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (run_id, number, ITER_PLANNING, intent, intent_detail, now_iso()),
        )

    def set_activity(self, run_id, iteration, phase, text, touch: bool = True) -> str | None:
        """Current action of the run. touch=False: keeps activity_at (the clock does not reset)."""
        if touch:
            at = now_iso()
            self._exec(
                "UPDATE runs SET activity=?, activity_phase=?, activity_iteration=?, activity_at=? WHERE id=?",
                (text, phase, iteration, at, run_id),
            )
            return at
        else:
            self._exec(
                "UPDATE runs SET activity=?, activity_phase=?, activity_iteration=? WHERE id=?",
                (text, phase, iteration, run_id),
            )
        return None

    def update_iteration(self, run_id, number, **fields) -> None:
        if "artifacts" in fields:
            fields["artifacts"] = json.dumps(fields["artifacts"])
        for key in ("timed_out", "false_success"):
            if key in fields:
                fields[key] = int(bool(fields[key]))
        cols = ", ".join(f"{k}=?" for k in fields)
        self._exec(
            f"UPDATE iterations SET {cols} WHERE run_id=? AND number=?",
            (*fields.values(), run_id, number),
        )
