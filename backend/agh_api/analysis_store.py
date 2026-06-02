import json
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .errors import NotFound


STATUSES = {"QUEUED", "RUNNING", "SUCCEEDED", "FAILED"}


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def utc_after(seconds: int | float):
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat(timespec="seconds")


class AnalysisStore:
    def __init__(self, db_path: Path, lease_seconds: int = 3600):
        self.db_path = Path(db_path)
        self.lease_seconds = lease_seconds
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.init_db()

    def init_db(self):
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS analysis_runs (
                    run_id TEXT PRIMARY KEY,
                    case_id TEXT NOT NULL,
                    filename TEXT NOT NULL,
                    status TEXT NOT NULL,
                    operation TEXT NOT NULL,
                    request_json TEXT NOT NULL,
                    result_json TEXT,
                    progress_json TEXT,
                    error_message TEXT,
                    created_at TEXT NOT NULL,
                    started_at TEXT,
                    finished_at TEXT,
                    worker_id TEXT,
                    heartbeat_at TEXT,
                    lease_expires_at TEXT,
                    attempts INTEGER NOT NULL DEFAULT 0
                )
                """
            )
            self._ensure_columns(conn)
            conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_analysis_runs_status_created
                ON analysis_runs(status, created_at)
                """
            )

    def create_run(self, case_id: str, filename: str, operation: str, request_payload: dict) -> dict:
        run_id = str(uuid.uuid4())
        now = utc_now()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO analysis_runs (
                    run_id, case_id, filename, status, operation, request_json, progress_json, created_at
                ) VALUES (?, ?, ?, 'QUEUED', ?, ?, ?, ?)
                """,
                (
                    run_id,
                    case_id,
                    filename,
                    operation,
                    json.dumps(request_payload, sort_keys=True),
                    json.dumps({"current": None, "completed": []}, sort_keys=True),
                    now,
                ),
            )
        return self.get_run(run_id)

    def get_run(self, run_id: str) -> dict:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM analysis_runs WHERE run_id = ?",
                (run_id,),
            ).fetchone()
        if row is None:
            raise NotFound("Analysis run not found")
        return _row_to_dict(row)

    def list_runs(self, case_id: str, filename: str, operation: str | None = None, limit: int = 20) -> list[dict]:
        limit = max(1, min(int(limit or 20), 100))
        where = ["case_id = ?", "filename = ?"]
        params = [case_id, filename]
        if operation:
            where.append("operation = ?")
            params.append(operation)
        params.append(limit)
        with self._connect() as conn:
            rows = conn.execute(
                f"""
                SELECT * FROM analysis_runs
                WHERE {' AND '.join(where)}
                ORDER BY created_at DESC
                LIMIT ?
                """,
                tuple(params),
            ).fetchall()
        return [_row_to_dict(row) for row in rows]

    def list_metric_runs(self, segmentation_run_id: str, limit: int | None = 50) -> list[dict]:
        limit = None if limit is None else max(1, min(int(limit or 50), 100))
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM analysis_runs
                WHERE operation IN ('gbm-thickness', 'process-nnd')
                ORDER BY created_at DESC
                """
            ).fetchall()
        runs = []
        for row in rows:
            run = _row_to_dict(row)
            if (run.get("request") or {}).get("segmentationRunId") == segmentation_run_id:
                runs.append(run)
                if limit is not None and len(runs) >= limit:
                    break
        return runs

    def delete_run(self, run_id: str) -> dict:
        run = self.get_run(run_id)
        child_run_ids = self._metric_run_ids_for_segmentation(run_id)
        with self._connect() as conn:
            conn.execute(
                "DELETE FROM analysis_runs WHERE run_id IN ({})".format(
                    ",".join("?" for _ in [run_id, *child_run_ids])
                ),
                (run_id, *child_run_ids),
            )
        return run

    def claim_next_run(self, worker_id: str | None = None, lease_seconds: int | None = None) -> dict | None:
        worker_id = worker_id or f"worker-{uuid.uuid4()}"
        lease_seconds = self.lease_seconds if lease_seconds is None else lease_seconds
        now = utc_now()
        lease_expires_at = utc_after(lease_seconds)
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                """
                SELECT * FROM analysis_runs
                WHERE status = 'QUEUED'
                   OR (
                        status = 'RUNNING'
                        AND lease_expires_at IS NOT NULL
                        AND lease_expires_at < ?
                   )
                ORDER BY
                    CASE WHEN status = 'RUNNING' THEN 0 ELSE 1 END,
                    created_at ASC
                LIMIT 1
                """,
                (now,),
            ).fetchone()
            if row is None:
                conn.commit()
                return None
            updated = conn.execute(
                """
                UPDATE analysis_runs
                SET status = 'RUNNING',
                    started_at = COALESCE(started_at, ?),
                    worker_id = ?,
                    heartbeat_at = ?,
                    lease_expires_at = ?,
                    attempts = COALESCE(attempts, 0) + 1,
                    error_message = NULL
                WHERE run_id = ?
                  AND (
                    status = 'QUEUED'
                    OR (
                        status = 'RUNNING'
                        AND lease_expires_at IS NOT NULL
                        AND lease_expires_at < ?
                    )
                  )
                """,
                (now, worker_id, now, lease_expires_at, row["run_id"], now),
            ).rowcount
            conn.commit()
            if updated != 1:
                return None
        return self.get_run(row["run_id"])

    def recover_stale_running(self, stale_after_seconds: int = 3600):
        cutoff = (datetime.now(timezone.utc) - timedelta(seconds=stale_after_seconds)).isoformat(timespec="seconds")
        with self._connect() as conn:
            return conn.execute(
                """
                UPDATE analysis_runs
                SET status = 'FAILED',
                    error_message = 'Worker stopped before completing this run',
                    finished_at = ?,
                    worker_id = NULL,
                    heartbeat_at = NULL,
                    lease_expires_at = NULL
                WHERE status = 'RUNNING'
                  AND lease_expires_at IS NULL
                  AND COALESCE(started_at, created_at) < ?
                """,
                (utc_now(), cutoff),
            ).rowcount

    def update_progress(self, run_id: str, current: str | None, completed: list[str]):
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE analysis_runs
                SET progress_json = ?,
                    heartbeat_at = ?,
                    lease_expires_at = ?
                WHERE run_id = ?
                """,
                (
                    json.dumps({"current": current, "completed": completed}, sort_keys=True),
                    utc_now(),
                    utc_after(self.lease_seconds),
                    run_id,
                ),
            )

    def heartbeat(self, run_id: str):
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE analysis_runs
                SET heartbeat_at = ?, lease_expires_at = ?
                WHERE run_id = ? AND status = 'RUNNING'
                """,
                (utc_now(), utc_after(self.lease_seconds), run_id),
            )

    def mark_succeeded(self, run_id: str, result_payload: dict):
        self._set_terminal(run_id, "SUCCEEDED", result_payload, None)

    def mark_failed(self, run_id: str, error_message: str):
        self._set_terminal(run_id, "FAILED", None, error_message)

    def _set_terminal(self, run_id: str, status: str, result_payload: dict | None, error_message: str | None):
        if status not in {"SUCCEEDED", "FAILED"}:
            raise ValueError(f"Invalid terminal status: {status}")
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE analysis_runs
                SET status = ?,
                    result_json = ?,
                    error_message = ?,
                    finished_at = ?,
                    progress_json = ?,
                    worker_id = NULL,
                    heartbeat_at = NULL,
                    lease_expires_at = NULL
                WHERE run_id = ?
                """,
                (
                    status,
                    json.dumps(result_payload, sort_keys=True) if result_payload is not None else None,
                    error_message,
                    utc_now(),
                    json.dumps({"current": None, "completed": result_payload.get("completed", [])} if result_payload else {"current": None, "completed": []}, sort_keys=True),
                    run_id,
                ),
            )

    def _connect(self):
        conn = sqlite3.connect(self.db_path, timeout=30)
        conn.row_factory = sqlite3.Row
        return conn

    def _ensure_columns(self, conn):
        existing = {row["name"] for row in conn.execute("PRAGMA table_info(analysis_runs)").fetchall()}
        columns = {
            "worker_id": "TEXT",
            "heartbeat_at": "TEXT",
            "lease_expires_at": "TEXT",
            "attempts": "INTEGER NOT NULL DEFAULT 0",
        }
        for name, definition in columns.items():
            if name not in existing:
                conn.execute(f"ALTER TABLE analysis_runs ADD COLUMN {name} {definition}")

    def _metric_run_ids_for_segmentation(self, segmentation_run_id: str) -> list[str]:
        return [run["runId"] for run in self.list_metric_runs(segmentation_run_id, limit=None)]


def _json_load(value, fallback):
    if value is None:
        return fallback
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return fallback


def _row_to_dict(row: sqlite3.Row) -> dict:
    return {
        "runId": row["run_id"],
        "case": row["case_id"],
        "filename": row["filename"],
        "status": row["status"],
        "operation": row["operation"],
        "request": _json_load(row["request_json"], {}),
        "result": _json_load(row["result_json"], None),
        "progress": _json_load(row["progress_json"], {"current": None, "completed": []}),
        "error": row["error_message"],
        "createdAt": row["created_at"],
        "startedAt": row["started_at"],
        "finishedAt": row["finished_at"],
        "workerId": row["worker_id"],
        "heartbeatAt": row["heartbeat_at"],
        "leaseExpiresAt": row["lease_expires_at"],
        "attempts": int(row["attempts"] or 0),
    }
