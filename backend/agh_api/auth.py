"""
Authentication and session management for the AGH Viewer API.

Design
------
* Accounts live in a JSON user store (``AGH_USERS_FILE``). Passwords are
  hashed with PBKDF2-HMAC-SHA256 (salted, per-user) via Werkzeug. The method
  is pinned so behaviour is deterministic and portable across Werkzeug
  versions and platforms (no C-extension or OpenSSL scrypt dependency).
* A successful login mints a random 256-bit opaque session token that is
  stored server-side (only its SHA-256 is persisted) and delivered to the
  browser in an ``HttpOnly``, ``SameSite=Strict`` cookie. The password is
  therefore sent exactly once, never stored in the browser, and sessions can
  be revoked (real logout) and expire (absolute TTL + idle timeout).
* CSRF is handled with the synchronizer-token pattern: each session carries a
  random CSRF token returned to the SPA in JSON. State-changing requests must
  echo it in the ``X-AGH-CSRF`` header. Because the session cookie is
  ``SameSite=Strict`` and the token lives only in the SPA's memory (not a
  readable cookie), cross-site requests cannot forge it.
* Login attempts are rate-limited and locked out per client IP and per
  username using a small file-backed store, so limits hold across the
  multiple Gunicorn workers this service runs.

Nothing here requires a dependency beyond Flask/Werkzeug, which the backend
already vendors.
"""
import hashlib
import hmac
import json
import logging
import os
import secrets
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Optional

from flask import g, jsonify, request
from werkzeug.security import check_password_hash, generate_password_hash

from .audit import audit_event
from .file_lock import file_lock

log = logging.getLogger(__name__)

# --- Constants ---------------------------------------------------------------

PBKDF2_METHOD = "pbkdf2:sha256"
USER_STORE_VERSION = 1

SESSION_COOKIE = "agh_session"
CSRF_HEADER = "X-AGH-CSRF"

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
ROLES = {"admin", "annotator", "viewer"}
DEFAULT_ROLE = "annotator"
ROLE_PERMISSIONS = {
    "admin": {"view", "annotate", "manage_users"},
    "annotator": {"view", "annotate"},
    "viewer": {"view"},
}
LEGACY_ROLE_MAP = {
    "reviewer": "annotator",
    "pathologist": "annotator",
    "upload_agent": "viewer",
}

# Minimum password length enforced when creating or changing an account.
# Defaults to 4; override with AGH_MIN_PASSWORD_LENGTH (must be >= 1). Login
# never checks length — this only gates account creation / password changes.
try:
    MIN_PASSWORD_LENGTH = max(1, int(os.environ.get("AGH_MIN_PASSWORD_LENGTH", "4")))
except ValueError:
    MIN_PASSWORD_LENGTH = 4

# Endpoints reachable without an established session. Everything else under
# the API requires a valid session (or Basic auth when explicitly enabled).
PUBLIC_PATHS = frozenset({
    "/agh/api/health",
    "/agh/api/v1/health",
    "/agh/api/session",
    "/agh/api/login",
    "/agh/api/logout",
})

# A stable, valid PBKDF2 hash of an unguessable value. When a login names a
# user that does not exist we still run a verification against this so the
# response time does not reveal whether the account exists.
_DUMMY_HASH = generate_password_hash(secrets.token_urlsafe(32), method=PBKDF2_METHOD)


def _now() -> float:
    return time.time()


def _iso(ts: Optional[float] = None) -> str:
    moment = datetime.fromtimestamp(ts if ts is not None else _now(), tz=timezone.utc)
    return moment.isoformat().replace("+00:00", "Z")


