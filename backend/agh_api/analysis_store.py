"""SQLite-backed, lease-owned queue for asynchronous segmentation runs."""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import sqlite3
import uuid

from .errors import BadRequest, Conflict, NotFound


ACTIVE_CACHE_STATUSES = ("QUEUED", "RUNNING", "SUCCEEDED")
TERMINAL_STATUSES = ("SUCCEEDED", "FAILED")


class LeaseLost(RuntimeError):
    """Raised when a stale worker attempts to mutate a reclaimed run."""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def utc_after(seconds: int | float) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=float(seconds))).isoformat(
        timespec="microseconds"
    )


class AnalysisStore:
    def __init__(self, db_path: Path, lease_seconds: int = 60 * 60):
        self.db_path = Path(db_path)
        self.lease_seconds = max(1, int(lease_seconds or 1))
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.init_db()

    def init_db(self) -> None:
        with self._connect() as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=FULL")
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS analysis_runs (
                    run_id TEXT PRIMARY KEY,
                    cache_key TEXT NOT NULL,
                    case_id TEXT NOT NULL,
                    filename TEXT NOT NULL,
                    z_index INTEGER NOT NULL,
                    channel_index INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    operation TEXT NOT NULL,
                    requested_by TEXT NOT NULL DEFAULT '',
                    request_json TEXT NOT NULL,
                    result_json TEXT,
                    progress_json TEXT NOT NULL,
                    error_code TEXT,
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
                CREATE INDEX IF NOT EXISTS idx_analysis_status_created
                ON analysis_runs(status, created_at)
                """
            )
            conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_analysis_file_created
                ON analysis_runs(case_id, filename, operation, created_at)
                """
            )
            conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_analysis_cache_status
                ON analysis_runs(cache_key, status)
                """
            )

    def create_or_reuse_run(
        self,
        case_id: str,
        filename: str,
        operation: str,
        request_payload: dict,
        *,
        cache_key: str,
        requested_by: str = "",
    ) -> tuple[dict, bool]:
        now = utc_now()
        run_id = str(uuid.uuid4())
        progress = {
            "stage": "queued",
            "fraction": 0.0,
            "percent": 0.0,
            "message": "Waiting for the segmentation worker",
        }
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            existing = conn.execute(
                """
                SELECT * FROM analysis_runs
                WHERE cache_key = ? AND status IN ('QUEUED', 'RUNNING', 'SUCCEEDED')
                ORDER BY created_at DESC, rowid DESC
                LIMIT 1
                """,
                (cache_key,),
            ).fetchone()
            if existing is not None:
                conn.commit()
                return _row_to_dict(existing), True

            conn.execute(
                """
                INSERT INTO analysis_runs (
                    run_id, cache_key, case_id, filename, z_index, channel_index,
                    status, operation, requested_by, request_json, progress_json,
                    created_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'QUEUED', ?, ?, ?, ?, ?)
                """,
                (
                    run_id,
                    str(cache_key),
                    case_id,
                    filename,
                    int(request_payload["zIndex"]),
                    int(request_payload["channelIndex"]),
                    operation,
                    requested_by or "",
                    _json_dump(request_payload),
                    _json_dump(progress),
                    now,
                ),
            )
            conn.commit()
        return self.get_run(run_id), False

    def get_run(self, run_id: str) -> dict:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM analysis_runs WHERE run_id = ?", (str(run_id),)
            ).fetchone()
        if row is None:
            raise NotFound("Analysis run not found")
        return _row_to_dict(row)

    def list_runs(
        self,
        case_id: str,
        filename: str,
        *,
        operation: str | None = None,
        z_index: int | None = None,
        limit=20,
    ) -> list[dict]:
        limit = _bounded_limit(limit)
        where = ["case_id = ?", "filename = ?"]
        params: list[object] = [case_id, filename]
        if operation:
            where.append("operation = ?")
            params.append(operation)
        if z_index is not None:
            if isinstance(z_index, bool) or not isinstance(z_index, int) or z_index < 0:
                raise BadRequest("zIndex must be a non-negative integer")
            where.append("z_index = ?")
            params.append(z_index)
        params.append(limit)
        with self._connect() as conn:
            rows = conn.execute(
                f"""
                SELECT * FROM analysis_runs
                WHERE {' AND '.join(where)}
                ORDER BY created_at DESC, rowid DESC
                LIMIT ?
                """,
                tuple(params),
            ).fetchall()
        return [_row_to_dict(row) for row in rows]

    def list_latest_runs_by_z(
        self,
        case_id: str,
        filename: str,
        *,
        operation: str,
        source_identity: dict | None = None,
    ) -> list[dict]:
        """Return the relevant active/saved run for every source Z slice.

        An active run takes precedence over an older saved mask. Otherwise the
        newest successful run is preferred over failures so a failed retry
        does not hide a usable segmentation. Source identity filtering keeps a
        replaced image from inheriting masks made for the old file contents.
        """
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM analysis_runs
                WHERE case_id = ? AND filename = ? AND operation = ?
                ORDER BY created_at DESC, rowid DESC
                """,
                (case_id, filename, operation),
            ).fetchall()

        selected: dict[int, tuple[int, dict]] = {}
        priority = {"RUNNING": 0, "QUEUED": 0, "SUCCEEDED": 1, "FAILED": 2}
        for row in rows:
            run = _row_to_dict(row)
            if source_identity and not _same_source_identity(
                (run.get("request") or {}).get("source") or {}, source_identity
            ):
                continue
            z_index = run["zIndex"]
            run_priority = priority.get(run["status"], 3)
            current = selected.get(z_index)
            # Rows are newest-first, so only replace an existing choice when
            # this run has a strictly better semantic priority.
            if current is None or run_priority < current[0]:
                selected[z_index] = (run_priority, run)
        return [selected[z][1] for z in sorted(selected)]

    def delete_terminal_runs_for_slice(
        self,
        case_id: str,
        filename: str,
        *,
        operation: str,
        z_index: int,
    ) -> list[str]:
        """Delete all completed/failed records for one slice atomically."""
        if isinstance(z_index, bool) or not isinstance(z_index, int) or z_index < 0:
            raise BadRequest("zIndex must be a non-negative integer")
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            active = conn.execute(
                """
                SELECT 1 FROM analysis_runs
                WHERE case_id = ? AND filename = ? AND operation = ?
                  AND z_index = ? AND status IN ('QUEUED', 'RUNNING')
                LIMIT 1
                """,
                (case_id, filename, operation, z_index),
            ).fetchone()
            if active is not None:
                raise Conflict("A segmentation is still running for this Z slice")
            rows = conn.execute(
                """
                SELECT run_id FROM analysis_runs
                WHERE case_id = ? AND filename = ? AND operation = ?
                  AND z_index = ? AND status IN ('SUCCEEDED', 'FAILED')
                """,
                (case_id, filename, operation, z_index),
            ).fetchall()
            run_ids = [str(row["run_id"]) for row in rows]
            if run_ids:
                placeholders = ",".join("?" for _ in run_ids)
                conn.execute(
                    f"DELETE FROM analysis_runs WHERE run_id IN ({placeholders})",
                    tuple(run_ids),
                )
            conn.commit()
        return run_ids

    def claim_next_run(self, worker_id: str, lease_seconds: int | None = None) -> dict | None:
        if not worker_id:
            raise ValueError("worker_id is required")
        lease_seconds = self.lease_seconds if lease_seconds is None else max(1, int(lease_seconds))
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
                    created_at ASC,
                    rowid ASC
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
                    finished_at = NULL,
                    worker_id = ?,
                    heartbeat_at = ?,
                    lease_expires_at = ?,
                    attempts = attempts + 1,
                    error_code = NULL,
                    error_message = NULL,
                    progress_json = ?
                WHERE run_id = ?
                  AND (
                    status = 'QUEUED'
                    OR (status = 'RUNNING' AND lease_expires_at < ?)
                  )
                """,
                (
                    now,
                    worker_id,
                    now,
                    lease_expires_at,
                    _json_dump(
                        {
                            "stage": "starting",
                            "fraction": 0.0,
                            "percent": 0.0,
                            "message": "Starting segmentation",
                        }
                    ),
                    row["run_id"],
                    now,
                ),
            ).rowcount
            conn.commit()
        if updated != 1:
            return None
        return self.get_run(row["run_id"])

    def heartbeat(self, run_id: str, worker_id: str) -> None:
        self._owned_update(
            run_id,
            worker_id,
            "heartbeat_at = ?, lease_expires_at = ?",
            (utc_now(), utc_after(self.lease_seconds)),
        )

    def update_progress(self, run_id: str, worker_id: str, progress: dict) -> None:
        self._owned_update(
            run_id,
            worker_id,
            "progress_json = ?, heartbeat_at = ?, lease_expires_at = ?",
            (_json_dump(progress), utc_now(), utc_after(self.lease_seconds)),
        )

    def mark_succeeded(self, run_id: str, worker_id: str, result_payload: dict) -> None:
        progress = {
            "stage": "complete",
            "fraction": 1.0,
            "percent": 100.0,
            "message": "Segmentation complete",
        }
        self._owned_terminal_update(
            run_id,
            worker_id,
            status="SUCCEEDED",
            result_payload=result_payload,
            progress=progress,
        )

    def mark_failed(
        self,
        run_id: str,
        worker_id: str,
        error_message: str,
        *,
        error_code: str = "SEGMENTATION_FAILED",
    ) -> None:
        progress = {
            "stage": "failed",
            "fraction": 0.0,
            "percent": 0.0,
            "message": "Segmentation failed",
        }
        self._owned_terminal_update(
            run_id,
            worker_id,
            status="FAILED",
            result_payload=None,
            progress=progress,
            error_code=error_code,
            error_message=error_message,
        )

    def is_owner(self, run_id: str, worker_id: str) -> bool:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT 1 FROM analysis_runs
                WHERE run_id = ? AND status = 'RUNNING' AND worker_id = ?
                """,
                (run_id, worker_id),
            ).fetchone()
        return row is not None

    def _owned_update(self, run_id: str, worker_id: str, assignments: str, values: tuple) -> None:
        with self._connect() as conn:
            updated = conn.execute(
                f"""
                UPDATE analysis_runs SET {assignments}
                WHERE run_id = ? AND status = 'RUNNING' AND worker_id = ?
                """,
                (*values, run_id, worker_id),
            ).rowcount
        if updated != 1:
            raise LeaseLost(f"Worker no longer owns analysis run {run_id}")

    def _owned_terminal_update(
        self,
        run_id: str,
        worker_id: str,
        *,
        status: str,
        result_payload: dict | None,
        progress: dict,
        error_code: str | None = None,
        error_message: str | None = None,
    ) -> None:
        if status not in TERMINAL_STATUSES:
            raise ValueError(f"Invalid terminal status: {status}")
        with self._connect() as conn:
            updated = conn.execute(
                """
                UPDATE analysis_runs
                SET status = ?, result_json = ?, progress_json = ?,
                    error_code = ?, error_message = ?, finished_at = ?,
                    worker_id = NULL, heartbeat_at = NULL, lease_expires_at = NULL
                WHERE run_id = ? AND status = 'RUNNING' AND worker_id = ?
                """,
                (
                    status,
                    _json_dump(result_payload) if result_payload is not None else None,
                    _json_dump(progress),
                    error_code,
                    error_message,
                    utc_now(),
                    run_id,
                    worker_id,
                ),
            ).rowcount
        if updated != 1:
            raise LeaseLost(f"Worker no longer owns analysis run {run_id}")

    @contextmanager
    def _connect(self):
        conn = sqlite3.connect(self.db_path, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout=30000")
        try:
            yield conn
        except Exception:
            conn.rollback()
            raise
        else:
            conn.commit()
        finally:
            conn.close()

    @staticmethod
    def _ensure_columns(conn) -> None:
        existing = {
            row["name"] for row in conn.execute("PRAGMA table_info(analysis_runs)").fetchall()
        }
        columns = {
            "cache_key": "TEXT NOT NULL DEFAULT ''",
            "z_index": "INTEGER NOT NULL DEFAULT 0",
            "channel_index": "INTEGER NOT NULL DEFAULT 0",
            "requested_by": "TEXT NOT NULL DEFAULT ''",
            "error_code": "TEXT",
            "worker_id": "TEXT",
            "heartbeat_at": "TEXT",
            "lease_expires_at": "TEXT",
            "attempts": "INTEGER NOT NULL DEFAULT 0",
        }
        for name, definition in columns.items():
            if name not in existing:
                conn.execute(f"ALTER TABLE analysis_runs ADD COLUMN {name} {definition}")


def public_run(run: dict) -> dict:
    """Return the stable API representation without worker/lease internals."""
    return {
        "runId": run["runId"],
        "case": run["case"],
        "filename": run["filename"],
        "status": run["status"],
        "operation": run["operation"],
        "request": run["request"],
        "result": run["result"],
        "progress": run["progress"],
        "error": (
            {"code": run["errorCode"], "message": run["error"]}
            if run.get("error")
            else None
        ),
        "createdAt": run["createdAt"],
        "startedAt": run["startedAt"],
        "finishedAt": run["finishedAt"],
    }


def _bounded_limit(value) -> int:
    if isinstance(value, bool):
        raise BadRequest("limit must be an integer between 1 and 100")
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise BadRequest("limit must be an integer between 1 and 100") from exc
    if parsed < 1 or parsed > 100:
        raise BadRequest("limit must be an integer between 1 and 100")
    return parsed


def _json_dump(value) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _json_load(value, fallback):
    if value is None:
        return fallback
    try:
        return json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return fallback


def _same_source_identity(stored: dict, current: dict) -> bool:
    for key in ("size", "mtimeNs"):
        try:
            if int(stored.get(key)) != int(current.get(key)):
                return False
        except (TypeError, ValueError):
            return False
    return True


def _row_to_dict(row: sqlite3.Row) -> dict:
    return {
        "runId": row["run_id"],
        "cacheKey": row["cache_key"],
        "case": row["case_id"],
        "filename": row["filename"],
        "zIndex": int(row["z_index"]),
        "channelIndex": int(row["channel_index"]),
        "status": row["status"],
        "operation": row["operation"],
        "requestedBy": row["requested_by"],
        "request": _json_load(row["request_json"], {}),
        "result": _json_load(row["result_json"], None),
        "progress": _json_load(row["progress_json"], {}),
        "errorCode": row["error_code"],
        "error": row["error_message"],
        "createdAt": row["created_at"],
        "startedAt": row["started_at"],
        "finishedAt": row["finished_at"],
        "workerId": row["worker_id"],
        "heartbeatAt": row["heartbeat_at"],
        "leaseExpiresAt": row["lease_expires_at"],
        "attempts": int(row["attempts"] or 0),
    }
