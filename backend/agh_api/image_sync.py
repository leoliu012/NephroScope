"""Remote-authoritative image cache synchronization.

The Flask API only ever reads ``Config.data_root``.  This module is used by a
separate process to mirror a mounted remote folder into that local cache.  A
small SQLite index lets a remote rename be applied as a local ``os.replace``
instead of downloading the microscopy file again.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import sqlite3
import tempfile
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Callable, Iterator, Optional

from .audit import AuditLog
from .config import Config


log = logging.getLogger(__name__)

IMAGE_EXTENSIONS = frozenset({".tif", ".tiff", ".nd2"})
INDEX_FILENAME = "sync-index.sqlite"
STATUS_FILENAME = "sync-status.json"
REQUEST_FILENAME = "manual-sync-request.json"
LOCK_FILENAME = "sync.lock"
COPY_CHUNK_BYTES = 1024 * 1024
PROGRESS_REPORT_SECONDS = 15


class SyncConfigurationError(RuntimeError):
    """Raised when a remote sync has not been configured safely."""


@dataclass
class RemoteFile:
    relative_path: str
    source_path: Path
    size: int
    modified_time: int
    fingerprint: str
    full_hash: Optional[str] = None


def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _format_bytes(value: int | float) -> str:
    """Format byte counts for human-readable sync progress messages."""
    value = float(value)
    for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
        if value < 1024 or unit == "TiB":
            return f"{value:.1f} {unit}" if unit != "B" else f"{int(value)} B"
        value /= 1024
    return f"{value:.1f} TiB"


def _safe_relative_path(value: str) -> PurePosixPath:
    path = PurePosixPath(value)
    if path.is_absolute() or not path.parts or any(part in {"", ".", ".."} for part in path.parts):
        raise ValueError("Invalid relative sync path")
    return path


def _is_temporary_name(name: str) -> bool:
    lowered = name.lower()
    return (
        name.startswith((".", "~"))
        or name.endswith("~")
        or any(marker in lowered for marker in (".partial", ".part", ".tmp", ".upload", ".inprogress"))
    )


def is_syncable_image(path: Path) -> bool:
    """Return whether *path* is a final TIFF/ND2 file suitable for syncing."""
    return path.suffix.lower() in IMAGE_EXTENSIONS and not _is_temporary_name(path.name)


def _fingerprint(path: Path, size: Optional[int] = None, sample_bytes: int = 4 * 1024 * 1024) -> str:
    """Fast identity for large files: size plus hashes of the two end samples."""
    size = path.stat().st_size if size is None else size
    sample_bytes = max(1024, sample_bytes)
    first = hashlib.sha256()
    last = hashlib.sha256()
    with path.open("rb") as handle:
        first_sample = handle.read(min(sample_bytes, size))
        first.update(first_sample)
        if size > sample_bytes:
            handle.seek(max(0, size - sample_bytes))
            last.update(handle.read(sample_bytes))
        else:
            last.update(first_sample)
    return f"{size}:{first.hexdigest()}:{last.hexdigest()}"


def _full_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(COPY_CHUNK_BYTES)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def _atomic_json_write(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-", suffix=".json")
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(payload, handle, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def _read_json(path: Path) -> dict:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _state_path(config: Config, filename: str) -> Path:
    return Path(config.sync_state_dir) / filename


def sync_status(config: Config) -> dict:
    """Read the service status without touching the remote mounted folder."""
    configured = bool(config.remote_data_root)
    status = _read_json(_state_path(config, STATUS_FILENAME)) if configured else {}
    status.setdefault("configured", configured)
    status.setdefault("state", "idle" if configured else "disabled")
    status.setdefault("intervalSeconds", config.sync_interval_seconds)
    status["manualRequestPending"] = _state_path(config, REQUEST_FILENAME).exists() if configured else False
    return status


def request_manual_sync(config: Config, actor: str = "") -> dict:
    """Queue a sync for the standalone worker and return its current status."""
    if not config.remote_data_root:
        raise SyncConfigurationError("Image sync is not configured (set AGH_REMOTE_DATA_ROOT)")
    state_dir = Path(config.sync_state_dir)
    state_dir.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(state_dir, 0o700)
    except OSError:
        pass
    _atomic_json_write(_state_path(config, REQUEST_FILENAME), {
        "requestId": uuid.uuid4().hex,
        "requestedAt": _timestamp(),
        "requestedBy": actor,
    })
    status = sync_status(config)
    status["manualRequestPending"] = True
    return status


@contextmanager
def _process_lock(path: Path) -> Iterator[None]:
    """Prevent accidental duplicate workers on the Linux deployment host."""
    try:
        import fcntl
    except ImportError:  # pragma: no cover - production runs on Linux
        yield
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


class RemoteImageSync:
    """One remote-to-local, remote-authoritative synchronization pass."""

    def __init__(self, config: Config):
        self.config = config
        self.local_root = Path(config.data_root)
        self.remote_root = Path(config.remote_data_root) if config.remote_data_root else None
        self.state_dir = Path(config.sync_state_dir)

    @property
    def index_path(self) -> Path:
        return self.state_dir / INDEX_FILENAME

    @property
    def status_path(self) -> Path:
        return self.state_dir / STATUS_FILENAME

    @property
    def lock_path(self) -> Path:
        return self.state_dir / LOCK_FILENAME

    def _require_configured_roots(self) -> None:
        if not self.remote_root:
            raise SyncConfigurationError("AGH_REMOTE_DATA_ROOT is not configured")
        if not self.remote_root.is_dir():
            raise SyncConfigurationError(f"Remote image folder is unavailable: {self.remote_root}")
        if self.local_root.resolve() == self.remote_root.resolve():
            raise SyncConfigurationError("Remote and local image folders must be different")
        self.local_root.mkdir(parents=True, exist_ok=True)
        self.state_dir.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(self.state_dir, 0o700)
        except OSError:
            pass

    def _write_status(self, **payload) -> None:
        current = _read_json(self.status_path)
        current.update(payload)
        current["configured"] = bool(self.remote_root)
        current["intervalSeconds"] = self.config.sync_interval_seconds
        current["updatedAt"] = _timestamp()
        current["manualRequestPending"] = _state_path(self.config, REQUEST_FILENAME).exists()
        _atomic_json_write(self.status_path, current)

    def _write_progress(
        self,
        *,
        phase: str,
        total_files: Optional[int],
        completed_files: int,
        total_bytes: int = 0,
        completed_bytes: int = 0,
        current_file: str = "",
        current_file_bytes: int = 0,
    ) -> None:
        """Persist progress for the admin console without touching the API."""
        bytes_done = max(0, completed_bytes + current_file_bytes)
        percent = round(min(100, bytes_done / total_bytes * 100), 1) if total_bytes else None
        self._write_status(
            state="running",
            message="Scanning remote image folder" if phase == "scanning" else "Synchronizing local image cache",
            progress={
                "phase": phase,
                "totalFiles": total_files,
                "completedFiles": completed_files,
                "totalBytes": total_bytes,
                "completedBytes": min(total_bytes, bytes_done) if total_bytes else 0,
                "currentFile": current_file,
                "currentFileBytes": current_file_bytes,
                "percent": percent,
            },
        )

    def _record_sync_audit(self, *, reason: str, actor: str, result: str, counts: dict, error: str = "") -> None:
        details = {"source": "remote-cache", "reason": reason, **counts}
        if error:
            details["error"] = error
        try:
            AuditLog(self.config.audit_log_file).record(
                action="IMAGE_SYNC",
                actor=actor or "system",
                result=result,
                details=details,
            )
        except OSError as exc:
            log.warning("Could not record image-sync audit event: %s", exc)

    def _connect_index(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.index_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=FULL")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS sync_index (
                file_id TEXT PRIMARY KEY,
                local_path TEXT NOT NULL UNIQUE,
                remote_path TEXT NOT NULL UNIQUE,
                file_size INTEGER NOT NULL,
                modified_time INTEGER NOT NULL,
                content_fingerprint TEXT NOT NULL,
                full_hash TEXT,
                last_synced_at TEXT NOT NULL
            )
            """
        )
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(sync_index)")}
        if "full_hash" not in columns:
            conn.execute("ALTER TABLE sync_index ADD COLUMN full_hash TEXT")
        return conn

    def _local_path(self, relative_path: str) -> Path:
        relative = _safe_relative_path(relative_path)
        candidate = self.local_root.joinpath(*relative.parts)
        try:
            candidate.resolve().relative_to(self.local_root.resolve())
        except ValueError as exc:
            raise SyncConfigurationError("Sync path escapes local image cache") from exc
        return candidate

    def _scan_remote(self) -> list[RemoteFile]:
        assert self.remote_root is not None
        files: list[RemoteFile] = []
        log.info("Scanning remote image folder: %s", self.remote_root)
        for directory, child_dirs, child_files in os.walk(self.remote_root):
            # Ignore hidden and temporary directories before descending.  A
            # partial microscopy upload is commonly written inside one of them.
            child_dirs[:] = [name for name in child_dirs if not _is_temporary_name(name)]
            base = Path(directory)
            for name in child_files:
                source = base / name
                if not is_syncable_image(source) or source.is_symlink():
                    continue
                try:
                    stat = source.stat()
                    if not source.is_file():
                        continue
                    relative = source.relative_to(self.remote_root).as_posix()
                    _safe_relative_path(relative)
                    log.info("Fingerprinting remote image: %s (%s)", relative, _format_bytes(stat.st_size))
                    files.append(RemoteFile(
                        relative_path=relative,
                        source_path=source,
                        size=stat.st_size,
                        modified_time=stat.st_mtime_ns,
                        fingerprint=_fingerprint(source, stat.st_size, self.config.sync_fingerprint_bytes),
                    ))
                except OSError as exc:
                    log.warning("Skipping unreadable remote image %s: %s", source, exc)
        files = sorted(files, key=lambda item: item.relative_path)
        log.info("Remote scan complete: %d eligible image(s)", len(files))
        return files

    def _scan_local_images(self) -> Iterator[tuple[str, Path]]:
        if not self.local_root.exists():
            return
        for directory, child_dirs, child_files in os.walk(self.local_root):
            child_dirs[:] = [name for name in child_dirs if not name.startswith(".")]
            base = Path(directory)
            for name in child_files:
                path = base / name
                if path.is_symlink() or not is_syncable_image(path):
                    continue
                try:
                    yield path.relative_to(self.local_root).as_posix(), path
                except ValueError:
                    continue

    @staticmethod
    def _same_cached_file(path: Path, remote: RemoteFile, row: sqlite3.Row) -> bool:
        try:
            stat = path.stat()
        except OSError:
            return False
        return (
            path.is_file()
            and stat.st_size == remote.size
            and row["content_fingerprint"] == remote.fingerprint
        )

    def _complete_hash_for_remote(self, remote: RemoteFile) -> str:
        if not remote.full_hash:
            remote.full_hash = _full_hash(remote.source_path)
        return remote.full_hash

    def _rename_candidate(
        self,
        remote: RemoteFile,
        rows: list[sqlite3.Row],
        reserved_ids: set[str],
    ) -> Optional[sqlite3.Row]:
        candidates = [
            row for row in rows
            if row["file_id"] not in reserved_ids
            and row["content_fingerprint"] == remote.fingerprint
            and self._local_path(row["local_path"]).is_file()
        ]
        if len(candidates) == 1:
            return candidates[0]
        if len(candidates) < 2:
            return None

        # Fast fingerprints can be ambiguous for duplicate files.  Pay the
        # complete-hash cost only in that unusual case, then retain it in the
        # index for later ambiguity checks.
        remote_hash = self._complete_hash_for_remote(remote)
        exact = []
        for row in candidates:
            local_hash = row["full_hash"] or _full_hash(self._local_path(row["local_path"]))
            if local_hash == remote_hash:
                exact.append(row)
        return exact[0] if len(exact) == 1 else None

    def _copy_atomic(
        self,
        remote: RemoteFile,
        destination: Path,
        on_progress: Optional[Callable[[int], None]] = None,
    ) -> bool:
        """Copy a stable source through a local temp file, then atomically publish."""
        destination.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(dir=str(destination.parent), prefix=".agh-sync-", suffix=".partial")
        tmp = Path(tmp_name)
        log.info("Copying %s -> %s (%s)", remote.relative_path, destination, _format_bytes(remote.size))
        started = time.monotonic()
        last_report = started
        copied = 0
        try:
            if on_progress:
                on_progress(0)
            with os.fdopen(fd, "wb") as target, remote.source_path.open("rb") as source:
                while True:
                    chunk = source.read(COPY_CHUNK_BYTES)
                    if not chunk:
                        break
                    target.write(chunk)
                    copied += len(chunk)
                    now = time.monotonic()
                    if now - last_report >= PROGRESS_REPORT_SECONDS:
                        percent = (copied / remote.size * 100) if remote.size else 100
                        rate = copied / max(now - started, 0.001)
                        log.info(
                            "Copy progress %s: %s / %s (%.1f%% at %s/s)",
                            remote.relative_path,
                            _format_bytes(copied),
                            _format_bytes(remote.size),
                            percent,
                            _format_bytes(rate),
                        )
                        if on_progress:
                            on_progress(copied)
                        last_report = now
                target.flush()
                os.fsync(target.fileno())
            after = remote.source_path.stat()
            stable = (
                after.st_size == remote.size
                and after.st_mtime_ns == remote.modified_time
                and _fingerprint(remote.source_path, after.st_size, self.config.sync_fingerprint_bytes) == remote.fingerprint
            )
            if not stable:
                log.warning("Source changed during copy; deferring %s until the next sync", remote.relative_path)
                return False
            os.utime(tmp, ns=(remote.modified_time, remote.modified_time))
            os.replace(tmp, destination)
            if on_progress:
                on_progress(copied)
            elapsed = max(time.monotonic() - started, 0.001)
            log.info("Copied %s in %.1fs (%s/s)", remote.relative_path, elapsed, _format_bytes(copied / elapsed))
            return True
        except OSError:
            raise
        finally:
            tmp.unlink(missing_ok=True)

    def _apply_renames(self, moves: list[tuple[sqlite3.Row, RemoteFile]]) -> None:
        staged: list[tuple[Path, Path]] = []
        for row, remote in moves:
            source = self._local_path(row["local_path"])
            destination = self._local_path(remote.relative_path)
            if source == destination:
                continue
            if not source.is_file():
                continue
            log.info("Renaming cached image: %s -> %s", row["local_path"], remote.relative_path)
            temporary = source.with_name(f".agh-sync-rename-{uuid.uuid4().hex}")
            os.replace(source, temporary)
            staged.append((temporary, destination))
        for temporary, destination in staged:
            destination.parent.mkdir(parents=True, exist_ok=True)
            os.replace(temporary, destination)

    def _upsert(self, conn: sqlite3.Connection, *, row: Optional[sqlite3.Row], remote: RemoteFile, local_path: str) -> None:
        conn.execute(
            """
            INSERT INTO sync_index (
                file_id, local_path, remote_path, file_size, modified_time,
                content_fingerprint, full_hash, last_synced_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(file_id) DO UPDATE SET
                local_path=excluded.local_path,
                remote_path=excluded.remote_path,
                file_size=excluded.file_size,
                modified_time=excluded.modified_time,
                content_fingerprint=excluded.content_fingerprint,
                full_hash=excluded.full_hash,
                last_synced_at=excluded.last_synced_at
            """,
            (
                row["file_id"] if row else uuid.uuid4().hex,
                local_path,
                remote.relative_path,
                remote.size,
                remote.modified_time,
                remote.fingerprint,
                remote.full_hash if remote.full_hash else (row["full_hash"] if row else None),
                _timestamp(),
            ),
        )

    def _remove_empty_local_directories(self) -> None:
        for directory, _, _ in os.walk(self.local_root, topdown=False):
            path = Path(directory)
            if path == self.local_root or path.name.startswith("."):
                continue
            try:
                path.rmdir()
            except OSError:
                pass

    def sync_once(self, reason: str = "scheduled", actor: str = "system") -> dict:
        """Perform one safe pass.  The remote folder is always authoritative."""
        self._require_configured_roots()
        started_at = _timestamp()
        log.info("Starting %s image sync: remote=%s local=%s", reason, self.remote_root, self.local_root)
        self._write_status(
            state="running",
            reason=reason,
            lastStartedAt=started_at,
            message="Scanning remote image folder",
            progress={
                "phase": "scanning",
                "totalFiles": None,
                "completedFiles": 0,
                "totalBytes": 0,
                "completedBytes": 0,
                "currentFile": "",
                "currentFileBytes": 0,
                "percent": None,
            },
        )
        counts = {"remote": 0, "copied": 0, "renamed": 0, "deleted": 0, "unchanged": 0, "deferred": 0}
        try:
            with _process_lock(self.lock_path):
                remote_files = self._scan_remote()
                counts["remote"] = len(remote_files)
                total_bytes = sum(item.size for item in remote_files)
                completed_files = 0
                completed_bytes = 0

                def update_progress(phase: str, remote: RemoteFile, current_file_bytes: int = 0) -> None:
                    self._write_progress(
                        phase=phase,
                        total_files=len(remote_files),
                        completed_files=completed_files,
                        total_bytes=total_bytes,
                        completed_bytes=completed_bytes,
                        current_file=remote.relative_path,
                        current_file_bytes=current_file_bytes,
                    )

                def complete_remote(phase: str, remote: RemoteFile) -> None:
                    nonlocal completed_files, completed_bytes
                    completed_files += 1
                    completed_bytes += remote.size
                    update_progress(phase, remote)

                self._write_progress(
                    phase="checking",
                    total_files=len(remote_files),
                    completed_files=0,
                    total_bytes=total_bytes,
                    completed_bytes=0,
                )
                with self._connect_index() as conn:
                    rows = list(conn.execute("SELECT * FROM sync_index"))
                    by_remote = {row["remote_path"]: row for row in rows}
                    remote_paths = {item.relative_path for item in remote_files}
                    active_rows: set[str] = set()
                    preserved_rows: set[str] = set()
                    moves: list[tuple[sqlite3.Row, RemoteFile]] = []
                    transfers: list[tuple[Optional[sqlite3.Row], RemoteFile]] = []

                    # Exact paths are either unchanged, changed in place, or
                    # copied.  They are never used as rename sources.
                    for remote in remote_files:
                        row = by_remote.get(remote.relative_path)
                        destination = self._local_path(remote.relative_path)
                        if row and self._same_cached_file(destination, remote, row):
                            active_rows.add(row["file_id"])
                            self._upsert(conn, row=row, remote=remote, local_path=remote.relative_path)
                            counts["unchanged"] += 1
                            complete_remote("checking", remote)
                        else:
                            transfers.append((row, remote))

                    # A remote path with no prior index entry can inherit an
                    # old local cache file only when its identity is unique.
                    rename_sources = [
                        row for row in rows
                        if row["remote_path"] not in remote_paths and row["file_id"] not in active_rows
                    ]
                    reserved_ids: set[str] = set()
                    remaining_transfers: list[tuple[Optional[sqlite3.Row], RemoteFile]] = []
                    for row, remote in transfers:
                        if row is not None:
                            remaining_transfers.append((row, remote))
                            continue
                        candidate = self._rename_candidate(remote, rename_sources, reserved_ids)
                        if candidate is None:
                            remaining_transfers.append((None, remote))
                            continue
                        moves.append((candidate, remote))
                        reserved_ids.add(candidate["file_id"])

                    self._apply_renames(moves)
                    for row, remote in moves:
                        active_rows.add(row["file_id"])
                        self._upsert(conn, row=row, remote=remote, local_path=remote.relative_path)
                        counts["renamed"] += 1
                        complete_remote("renaming", remote)

                    for row, remote in remaining_transfers:
                        destination = self._local_path(remote.relative_path)
                        if self._copy_atomic(
                            remote,
                            destination,
                            on_progress=lambda copied, item=remote: update_progress("copying", item, copied),
                        ):
                            if row:
                                active_rows.add(row["file_id"])
                            self._upsert(conn, row=row, remote=remote, local_path=remote.relative_path)
                            counts["copied"] += 1
                        else:
                            # Do not drop the prior cached image if the source
                            # changed while it was being copied.  It will be
                            # retried on the next scheduled/manual pass.
                            if row:
                                active_rows.add(row["file_id"])
                                preserved_rows.add(row["file_id"])
                            counts["deferred"] += 1
                        complete_remote("checking", remote)

                    # Any indexed file absent from the remote source is stale.
                    # This is the one-way, remote-authoritative delete policy.
                    stale_rows = [row for row in rows if row["file_id"] not in active_rows]
                    keep_paths = set()
                    for row in stale_rows:
                        if row["file_id"] in preserved_rows:
                            keep_paths.add(row["local_path"])
                            continue
                        path = self._local_path(row["local_path"])
                        try:
                            log.info("Removing stale cached image: %s", row["local_path"])
                            path.unlink(missing_ok=True)
                            counts["deleted"] += 1
                        except OSError as exc:
                            log.warning("Could not remove stale cached image %s: %s", path, exc)
                            keep_paths.add(row["local_path"])
                            continue
                        conn.execute("DELETE FROM sync_index WHERE file_id = ?", (row["file_id"],))

                    # On a first run there is no index yet.  Remove unsupported
                    # stale cache entries too, so the remote is fully
                    # authoritative rather than merely additive.
                    desired_paths = {item.relative_path for item in remote_files} | keep_paths
                    for relative, path in self._scan_local_images() or ():
                        if relative in desired_paths:
                            continue
                        try:
                            log.info("Removing unindexed stale cached image: %s", relative)
                            path.unlink(missing_ok=True)
                            counts["deleted"] += 1
                        except OSError as exc:
                            log.warning("Could not remove stale cached image %s: %s", path, exc)
                    self._remove_empty_local_directories()

                self._write_progress(
                    phase="finalizing",
                    total_files=len(remote_files),
                    completed_files=completed_files,
                    total_bytes=total_bytes,
                    completed_bytes=completed_bytes,
                )

            result = {
                "state": "idle",
                "reason": reason,
                "lastStartedAt": started_at,
                "lastCompletedAt": _timestamp(),
                "lastSuccessAt": _timestamp(),
                "message": "Image cache is synchronized",
                "counts": counts,
                "progress": {
                    "phase": "complete",
                    "totalFiles": counts["remote"],
                    "completedFiles": counts["remote"],
                    "totalBytes": total_bytes,
                    "completedBytes": total_bytes,
                    "currentFile": "",
                    "currentFileBytes": 0,
                    "percent": 100,
                },
            }
            self._write_status(**result)
            self._record_sync_audit(reason=reason, actor=actor, result="success", counts=counts)
            log.info(
                "Image sync complete: %d remote, %d copied, %d renamed, %d removed, %d unchanged, %d deferred",
                counts["remote"],
                counts["copied"],
                counts["renamed"],
                counts["deleted"],
                counts["unchanged"],
                counts["deferred"],
            )
            return sync_status(self.config)
        except Exception as exc:
            log.exception("Image synchronization failed")
            self._write_status(
                state="error",
                reason=reason,
                lastStartedAt=started_at,
                lastCompletedAt=_timestamp(),
                message=str(exc),
                counts=counts,
            )
            self._record_sync_audit(reason=reason, actor=actor, result="failure", counts=counts, error=str(exc))
            raise


class RemoteImageSyncService:
    """Long-running scheduler that also consumes manual sync requests."""

    def __init__(self, config: Config):
        self.config = config
        self.syncer = RemoteImageSync(config)

    def run_forever(self) -> None:
        next_scheduled = 0.0  # Populate an empty local cache when the service starts.
        while True:
            request = _read_json(_state_path(self.config, REQUEST_FILENAME))
            manual = bool(request.get("requestId"))
            now = time.monotonic()
            if manual or now >= next_scheduled:
                reason = "manual" if manual else "scheduled"
                request_id = request.get("requestId")
                try:
                    self.syncer.sync_once(reason=reason, actor=request.get("requestedBy", "") if manual else "system")
                except Exception as exc:
                    log.error("%s image sync failed: %s", reason, exc)
                finally:
                    if manual and _read_json(_state_path(self.config, REQUEST_FILENAME)).get("requestId") == request_id:
                        _state_path(self.config, REQUEST_FILENAME).unlink(missing_ok=True)
                next_scheduled = time.monotonic() + self.config.sync_interval_seconds
            time.sleep(self.config.sync_poll_seconds)