def _atomic_write(path: Path, text: str, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-", suffix=".json")
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.chmod(tmp, mode)
        except OSError:
            pass
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink(missing_ok=True)


def _harden_dir(path: Path, mode: int = 0o700) -> None:
    path.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(path, mode)
    except OSError:
        pass


# --- User store --------------------------------------------------------------

class UserError(Exception):
    """Raised for account-management problems surfaced to a CLI operator."""


class UserStore:
    """JSON-file-backed account store with salted PBKDF2 password hashes."""

    def __init__(self, path):
        self.path = Path(path)
        self._lock_path = self.path.with_suffix(self.path.suffix + ".lock")

    # -- reading -------------------------------------------------------------
    def _read(self) -> dict:
        if not self.path.exists():
            return {"version": USER_STORE_VERSION, "users": {}}
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            log.error("User store is unreadable or corrupt: %s (%s)", self.path, exc)
            raise UserError(f"User store is unreadable: {self.path}") from exc
        if not isinstance(data, dict) or not isinstance(data.get("users"), dict):
            raise UserError(f"User store has an unexpected shape: {self.path}")
        return data

    def _write(self, data: dict) -> None:
        _atomic_write(self.path, json.dumps(data, indent=2, sort_keys=True) + "\n")

    @staticmethod
    def normalize_username(username: str) -> str:
        return (username or "").strip()

    @staticmethod
    def validate_username(username: str) -> str:
        name = UserStore.normalize_username(username)
        if not name:
            raise UserError("Username must not be empty")
        if len(name) > 128:
            raise UserError("Username must be at most 128 characters")
        if any(ch.isspace() for ch in name) or ":" in name or "/" in name or "\\" in name:
            raise UserError("Username must not contain whitespace, ':', '/', or '\\'")
        return name

    def exists(self, username: str) -> bool:
        name = self.normalize_username(username)
        return name in self._read()["users"]

    def list_users(self):
        data = self._read()
        out = []
        for name, record in sorted(data["users"].items()):
            first_name, last_name = _profile_names(record)
            out.append({
                "username": name,
                "firstName": first_name,
                "lastName": last_name,
                "displayName": _display_name(first_name, last_name, name),
                "disabled": bool(record.get("disabled", False)),
                "role": _normalize_role(record.get("role")),
                "createdAt": record.get("createdAt", ""),
                "updatedAt": record.get("updatedAt", ""),
            })
        return out

    def profile(self, username: str) -> dict:
        name = self.normalize_username(username)
        record = self._read()["users"].get(name)
        if not isinstance(record, dict):
            raise UserError(f"No such user: {name}")
        first_name, last_name = _profile_names(record)
        return {
            "username": name,
            "firstName": first_name,
            "lastName": last_name,
            "displayName": _display_name(first_name, last_name, name),
            "role": _normalize_role(record.get("role")),
        }

    def role(self, username: str) -> str:
        name = self.normalize_username(username)
        record = self._read()["users"].get(name)
        return _normalize_role(record.get("role") if isinstance(record, dict) else None)

    # -- verification --------------------------------------------------------
    def verify(self, username: str, password: str) -> Optional[str]:
        """Return the canonical username on success, else ``None``.

        Always performs a hash comparison (against a dummy hash for unknown or
        disabled accounts) so timing does not leak account existence.
        """
        name = self.normalize_username(username)
        try:
            users = self._read()["users"]
        except UserError:
            check_password_hash(_DUMMY_HASH, password or "")
            return None
        record = users.get(name)
        stored_hash = record.get("passwordHash") if isinstance(record, dict) else None
        disabled = bool(record.get("disabled", False)) if isinstance(record, dict) else False
        ok = check_password_hash(stored_hash or _DUMMY_HASH, password or "")
        if record is None or disabled or not stored_hash:
            return None
        return name if ok else None

    # -- mutation (used by manage_users.py) ----------------------------------
    def add(self, username: str, password: str, *, allow_update: bool = False, first_name: str = "", last_name: str = "", require_profile: bool = False) -> str:
        name = self.validate_username(username)
        _require_password(password)
        first_name, last_name = (
            _require_profile_names(first_name, last_name)
            if require_profile else _normalize_profile_names(first_name, last_name)
        )
        with file_lock(self._lock_path):
            data = self._read()
            if name in data["users"] and not allow_update:
                raise UserError(f"User already exists: {name}")
            created = data["users"].get(name, {}).get("createdAt") or _iso()
            previous = data["users"].get(name, {})
            data["users"][name] = {
                "passwordHash": generate_password_hash(password, method=PBKDF2_METHOD),
                "disabled": bool(previous.get("disabled", False)),
                "role": _normalize_role(previous.get("role")),
                "firstName": first_name or _profile_names(previous)[0],
                "lastName": last_name or _profile_names(previous)[1],
                "createdAt": created,
                "updatedAt": _iso(),
            }
            self._write(data)
        return name

    def set_password(self, username: str, password: str) -> str:
        name = self.normalize_username(username)
        _require_password(password)
        with file_lock(self._lock_path):
            data = self._read()
            if name not in data["users"]:
                raise UserError(f"No such user: {name}")
            data["users"][name]["passwordHash"] = generate_password_hash(password, method=PBKDF2_METHOD)
            data["users"][name]["updatedAt"] = _iso()
            self._write(data)
        return name

    def set_disabled(self, username: str, disabled: bool) -> str:
        name = self.normalize_username(username)
        with file_lock(self._lock_path):
            data = self._read()
            if name not in data["users"]:
                raise UserError(f"No such user: {name}")
            data["users"][name]["disabled"] = bool(disabled)
            data["users"][name]["updatedAt"] = _iso()
            self._write(data)
        return name

    def set_role(self, username: str, role: str) -> str:
        name = self.normalize_username(username)
        normalized_role = str(role or "").strip().lower()
        if normalized_role not in ROLES:
            raise UserError(f"Role must be one of: {', '.join(sorted(ROLES))}")
        with file_lock(self._lock_path):
            data = self._read()
            if name not in data["users"]:
                raise UserError(f"No such user: {name}")
            data["users"][name]["role"] = normalized_role
            data["users"][name]["updatedAt"] = _iso()
            self._write(data)
        return name

    def set_profile(self, username: str, first_name: str, last_name: str) -> str:
        name = self.normalize_username(username)
        first_name, last_name = _require_profile_names(first_name, last_name)
        with file_lock(self._lock_path):
            data = self._read()
            if name not in data["users"]:
                raise UserError(f"No such user: {name}")
            data["users"][name]["firstName"] = first_name
            data["users"][name]["lastName"] = last_name
            data["users"][name]["updatedAt"] = _iso()
            self._write(data)
        return name

    def remove(self, username: str) -> str:
        name = self.normalize_username(username)
        with file_lock(self._lock_path):
            data = self._read()
            if name not in data["users"]:
                raise UserError(f"No such user: {name}")
            del data["users"][name]
            self._write(data)
        return name


def _require_password(password: str) -> None:
    if password is None or len(password) < MIN_PASSWORD_LENGTH:
        unit = "character" if MIN_PASSWORD_LENGTH == 1 else "characters"
        raise UserError(f"Password must be at least {MIN_PASSWORD_LENGTH} {unit}")
    if len(password) > 1024:
        raise UserError("Password must be at most 1024 characters")


def _clean_name_part(value: str) -> str:
    name = str(value or "").strip()
    if len(name) > 80:
        raise UserError("First and last names must be at most 80 characters")
    if any(ch in name for ch in "\r\n\t"):
        raise UserError("First and last names must not contain control characters")
    return " ".join(name.split())


def _normalize_profile_names(first_name: str, last_name: str):
    return _clean_name_part(first_name), _clean_name_part(last_name)


def _require_profile_names(first_name: str, last_name: str):
    first_name, last_name = _normalize_profile_names(first_name, last_name)
    if not first_name or not last_name:
        raise UserError("First name and last name are required")
    return first_name, last_name


def _profile_names(record: dict):
    if not isinstance(record, dict):
        return "", ""
    return _normalize_profile_names(record.get("firstName", ""), record.get("lastName", ""))


def _display_name(first_name: str, last_name: str, fallback: str = "") -> str:
    return " ".join(part for part in [first_name, last_name] if part).strip() or fallback


def _normalize_role(role) -> str:
    value = str(role or DEFAULT_ROLE).strip().lower()
    value = LEGACY_ROLE_MAP.get(value, value)
    return value if value in ROLES else DEFAULT_ROLE


def role_permissions(role: str):
    return ROLE_PERMISSIONS.get(_normalize_role(role), set())


def has_permission(permission: str) -> bool:
    return permission in role_permissions(getattr(g, "remote_role", DEFAULT_ROLE))


# --- Session store -----------------------------------------------------------

class SessionStore:
    """Server-side opaque session tokens, one small JSON file per session.

    Only the SHA-256 of the token is used as the on-disk key, so reading the
    session directory never yields a usable token.
    """

    def __init__(self, root, ttl_seconds: int, idle_seconds: int):
        self.root = Path(root)
        self.ttl_seconds = max(0, int(ttl_seconds))
        self.idle_seconds = max(0, int(idle_seconds))
        _harden_dir(self.root)

    @staticmethod
    def _sid(token: str) -> str:
        return hashlib.sha256(token.encode("utf-8")).hexdigest()

    def _path(self, token: str) -> Path:
        return self.root / f"{self._sid(token)}.json"

    def create(self, username: str, role: str = DEFAULT_ROLE):
        token = secrets.token_urlsafe(32)
        csrf = secrets.token_urlsafe(32)
        now = _now()
        record = {
            "username": username,
            "role": _normalize_role(role),
            "csrf": csrf,
            "createdAt": _iso(now),
            "createdTs": now,
            "expiresTs": (now + self.ttl_seconds) if self.ttl_seconds else 0,
            "lastSeenTs": now,
        }
        _atomic_write(self._path(token), json.dumps(record) + "\n")
        return token, csrf

    def load(self, token: str) -> Optional[dict]:
        if not token:
            return None
        path = self._path(token)
        if not path.exists():
            return None
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            path.unlink(missing_ok=True)
            return None
        now = _now()
        expires = record.get("expiresTs") or 0
        last_seen = record.get("lastSeenTs") or 0
        if expires and now > expires:
            path.unlink(missing_ok=True)
            return None
        if self.idle_seconds and last_seen and (now - last_seen) > self.idle_seconds:
            path.unlink(missing_ok=True)
            return None
        # Throttle last-seen writes so ordinary browsing does not hammer disk.
        if now - last_seen > 60:
            record["lastSeenTs"] = now
            try:
                _atomic_write(path, json.dumps(record) + "\n")
            except OSError:
                pass
        return record

    def destroy(self, token: str) -> None:
        if not token:
            return
        self._path(token).unlink(missing_ok=True)

    def destroy_user(self, username: str) -> int:
        target = UserStore.normalize_username(username)
        if not target:
            return 0
        removed = 0
        try:
            entries = list(self.root.glob("*.json"))
        except OSError:
            return 0
        for path in entries:
            try:
                record = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                path.unlink(missing_ok=True)
                removed += 1
                continue
            if UserStore.normalize_username(record.get("username", "")) == target:
                path.unlink(missing_ok=True)
                removed += 1
        return removed

    def purge_expired(self) -> int:
        removed = 0
        now = _now()
        try:
            entries = list(self.root.glob("*.json"))
        except OSError:
            return 0
        for path in entries:
            try:
                record = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                path.unlink(missing_ok=True)
                removed += 1
                continue
            expires = record.get("expiresTs") or 0
            last_seen = record.get("lastSeenTs") or 0
            expired = expires and now > expires
            idle = self.idle_seconds and last_seen and (now - last_seen) > self.idle_seconds
            if expired or idle:
                path.unlink(missing_ok=True)
                removed += 1
        return removed


# --- Login rate limiting -----------------------------------------------------

class LoginRateLimiter:
    """File-backed sliding-window limiter with lockout, keyed by IP and user.

    A single JSON file guarded by a file lock keeps the counters consistent
    across Gunicorn workers. Logins are infrequent, so the lock is cheap.
    """

    def __init__(self, path, max_attempts: int, window_seconds: int, lockout_seconds: int):
        self.path = Path(path)
        self.lock_path = self.path.with_suffix(self.path.suffix + ".lock")
        self.max_attempts = max(1, int(max_attempts))
        self.window_seconds = max(1, int(window_seconds))
        self.lockout_seconds = max(1, int(lockout_seconds))

    def _read(self) -> dict:
        if not self.path.exists():
            return {}
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def _prune(self, data: dict, now: float) -> dict:
        keep = {}
        for key, entry in data.items():
            locked_until = entry.get("lockedUntil", 0)
            first = entry.get("first", 0)
            if locked_until and locked_until > now:
                keep[key] = entry
            elif first and (now - first) <= self.window_seconds:
                keep[key] = entry
        return keep

    def retry_after(self, keys: Iterable[str]) -> int:
        """Return seconds remaining if any key is locked, else 0. Read-only."""
        now = _now()
        data = self._read()
        remaining = 0
        for key in keys:
            entry = data.get(key)
            if entry:
                locked_until = entry.get("lockedUntil", 0)
                if locked_until and locked_until > now:
                    remaining = max(remaining, int(locked_until - now) + 1)
        return remaining

    def record_failure(self, keys: Iterable[str]) -> None:
        now = _now()
        with file_lock(self.lock_path):
            data = self._prune(self._read(), now)
            for key in keys:
                entry = data.get(key) or {"first": now, "fails": 0, "lockedUntil": 0}
                if not entry.get("first") or (now - entry["first"]) > self.window_seconds:
                    entry = {"first": now, "fails": 0, "lockedUntil": 0}
                entry["fails"] = entry.get("fails", 0) + 1
                if entry["fails"] >= self.max_attempts:
                    entry["lockedUntil"] = now + self.lockout_seconds
                data[key] = entry
            _atomic_write(self.path, json.dumps(data) + "\n")

    def record_success(self, keys: Iterable[str]) -> None:
        now = _now()
        with file_lock(self.lock_path):
            data = self._prune(self._read(), now)
            for key in keys:
                data.pop(key, None)
            _atomic_write(self.path, json.dumps(data) + "\n")


# --- Request-time helpers ----------------------------------------------------

def _client_ip() -> str:
    """Best-effort client IP.

    Apache (mod_proxy_http) appends the immediate client's address as the last
    element of ``X-Forwarded-For``. We trust exactly one proxy hop, so the last
    value is the real client; anything a client injects earlier is ignored for
    rate-limiting purposes.
    """
    forwarded = request.headers.get("X-Forwarded-For", "")
    if forwarded:
        parts = [p.strip() for p in forwarded.split(",") if p.strip()]
        if parts:
            return parts[-1]
    return request.remote_addr or "unknown"


def _cookie_secure(cfg) -> bool:
    setting = (getattr(cfg, "cookie_secure", "auto") or "auto").lower()
    if setting in {"true", "1", "yes", "on"}:
        return True
    if setting in {"false", "0", "no", "off"}:
        return False
    if request.is_secure:
        return True
    proto = request.headers.get("X-Forwarded-Proto", "").split(",")[0].strip().lower()
    return proto == "https"


def _set_session_cookie(response, token: str, cfg) -> None:
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=cfg.session_ttl_seconds or None,
        httponly=True,
        secure=_cookie_secure(cfg),
        samesite="Strict",
        path="/agh",
    )


