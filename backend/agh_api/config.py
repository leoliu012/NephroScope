import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


@dataclass(frozen=True)
class Config:
    data_root: Path
    ann_root: Path
    # --- Authentication / sessions -----------------------------------------
    users_file: Path = Path("/var/lib/agh-viewer/users.json")
    session_root: Path = Path("/var/lib/agh-viewer/sessions")
    login_state_file: Path = Path("/var/lib/agh-viewer/login_attempts.json")
    audit_log_file: Path = Path("/var/lib/agh-viewer/audit_events.jsonl")
    collaboration_state_file: Path = Path("/var/lib/agh-viewer/collaboration_state.json")
    auth_required: bool = True
    session_ttl_seconds: int = 12 * 60 * 60
    session_idle_seconds: int = 8 * 60 * 60
    cookie_secure: str = "auto"          # "auto" | "true" | "false"
    allow_basic_auth: bool = False       # opt-in Basic auth for automation
    login_max_attempts: int = 8
    login_window_seconds: int = 15 * 60
    login_lockout_seconds: int = 15 * 60
    dev_user: str = ""                   # identity used when auth is disabled
    # --- Serving / caching --------------------------------------------------
    host: str = "127.0.0.1"
    port: int = 5055
    raw_channel_cache_bytes: int = 512 * 1024 * 1024
    versioned_response_cache_seconds: int = 7 * 24 * 60 * 60
    # --- Expansion-factor calibration uploads -------------------------------
    ef_upload_root: Path = Path("/var/lib/agh-viewer/ef_uploads")
    ef_upload_max_bytes: int = 2048 * 1024 * 1024
    ef_upload_ttl_seconds: int = 24 * 60 * 60
    # --- Remote image-cache synchronization --------------------------------
    # ``data_root`` always remains the path used by the API.  When configured,
    # ``remote_data_root`` is a mounted source copied into that local cache by
    # the separate image-sync service.
    remote_data_root: Optional[Path] = None
    sync_state_dir: Path = Path("/var/lib/agh-viewer/localdata-sync")
    sync_interval_seconds: int = 24 * 60 * 60
    sync_poll_seconds: int = 15
    sync_fingerprint_bytes: int = 4 * 1024 * 1024

    @classmethod
    def from_env(cls):
        state_dir = _env_path("AGH_STATE_DIR", str(Path.home() / ".agh-viewer"))
        return cls(
            data_root=_env_path("AGH_DATA_ROOT", "/data/AGH_APP"),
            ann_root=_env_path("AGH_ANN_ROOT", "/data/agh_annotations"),
            users_file=_env_path("AGH_USERS_FILE", str(state_dir / "users.json")),
            session_root=_env_path("AGH_SESSION_DIR", str(state_dir / "sessions")),
            login_state_file=_env_path("AGH_LOGIN_STATE_FILE", str(state_dir / "login_attempts.json")),
            audit_log_file=_env_path("AGH_AUDIT_LOG_FILE", str(state_dir / "audit_events.jsonl")),
            collaboration_state_file=_env_path("AGH_COLLABORATION_STATE_FILE", str(state_dir / "collaboration_state.json")),
            auth_required=_env_auth_required(),
            session_ttl_seconds=_env_int("AGH_SESSION_TTL_SECONDS", 12 * 60 * 60),
            session_idle_seconds=_env_int("AGH_SESSION_IDLE_SECONDS", 8 * 60 * 60),
            cookie_secure=os.environ.get("AGH_COOKIE_SECURE", "auto"),
            allow_basic_auth=_env_bool("AGH_ALLOW_BASIC_AUTH", False),
            login_max_attempts=_env_int("AGH_LOGIN_MAX_ATTEMPTS", 8),
            login_window_seconds=_env_int("AGH_LOGIN_WINDOW_SECONDS", 15 * 60),
            login_lockout_seconds=_env_int("AGH_LOGIN_LOCKOUT_SECONDS", 15 * 60),
            dev_user=os.environ.get("AGH_DEV_USER", ""),
            host=os.environ.get("AGH_HOST", "127.0.0.1"),
            port=int(os.environ.get("AGH_PORT", "5055")),
            raw_channel_cache_bytes=_env_mb("AGH_RAW_CHANNEL_CACHE_MB", 512),
            versioned_response_cache_seconds=_env_int("AGH_VERSIONED_RESPONSE_CACHE_SECONDS", 7 * 24 * 60 * 60),
            ef_upload_root=_env_path("AGH_EF_UPLOAD_DIR", str(state_dir / "ef_uploads")),
            ef_upload_max_bytes=_env_mb("AGH_EF_UPLOAD_MAX_MB", 2048),
            ef_upload_ttl_seconds=_env_int("AGH_EF_UPLOAD_TTL_SECONDS", 24 * 60 * 60),
            remote_data_root=_env_optional_path("AGH_REMOTE_DATA_ROOT", ""),
            sync_state_dir=_env_path("AGH_SYNC_STATE_DIR", str(state_dir / "localdata-sync")),
            sync_interval_seconds=max(60, _env_int("AGH_SYNC_INTERVAL_SECONDS", 24 * 60 * 60)),
            sync_poll_seconds=max(1, _env_int("AGH_SYNC_POLL_SECONDS", 15)),
            sync_fingerprint_bytes=max(1024, _env_int("AGH_SYNC_FINGERPRINT_MB", 4) * 1024 * 1024),
        )

    @classmethod
    def local_dev(cls, backend_dir: Path):
        base = Path(backend_dir) / ".local_data"
        state_dir = _env_path("AGH_STATE_DIR", str(base / "state"))
        return cls(
            data_root=base / "AGH_APP",
            ann_root=base / "agh_annotations",
            users_file=_env_path("AGH_USERS_FILE", str(state_dir / "users.json")),
            session_root=_env_path("AGH_SESSION_DIR", str(state_dir / "sessions")),
            login_state_file=_env_path("AGH_LOGIN_STATE_FILE", str(state_dir / "login_attempts.json")),
            audit_log_file=_env_path("AGH_AUDIT_LOG_FILE", str(state_dir / "audit_events.jsonl")),
            collaboration_state_file=_env_path("AGH_COLLABORATION_STATE_FILE", str(state_dir / "collaboration_state.json")),
            auth_required=_env_auth_required(),
            session_ttl_seconds=_env_int("AGH_SESSION_TTL_SECONDS", 12 * 60 * 60),
            session_idle_seconds=_env_int("AGH_SESSION_IDLE_SECONDS", 8 * 60 * 60),
            cookie_secure=os.environ.get("AGH_COOKIE_SECURE", "auto"),
            allow_basic_auth=_env_bool("AGH_ALLOW_BASIC_AUTH", False),
            login_max_attempts=_env_int("AGH_LOGIN_MAX_ATTEMPTS", 8),
            login_window_seconds=_env_int("AGH_LOGIN_WINDOW_SECONDS", 15 * 60),
            login_lockout_seconds=_env_int("AGH_LOGIN_LOCKOUT_SECONDS", 15 * 60),
            dev_user=os.environ.get("AGH_DEV_USER", ""),
            host=os.environ.get("AGH_HOST", "127.0.0.1"),
            port=int(os.environ.get("AGH_PORT", "5055")),
            raw_channel_cache_bytes=_env_mb("AGH_RAW_CHANNEL_CACHE_MB", 512),
            versioned_response_cache_seconds=_env_int("AGH_VERSIONED_RESPONSE_CACHE_SECONDS", 7 * 24 * 60 * 60),
            ef_upload_root=_env_path("AGH_EF_UPLOAD_DIR", str(base / "ef_uploads")),
            ef_upload_max_bytes=_env_mb("AGH_EF_UPLOAD_MAX_MB", 2048),
            ef_upload_ttl_seconds=_env_int("AGH_EF_UPLOAD_TTL_SECONDS", 24 * 60 * 60),
            remote_data_root=_env_optional_path("AGH_REMOTE_DATA_ROOT", ""),
            # Keep the development index beside, rather than inside, the
            # image cache so it can never appear as a case in the viewer.
            sync_state_dir=_env_path("AGH_SYNC_STATE_DIR", str(Path(backend_dir) / ".localdata-sync")),
            sync_interval_seconds=max(60, _env_int("AGH_SYNC_INTERVAL_SECONDS", 24 * 60 * 60)),
            sync_poll_seconds=max(1, _env_int("AGH_SYNC_POLL_SECONDS", 15)),
            sync_fingerprint_bytes=max(1024, _env_int("AGH_SYNC_FINGERPRINT_MB", 4) * 1024 * 1024),
        )

    def ensure_directories(self):
        for label, path in (
            ("image data", self.data_root),
            ("annotation", self.ann_root),
        ):
            try:
                path.mkdir(parents=True, exist_ok=True)
            except OSError as exc:
                raise RuntimeError(
                    f"Cannot create {label} directory at {path}. "
                    "For local development, unset AGH_DATA_ROOT/AGH_ANN_ROOT "
                    "or run with AGH_LOCAL_DEV=1. To use a real local dataset, set "
                    "AGH_DATA_ROOT and AGH_ANN_ROOT to writable paths. "
                    "For production, create the /data directories with the service user's permissions."
                ) from exc
        # Auth state lives outside the image/annotation trees and is created
        # with restrictive permissions; failures here should not be fatal for
        # read-only image serving, but are logged by the auth layer on use.
        for path, mode in (
            (self.session_root, 0o700),
            (Path(self.users_file).parent, 0o700),
            (Path(self.login_state_file).parent, 0o700),
            (Path(self.audit_log_file).parent, 0o700),
            (Path(self.collaboration_state_file).parent, 0o700),
            (self.ef_upload_root, 0o700),
        ):
            try:
                path.mkdir(parents=True, exist_ok=True)
                os.chmod(path, mode)
            except OSError:
                pass
        # This directory belongs to the separate sync worker.  Do not create
        # it for installations that have no remote source configured.
        if self.remote_data_root:
            try:
                self.sync_state_dir.mkdir(parents=True, exist_ok=True)
                os.chmod(self.sync_state_dir, 0o700)
            except OSError:
                pass


def _env_path(name, default):
    return Path(os.environ.get(name, default)).expanduser()


def _env_optional_path(name, default):
    value = os.environ.get(name, default)
    return Path(value).expanduser() if value else None


def _env_int(name, default):
    try:
        value = int(os.environ.get(name, str(default)))
    except ValueError:
        return default
    return max(0, value)


def _env_bool(name, default):
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_auth_required():
    required = _env_bool("AGH_AUTH_REQUIRED", True)
    if required:
        return True
    acknowledgement = os.environ.get("AGH_ALLOW_INSECURE_AUTH_BYPASS", "")
    return acknowledgement != "I_UNDERSTAND_THIS_EXPOSES_DATA"


def _env_mb(name, default):
    return _env_int(name, default) * 1024 * 1024
