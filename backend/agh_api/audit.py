import hashlib
import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path

from flask import g, has_request_context, request


def audit_timestamp():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def request_hash(value: str) -> str:
    if not value:
        return ""
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def client_ip():
    if not has_request_context():
        return ""
    forwarded = request.headers.get("X-Forwarded-For", "")
    if forwarded:
        parts = [part.strip() for part in forwarded.split(",") if part.strip()]
        if parts:
            return parts[-1]
    return request.remote_addr or ""


class AuditLog:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def record(
        self,
        *,
        action,
        actor="",
        result="success",
        case_id=None,
        filename=None,
        annotation_revision_before=None,
        annotation_revision_after=None,
        details=None,
    ):
        event = {
            "event_id": uuid.uuid4().hex,
            "timestamp": audit_timestamp(),
            "actor": actor or (getattr(g, "remote_user", "") if has_request_context() else "") or "",
            "action": action,
            "case_id": case_id,
            "filename": filename,
            "annotation_revision_before": annotation_revision_before,
            "annotation_revision_after": annotation_revision_after,
            "ip_hash": request_hash(client_ip()),
            "user_agent_hash": request_hash(request.headers.get("User-Agent", "") if has_request_context() else ""),
            "result": result,
        }
        if details:
            event["details"] = details

        fd = os.open(str(self.path), os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)
        try:
            with os.fdopen(fd, "a", encoding="utf-8", newline="\n") as handle:
                handle.write(json.dumps(event, sort_keys=True) + "\n")
                handle.flush()
                os.fsync(handle.fileno())
        finally:
            fd = None

    def recent(self, limit=200):
        try:
            limit = max(1, min(1000, int(limit)))
        except (TypeError, ValueError):
            limit = 200
        if not self.path.exists():
            return []
        try:
            lines = self.path.read_text(encoding="utf-8").splitlines()
        except OSError:
            return []
        events = []
        for line in reversed(lines):
            if len(events) >= limit:
                break
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if isinstance(event, dict):
                events.append(event)
        return events


def install_audit(app, cfg):
    app.extensions["agh_audit"] = AuditLog(cfg.audit_log_file)
    return app


def audit_event(**kwargs):
    try:
        from flask import current_app
        audit = current_app.extensions.get("agh_audit")
    except RuntimeError:
        audit = None
    if audit:
        audit.record(**kwargs)