def _clear_session_cookie(response, cfg) -> None:
    response.set_cookie(
        SESSION_COOKIE,
        "",
        max_age=0,
        expires=0,
        httponly=True,
        secure=_cookie_secure(cfg),
        samesite="Strict",
        path="/agh",
    )


def _no_store(response):
    response.headers["Cache-Control"] = "no-store"
    return response


def _basic_credentials():
    header = request.headers.get("Authorization", "")
    scheme, _, encoded = header.partition(" ")
    if scheme.lower() != "basic" or not encoded:
        return "", None
    import base64
    try:
        decoded = base64.b64decode(encoded, validate=True).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return "", None
    username, separator, password = decoded.partition(":")
    if not separator:
        return "", None
    return username, password


# --- Wiring ------------------------------------------------------------------

def install_auth(app, cfg):
    """Attach account/session enforcement and the auth endpoints to ``app``."""
    users = UserStore(cfg.users_file)
    sessions = SessionStore(cfg.session_root, cfg.session_ttl_seconds, cfg.session_idle_seconds)
    limiter = LoginRateLimiter(
        cfg.login_state_file,
        cfg.login_max_attempts,
        cfg.login_window_seconds,
        cfg.login_lockout_seconds,
    )

    app.extensions["agh_auth"] = {
        "users": users,
        "sessions": sessions,
        "limiter": limiter,
    }

    def resolve_session():
        """Return (username, session_record) for a valid cookie, else (None, None)."""
        token = request.cookies.get(SESSION_COOKIE)
        record = sessions.load(token) if token else None
        if record and record.get("username"):
            if not record.get("role"):
                record["role"] = users.role(record["username"])
            return record["username"], record
        return None, None

    @app.before_request
    def enforce_authentication():
        g.remote_user = ""
        g.remote_role = DEFAULT_ROLE
        g.auth_session = None

        if not cfg.auth_required:
            g.remote_user = cfg.dev_user
            g.remote_role = "admin"
            return None

        # Resolve any existing session up front so /session can report it even
        # on public paths.
        username, record = resolve_session()
        if username:
            g.remote_user = username
            g.remote_role = _normalize_role(record.get("role"))
            g.auth_session = record

        if request.path in PUBLIC_PATHS:
            return None

        if username:
            # CSRF check for state-changing requests from the browser.
            if request.method not in SAFE_METHODS:
                presented = request.headers.get(CSRF_HEADER, "")
                expected = record.get("csrf", "") if record else ""
                if not expected or not hmac.compare_digest(presented, expected):
                    return _no_store(jsonify({"error": "Invalid or missing CSRF token"})), 403
            return None

        # Optional Basic-auth path for non-browser automation. Off by default;
        # authenticates against the same user store (never a shared secret).
        if cfg.allow_basic_auth:
            basic_user, basic_password = _basic_credentials()
            if basic_user and basic_password is not None:
                canonical = users.verify(basic_user, basic_password)
                if canonical:
                    role = users.role(canonical)
                    g.remote_user = canonical
                    g.remote_role = role
                    return None

        # No browser challenge header: the SPA renders its own login screen and
        # must not be interrupted by the native credential popup.
        return _no_store(jsonify({"error": "Authentication required"})), 401

    @app.route("/agh/api/login", methods=["POST"])
    def login():
        if not cfg.auth_required:
            return _no_store(jsonify({"authenticated": True, "user": cfg.dev_user}))

        payload = request.get_json(silent=True) or {}
        username = payload.get("username", "")
        password = payload.get("password", "")
        if not isinstance(username, str) or not isinstance(password, str) or not username or not password:
            audit_event(actor=UserStore.normalize_username(username), action="LOGIN", result="failure")
            return _no_store(jsonify({"error": "Username and password are required"})), 400

        ip = _client_ip()
        keys = [f"ip:{ip}", f"user:{UserStore.normalize_username(username)}"]

        remaining = limiter.retry_after(keys)
        if remaining:
            response = _no_store(jsonify({
                "error": "Too many failed attempts. Try again later.",
                "retryAfter": remaining,
            }))
            response.headers["Retry-After"] = str(remaining)
            audit_event(actor=UserStore.normalize_username(username), action="LOGIN", result="failure")
            return response, 429

        canonical = users.verify(username, password)
        if not canonical:
            limiter.record_failure(keys)
            audit_event(actor=UserStore.normalize_username(username), action="LOGIN", result="failure")
            return _no_store(jsonify({"error": "Invalid username or password"})), 401
        role = users.role(canonical)
        profile = users.profile(canonical)

        limiter.record_success(keys)
        token, csrf = sessions.create(canonical, role)
        response = _no_store(jsonify({
            "authenticated": True,
            "user": canonical,
            "role": role,
            "firstName": profile.get("firstName", ""),
            "lastName": profile.get("lastName", ""),
            "displayName": profile.get("displayName", canonical),
            "csrfToken": csrf,
        }))
        _set_session_cookie(response, token, cfg)
        audit_event(actor=canonical, action="LOGIN", result="success")
        return response

    @app.route("/agh/api/logout", methods=["POST"])
    def logout():
        # Logout is idempotent and low-harm; it does not require a CSRF token so
        # a client can always end its own session even with stale state.
        token = request.cookies.get(SESSION_COOKIE)
        if token:
            sessions.destroy(token)
        response = _no_store(jsonify({"authenticated": False}))
        _clear_session_cookie(response, cfg)
        audit_event(action="LOGOUT", result="success")
        return response

    @app.route("/agh/api/session")
    def session():
        if not cfg.auth_required:
            return _no_store(jsonify({"authenticated": True, "user": cfg.dev_user, "role": "admin", "firstName": "", "lastName": "", "displayName": cfg.dev_user, "csrfToken": ""}))
        record = getattr(g, "auth_session", None)
        user = getattr(g, "remote_user", "") or ""
        if user and record:
            profile = users.profile(user)
            return _no_store(jsonify({
                "authenticated": True,
                "user": user,
                "role": getattr(g, "remote_role", DEFAULT_ROLE),
                "firstName": profile.get("firstName", ""),
                "lastName": profile.get("lastName", ""),
                "displayName": profile.get("displayName", user),
                "csrfToken": record.get("csrf", ""),
            }))
        return _no_store(jsonify({"authenticated": False, "user": "", "role": "", "firstName": "", "lastName": "", "displayName": "", "csrfToken": ""}))

    return app
