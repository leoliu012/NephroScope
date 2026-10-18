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
# Reusable results first, then active work, then the newest failure/cancellation.
RUN_PRIORITY = {"SUCCEEDED": 0, "RUNNING": 1, "QUEUED": 1, "FAILED": 2, "CANCELED": 2}
CASE_ANALYSIS_STATES = ("active", "interrupted")


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
            # Saved case analyses reference runs by cache key, so a slice
            # completed by any analysis (or the viewer) counts for all of them.
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS case_analyses (
                    analysis_id TEXT PRIMARY KEY,
                    owner TEXT NOT NULL,
                    signature TEXT NOT NULL,
                    state TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    definition_json TEXT NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE UNIQUE INDEX IF NOT EXISTS idx_case_analyses_owner_signature
                ON case_analyses(owner, signature)
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS case_analysis_jobs (
                    analysis_id TEXT NOT NULL,
                    job_id TEXT NOT NULL,
                    position INTEGER NOT NULL,
                    case_id TEXT NOT NULL,
                    filename TEXT NOT NULL,
                    z_index INTEGER NOT NULL,
                    channel_index INTEGER NOT NULL,
                    cache_key TEXT NOT NULL,
                    legacy_cache_key TEXT NOT NULL DEFAULT '',
                    PRIMARY KEY (analysis_id, job_id)
                )
                """
            )
            conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_case_analysis_jobs_cache
                ON case_analysis_jobs(cache_key)
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
        cache_key_aliases: tuple[str, ...] = (),
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
            keys = (cache_key, *cache_key_aliases)
            existing = conn.execute(
                f"""
                SELECT * FROM analysis_runs
                WHERE cache_key IN ({','.join('?' for _ in keys)}) AND status IN ('QUEUED', 'RUNNING', 'SUCCEEDED')
                ORDER BY created_at DESC, rowid DESC
                LIMIT 1
                """,
                keys,
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
            if run["status"] == "CANCELED":
                # A cancelled queue entry never produced anything to show.
                continue
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
                  AND z_index = ? AND status IN ('SUCCEEDED', 'FAILED', 'CANCELED')
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

    def get_runs(self, run_ids) -> dict[str, dict]:
        """Return the runs that still exist, keyed by run ID."""
        ids = list(dict.fromkeys(str(run_id) for run_id in run_ids))
        found: dict[str, dict] = {}
        with self._connect() as conn:
            for chunk in _chunks(ids):
                rows = conn.execute(
                    f"SELECT * FROM analysis_runs WHERE run_id IN ({_placeholders(chunk)})",
                    tuple(chunk),
                ).fetchall()
                for row in rows:
                    found[str(row["run_id"])] = _row_to_dict(row)
        return found

    def best_runs_for_cache_keys(self, cache_keys) -> dict[str, dict]:
        """The most useful run per cache key: saved > active > newest failure."""
        keys = list(dict.fromkeys(str(key) for key in cache_keys if key))
        best: dict[str, tuple[int, dict]] = {}
        with self._connect() as conn:
            for chunk in _chunks(keys):
                # Status lookups only: skip the (large) request payload.
                rows = conn.execute(
                    f"""
                    SELECT run_id, cache_key, case_id, filename, z_index, channel_index, status,
                           operation, result_json, progress_json, error_code, error_message,
                           created_at, started_at, finished_at
                    FROM analysis_runs
                    WHERE cache_key IN ({_placeholders(chunk)})
                    ORDER BY created_at DESC, rowid DESC
                    """,
                    tuple(chunk),
                ).fetchall()
                for row in rows:
                    run = _row_to_status_dict(row)
                    priority = RUN_PRIORITY.get(run["status"], 3)
                    current = best.get(run["cacheKey"])
                    if current is None or priority < current[0]:
                        best[run["cacheKey"]] = (priority, run)
        return {key: run for key, (_, run) in best.items()}

    def cancel_queued_runs(self, run_ids, *, exclude_analysis_id: str | None = None) -> tuple[list[str], list[str]]:
        """Cancel runs that have not started yet.

        Runs that another active saved analysis still needs are kept queued, so
        interrupting one analysis never silently stalls a different one.
        Returns ``(canceled, kept)``.
        """
        ids = list(dict.fromkeys(str(run_id) for run_id in run_ids))
        canceled: list[str] = []
        kept: list[str] = []
        progress = _json_dump({
            "stage": "canceled",
            "fraction": 0.0,
            "percent": 0.0,
            "message": "Canceled before the model started",
        })
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            for chunk in _chunks(ids):
                rows = conn.execute(
                    f"""
                    SELECT run_id, cache_key FROM analysis_runs
                    WHERE run_id IN ({_placeholders(chunk)}) AND status = 'QUEUED'
                    """,
                    tuple(chunk),
                ).fetchall()
                if not rows:
                    continue
                keys = [str(row["cache_key"]) for row in rows]
                protected = {
                    str(row["key"])
                    for row in conn.execute(
                        f"""
                        SELECT jobs.cache_key AS key FROM case_analysis_jobs AS jobs
                        JOIN case_analyses AS analyses ON analyses.analysis_id = jobs.analysis_id
                        WHERE analyses.state = 'active' AND analyses.analysis_id != ?
                          AND jobs.cache_key IN ({_placeholders(keys)})
                        UNION
                        SELECT jobs.legacy_cache_key AS key FROM case_analysis_jobs AS jobs
                        JOIN case_analyses AS analyses ON analyses.analysis_id = jobs.analysis_id
                        WHERE analyses.state = 'active' AND analyses.analysis_id != ?
                          AND jobs.legacy_cache_key IN ({_placeholders(keys)})
                        """,
                        (exclude_analysis_id or "", *keys, exclude_analysis_id or "", *keys),
                    ).fetchall()
                }
                for row in rows:
                    run_id = str(row["run_id"])
                    if str(row["cache_key"]) in protected:
                        kept.append(run_id)
                        continue
                    updated = conn.execute(
                        """
                        UPDATE analysis_runs
                        SET status = 'CANCELED', progress_json = ?, finished_at = ?
                        WHERE run_id = ? AND status = 'QUEUED'
                        """,
                        (progress, utc_now(), run_id),
                    ).rowcount
                    (canceled if updated == 1 else kept).append(run_id)
            conn.commit()
        return canceled, kept

    def save_case_analysis(self, owner: str, signature: str, definition: dict, jobs: list[dict]) -> tuple[str, bool]:
        """Create a saved analysis, or merge into the owner's identical one.

        Returns ``(analysis_id, merged)``. Merging keeps the original ID and
        creation time, refreshes the definition (for example calibration) and
        makes the analysis active again.
        """
        now = utc_now()
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            existing = conn.execute(
                "SELECT analysis_id FROM case_analyses WHERE owner = ? AND signature = ?",
                (owner, signature),
            ).fetchone()
            if existing is not None:
                analysis_id = str(existing["analysis_id"])
                conn.execute(
                    """
                    UPDATE case_analyses SET definition_json = ?, state = 'active', updated_at = ?
                    WHERE analysis_id = ?
                    """,
                    (_json_dump(definition), now, analysis_id),
                )
            else:
                analysis_id = str(uuid.uuid4())
                conn.execute(
                    """
                    INSERT INTO case_analyses (
                        analysis_id, owner, signature, state, created_at, updated_at, definition_json
                    ) VALUES (?, ?, ?, 'active', ?, ?, ?)
                    """,
                    (analysis_id, owner, signature, now, now, _json_dump(definition)),
                )
            self._replace_case_analysis_jobs(conn, analysis_id, jobs)
            conn.commit()
        return analysis_id, existing is not None

    def update_case_analysis_jobs(self, owner: str, analysis_id: str, jobs: list[dict]) -> None:
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            self._require_case_analysis(conn, owner, analysis_id)
            self._replace_case_analysis_jobs(conn, analysis_id, jobs)
            conn.commit()

    def set_case_analysis_state(self, owner: str, analysis_id: str, state: str) -> None:
        if state not in CASE_ANALYSIS_STATES:
            raise ValueError(f"Invalid case analysis state: {state}")
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            self._require_case_analysis(conn, owner, analysis_id)
            conn.execute(
                "UPDATE case_analyses SET state = ?, updated_at = ? WHERE analysis_id = ?",
                (state, utc_now(), analysis_id),
            )
            conn.commit()

    def list_case_analyses(self, owner: str) -> list[dict]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM case_analyses WHERE owner = ?
                ORDER BY updated_at DESC, rowid DESC
                """,
                (owner,),
            ).fetchall()
            jobs = self._case_analysis_jobs(conn, [str(row["analysis_id"]) for row in rows])
        return [_case_analysis_to_dict(row, jobs.get(str(row["analysis_id"]), [])) for row in rows]

    def get_case_analysis(self, owner: str, analysis_id: str) -> dict:
        with self._connect() as conn:
            row = self._require_case_analysis(conn, owner, analysis_id)
            jobs = self._case_analysis_jobs(conn, [analysis_id])
        return _case_analysis_to_dict(row, jobs.get(analysis_id, []))

    def delete_case_analysis(self, owner: str, analysis_id: str) -> None:
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            self._require_case_analysis(conn, owner, analysis_id)
            conn.execute("DELETE FROM case_analysis_jobs WHERE analysis_id = ?", (analysis_id,))
            conn.execute("DELETE FROM case_analyses WHERE analysis_id = ?", (analysis_id,))
            conn.commit()

    @staticmethod
    def _require_case_analysis(conn, owner: str, analysis_id: str):
        row = conn.execute(
            "SELECT * FROM case_analyses WHERE analysis_id = ? AND owner = ?",
            (str(analysis_id), owner),
        ).fetchone()
        if row is None:
            raise NotFound("Case analysis not found")
        return row

    @staticmethod
    def _replace_case_analysis_jobs(conn, analysis_id: str, jobs: list[dict]) -> None:
        conn.execute("DELETE FROM case_analysis_jobs WHERE analysis_id = ?", (analysis_id,))
        conn.executemany(
            """
            INSERT INTO case_analysis_jobs (
                analysis_id, job_id, position, case_id, filename, z_index,
                channel_index, cache_key, legacy_cache_key
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    analysis_id, job["id"], position, job["caseId"], job["filename"],
                    int(job["zIndex"]), int(job["channelIndex"]), job["cacheKey"],
                    job.get("legacyCacheKey") or "",
                )
                for position, job in enumerate(jobs)
            ],
        )

    @staticmethod
    def _case_analysis_jobs(conn, analysis_ids: list[str]) -> dict[str, list[dict]]:
        grouped: dict[str, list[dict]] = {}
        for chunk in _chunks(analysis_ids):
            rows = conn.execute(
                f"""
                SELECT * FROM case_analysis_jobs
                WHERE analysis_id IN ({_placeholders(chunk)})
                ORDER BY analysis_id, position
                """,
                tuple(chunk),
            ).fetchall()
            for row in rows:
                grouped.setdefault(str(row["analysis_id"]), []).append({
                    "id": row["job_id"],
                    "caseId": row["case_id"],
                    "filename": row["filename"],
                    "zIndex": int(row["z_index"]),
                    "channelIndex": int(row["channel_index"]),
                    "cacheKey": row["cache_key"],
                    "legacyCacheKey": row["legacy_cache_key"] or "",
                })
        return grouped

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


def _row_to_status_dict(row: sqlite3.Row) -> dict:
    return {
        "runId": row["run_id"],
        "cacheKey": row["cache_key"],
        "case": row["case_id"],
        "filename": row["filename"],
        "zIndex": int(row["z_index"]),
        "channelIndex": int(row["channel_index"]),
        "status": row["status"],
        "operation": row["operation"],
        "result": _json_load(row["result_json"], None),
        "progress": _json_load(row["progress_json"], {}),
        "errorCode": row["error_code"],
        "error": row["error_message"],
        "createdAt": row["created_at"],
        "startedAt": row["started_at"],
        "finishedAt": row["finished_at"],
    }


def _case_analysis_to_dict(row: sqlite3.Row, jobs: list[dict]) -> dict:
    return {
        "id": row["analysis_id"],
        "owner": row["owner"],
        "signature": row["signature"],
        "state": row["state"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "definition": _json_load(row["definition_json"], {}),
        "jobs": jobs,
    }


def _chunks(values: list, size: int = 400):
    for start in range(0, len(values), size):
        yield values[start:start + size]


def _placeholders(values) -> str:
    return ",".join("?" for _ in values)


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
