import gzip
import logging
from typing import Optional

from flask import Flask, g, jsonify, request, send_file
from werkzeug.exceptions import HTTPException

from .annotation_service import AnnotationService
from .analysis_routes import register_analysis_routes
from .analysis_store import AnalysisStore
from .audit import audit_event, install_audit
from .auth import ROLES, UserError, has_permission, install_auth
from .collaboration_service import CollaborationService, collaboration_actor
from .config import Config
from .ef_uploads import register_ef_routes
from .errors import APIError
from .image_sync import SyncConfigurationError, request_manual_sync, sync_status
from .path_guard import image_path, list_cases, list_image_files
from .tiff_service import RawChannelCache, get_metadata, render_preview_png, render_raw_image_png


log = logging.getLogger(__name__)
VERSION = "1.6.0"


def create_app(config: Optional[Config] = None):
    cfg = config or Config.from_env()
    cfg.ensure_directories()

    app = Flask(__name__)
    annotations = AnnotationService(cfg.ann_root)
    collaboration = CollaborationService(cfg.collaboration_state_file)
    raw_channel_cache = RawChannelCache(cfg.raw_channel_cache_bytes)
    analysis_store = AnalysisStore(cfg.analysis_db, cfg.analysis_lease_seconds)
    app.extensions["agh_analysis"] = {"store": analysis_store}

    @app.errorhandler(APIError)
    def handle_api_error(exc):
        return jsonify({"error": exc.message}), exc.status_code

    @app.errorhandler(HTTPException)
    def handle_http_error(exc):
        return jsonify({"error": exc.description}), exc.code

    @app.errorhandler(Exception)
    def handle_unexpected_error(exc):
        log.exception("Unhandled API error")
        return jsonify({"error": "Internal server error"}), 500

    install_audit(app, cfg)
    install_auth(app, cfg)

    @app.after_request
    def apply_security_headers(response):
        # Conservative headers appropriate for a JSON/image API served under
        # /agh/api. Static assets are handled by Apache; these guard the API
        # surface against MIME sniffing, framing, and referrer leakage.
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        return response

    def raw_octet_response(payload: bytes):
        accepts_gzip = "gzip" in (request.headers.get("Accept-Encoding") or "").lower()
        should_compress = accepts_gzip and len(payload) >= 64 * 1024
        response = app.response_class(
            gzip.compress(payload, compresslevel=1) if should_compress else payload,
            mimetype="application/octet-stream",
        )
        if should_compress:
            response.headers["Content-Encoding"] = "gzip"
            response.headers["Vary"] = "Accept-Encoding"
        return response

    def z_index_arg():
        try:
            value = int(request.args.get("z", "0"))
        except ValueError:
            value = 0
        return max(0, value)

    def require_permission(permission: str):
        if has_permission(permission):
            return None
        audit_event(action="ACCESS_DENIED", result="failure", details={"permission": permission})
        return jsonify({"error": "Forbidden"}), 403

    def auth_extension(name):
        return app.extensions["agh_auth"][name]

    def invalidate_user_sessions(username):
        return auth_extension("sessions").destroy_user(username)

    def admin_error(message, status=400):
        return jsonify({"error": message}), status

    def current_actor(payload=None):
        payload = payload or {}
        username = getattr(g, "remote_user", "") or ""
        display_name = username
        users = app.extensions.get("agh_auth", {}).get("users")
        if username and users:
            try:
                display_name = users.profile(username).get("displayName") or username
            except UserError:
                display_name = username
        return collaboration_actor(
            username=username,
            display_name=display_name,
            case_id=payload.get("caseId"),
            filename=payload.get("filename"),
            viewer_open=payload.get("viewerOpen"),
        )

    def client_id_from(payload):
        client_id = str((payload or {}).get("clientId") or request.headers.get("X-AGH-Client") or "").strip()
        return client_id[:120] or request.remote_addr or "anonymous"

    @app.route("/agh/api/health")
    @app.route("/agh/api/v1/health")
    def health():
        return jsonify({
            "ok": True,
            "service": "agh-viewer-api",
            "version": VERSION,
        })

    @app.route("/agh/api/cases")
    def cases():
        denied = require_permission("view")
        if denied:
            return denied
        return jsonify({"cases": list_cases(cfg.data_root)})

    @app.route("/agh/api/admin/users")
    def admin_users():
        denied = require_permission("manage_users")
        if denied:
            return denied
        return jsonify({
            "roles": sorted(ROLES),
            "users": auth_extension("users").list_users(),
        })

    @app.route("/agh/api/admin/users", methods=["POST"])
    def admin_add_user():
        denied = require_permission("manage_users")
        if denied:
            return denied
        payload = request.get_json(silent=True) or {}
        username = payload.get("username", "")
        password = payload.get("password", "")
        confirm_password = payload.get("confirmPassword", password)
        role = payload.get("role", "annotator")
        first_name = payload.get("firstName", "")
        last_name = payload.get("lastName", "")
        if password != confirm_password:
            return admin_error("New passwords do not match", 400)
        try:
            users = auth_extension("users")
            created = users.add(username, password, first_name=first_name, last_name=last_name, require_profile=True)
            users.set_role(created, role)
        except UserError as exc:
            audit_event(action="CREATE_ACCOUNT", result="failure", details={"username": username, "error": str(exc)})
            return admin_error(str(exc), 400)
        audit_event(action="CREATE_ACCOUNT", result="success", details={"username": created, "role": role, "displayName": users.profile(created).get("displayName")})
        return jsonify({"ok": True, "users": users.list_users()})

    @app.route("/agh/api/admin/users/<path:username>", methods=["PATCH"])
    def admin_update_user(username):
        denied = require_permission("manage_users")
        if denied:
            return denied
        payload = request.get_json(silent=True) or {}
        users = auth_extension("users")
        actor = getattr(g, "remote_user", "") or ""
        try:
            if "password" in payload and payload.get("password"):
                users.set_password(username, payload.get("password"))
                removed_sessions = invalidate_user_sessions(username)
                audit_event(action="RESET_PASSWORD", result="success", details={"username": username, "sessionsInvalidated": removed_sessions})
            if "role" in payload:
                if username == actor and payload.get("role") != "admin":
                    return admin_error("You cannot remove your own admin role", 400)
                users.set_role(username, payload.get("role"))
                audit_event(action="CHANGE_ROLE", result="success", details={"username": username, "role": payload.get("role")})
            if "firstName" in payload or "lastName" in payload:
                users.set_profile(username, payload.get("firstName", ""), payload.get("lastName", ""))
                audit_event(action="UPDATE_PROFILE", result="success", details={"username": username, "displayName": users.profile(username).get("displayName")})
            if "disabled" in payload:
                if username == actor and bool(payload.get("disabled")):
                    return admin_error("You cannot disable your own account", 400)
                users.set_disabled(username, bool(payload.get("disabled")))
                removed_sessions = invalidate_user_sessions(username)
                audit_event(action="SET_ACCOUNT_DISABLED", result="success", details={"username": username, "disabled": bool(payload.get("disabled")), "sessionsInvalidated": removed_sessions})
        except UserError as exc:
            audit_event(action="UPDATE_ACCOUNT", result="failure", details={"username": username, "error": str(exc)})
            return admin_error(str(exc), 400)
        return jsonify({"ok": True, "users": users.list_users()})

    @app.route("/agh/api/admin/users/<path:username>/password", methods=["POST"])
    def admin_reset_user_password(username):
        denied = require_permission("manage_users")
        if denied:
            return denied
        payload = request.get_json(silent=True) or {}
        password = payload.get("password", "")
        confirm_password = payload.get("confirmPassword", "")
        if password != confirm_password:
            return admin_error("New passwords do not match", 400)
        users = auth_extension("users")
        try:
            users.set_password(username, password)
        except UserError as exc:
            audit_event(action="RESET_PASSWORD", result="failure", details={"username": username, "error": str(exc)})
            return admin_error(str(exc), 400)
        removed_sessions = invalidate_user_sessions(username)
        audit_event(action="RESET_PASSWORD", result="success", details={"username": username, "sessionsInvalidated": removed_sessions})
        return jsonify({"ok": True, "users": users.list_users()})

    @app.route("/agh/api/admin/users/<path:username>", methods=["DELETE"])
    def admin_delete_user(username):
        denied = require_permission("manage_users")
        if denied:
            return denied
        if username == (getattr(g, "remote_user", "") or ""):
            return admin_error("You cannot delete your own account", 400)
        users = auth_extension("users")
        try:
            removed = users.remove(username)
        except UserError as exc:
            audit_event(action="DELETE_ACCOUNT", result="failure", details={"username": username, "error": str(exc)})
            return admin_error(str(exc), 400)
        audit_event(action="DELETE_ACCOUNT", result="success", details={"username": removed})
        return jsonify({"ok": True, "users": users.list_users()})

    @app.route("/agh/api/admin/audit-events")
    def admin_audit_events():
        denied = require_permission("manage_users")
        if denied:
            return denied
        audit = app.extensions.get("agh_audit")
        limit = request.args.get("limit", 200)
        return jsonify({"events": audit.recent(limit) if audit else []})

    @app.route("/agh/api/admin/image-sync")
    def admin_image_sync_status():
        denied = require_permission("manage_users")
        if denied:
            return denied
        return jsonify(sync_status(cfg))

    @app.route("/agh/api/admin/image-sync", methods=["POST"])
    def admin_request_image_sync():
        denied = require_permission("manage_users")
        if denied:
            return denied
        actor = getattr(g, "remote_user", "") or ""
        try:
            status = request_manual_sync(cfg, actor=actor)
        except SyncConfigurationError as exc:
            return admin_error(str(exc), 409)
        audit_event(action="IMAGE_SYNC_QUEUED", result="pending", details={"source": "remote-cache"})
        return jsonify(status), 202

    @app.route("/agh/api/account/password", methods=["POST"])
    def change_own_password():
        username = getattr(g, "remote_user", "") or ""
        if not username:
            return jsonify({"error": "Authentication required"}), 401
        payload = request.get_json(silent=True) or {}
        current_password = payload.get("currentPassword", "")
        new_password = payload.get("newPassword", "")
        confirm_password = payload.get("confirmPassword", "")
        if not isinstance(current_password, str) or not isinstance(new_password, str) or not isinstance(confirm_password, str):
            return admin_error("Password fields are required", 400)
        if new_password != confirm_password:
            return admin_error("New passwords do not match", 400)
        users = auth_extension("users")
        if not users.verify(username, current_password):
            audit_event(action="CHANGE_OWN_PASSWORD", result="failure", details={"username": username})
            return admin_error("Current password is incorrect", 403)
        try:
            users.set_password(username, new_password)
        except UserError as exc:
            return admin_error(str(exc), 400)
        removed_sessions = invalidate_user_sessions(username)
        audit_event(action="CHANGE_OWN_PASSWORD", result="success", details={"username": username, "sessionsInvalidated": removed_sessions})
        return jsonify({"ok": True})

    @app.route("/agh/api/account/profile", methods=["GET", "POST"])
    def account_profile():
        username = getattr(g, "remote_user", "") or ""
        if not username:
            return jsonify({"error": "Authentication required"}), 401
        users = auth_extension("users")
        if request.method == "GET":
            try:
                return jsonify(users.profile(username))
            except UserError as exc:
                return admin_error(str(exc), 400)
        payload = request.get_json(silent=True) or {}
        try:
            users.set_profile(username, payload.get("firstName", ""), payload.get("lastName", ""))
        except UserError as exc:
            audit_event(action="UPDATE_OWN_PROFILE", result="failure", details={"username": username, "error": str(exc)})
            return admin_error(str(exc), 400)
        profile = users.profile(username)
        audit_event(action="UPDATE_OWN_PROFILE", result="success", details={"username": username, "displayName": profile.get("displayName")})
        return jsonify({"ok": True, **profile})

    @app.route("/agh/api/cases/<path:case>/files")
    def files(case):
        denied = require_permission("view")
        if denied:
            return denied
        return jsonify({"files": list_image_files(cfg.data_root, case)})

    @app.route("/agh/api/cases/<path:case>/files/<path:filename>/meta")
    def image_meta(case, filename):
        denied = require_permission("view")
        if denied:
            return denied
        path = image_path(cfg.data_root, case, filename)
        audit_event(action="VIEW_IMAGE", case_id=case, filename=filename, result="success")
        return jsonify(get_metadata(path))

    @app.route("/agh/api/cases/<path:case>/files/<path:filename>/image")
    def get_image(case, filename):
        denied = require_permission("view")
        if denied:
            return denied
        path = image_path(cfg.data_root, case, filename)
        audit_event(action="VIEW_IMAGE", case_id=case, filename=filename, result="success")
        return send_file(render_raw_image_png(path), mimetype="image/png", max_age=0)

    @app.route("/agh/api/cases/<path:case>/files/<path:filename>/preview")
    def get_preview(case, filename):
        denied = require_permission("view")
        if denied:
            return denied
        path = image_path(cfg.data_root, case, filename)
        versioned = bool(request.args.get("v"))
        response = send_file(
            render_preview_png(path, request.args.get("max"), z_index_arg()),
            mimetype="image/png",
            max_age=cfg.versioned_response_cache_seconds if versioned else 0,
        )
        stat = path.stat()
        response.set_etag(f"preview-{stat.st_size}-{stat.st_mtime_ns}-{request.args.get('max') or ''}-{z_index_arg()}")
        response.headers["Cache-Control"] = (
            f"private, max-age={cfg.versioned_response_cache_seconds}, immutable"
            if versioned else "private, no-cache"
        )
        return response.make_conditional(request)

    @app.route("/agh/api/cases/<path:case>/files/<path:filename>/channels/<int:channel_index>/raw")
    def get_raw_channel(case, filename, channel_index):
        denied = require_permission("view")
        if denied:
            return denied
        path = image_path(cfg.data_root, case, filename)
        versioned = bool(request.args.get("v"))
        z_index = z_index_arg()
        response = raw_octet_response(raw_channel_cache.channel_bytes(path, channel_index, z_index).getvalue())
        stat = path.stat()
        response.set_etag(f"{stat.st_size}-{stat.st_mtime_ns}-{channel_index}-{z_index}")
        response.headers["Cache-Control"] = (
            f"private, max-age={cfg.versioned_response_cache_seconds}, immutable"
            if versioned else "private, no-cache"
        )
        return response.make_conditional(request)

    @app.route("/agh/api/cases/<path:case>/files/<path:filename>/annotations", methods=["GET"])
    def get_annotations(case, filename):
        denied = require_permission("view")
        if denied:
            return denied
        image_path(cfg.data_root, case, filename)
        return jsonify(annotations.get(case, filename))

    @app.route("/agh/api/cases/<path:case>/files/<path:filename>/annotations", methods=["PUT"])
    def save_annotations(case, filename):
        denied = require_permission("annotate")
        if denied:
            return denied
        image_path(cfg.data_root, case, filename)
        # Attribution is taken from the authenticated session, never from a
        # client-supplied header or body field, so it cannot be forged.
        updated_by = getattr(g, "remote_user", "") or ""
        revision_before = (request.get_json(silent=True) or {}).get("revision")
        result = annotations.save(
            case,
            filename,
            request.get_json(silent=True),
            updated_by,
        )
        audit_event(
            action="SAVE_ANNOTATION",
            case_id=case,
            filename=filename,
            annotation_revision_before=revision_before,
            annotation_revision_after=result.get("revision"),
            result="success",
        )
        return jsonify(result)

    @app.route("/agh/api/collaboration", methods=["GET"])
    def collaboration_snapshot():
        denied = require_permission("view")
        if denied:
            return denied
        return jsonify(collaboration.snapshot())

    @app.route("/agh/api/collaboration/heartbeat", methods=["POST"])
    def collaboration_heartbeat():
        denied = require_permission("view")
        if denied:
            return denied
        payload = request.get_json(silent=True) or {}
        case_id = payload.get("caseId")
        filename = payload.get("filename")
        if case_id and filename:
            image_path(cfg.data_root, case_id, filename)
        elif case_id:
            list_image_files(cfg.data_root, case_id)
        return jsonify(collaboration.heartbeat(client_id_from(payload), current_actor(payload)))

    @app.route("/agh/api/collaboration/workspace", methods=["PATCH"])
    def collaboration_workspace():
        denied = require_permission("view")
        if denied:
            return denied
        payload = request.get_json(silent=True) or {}
        return jsonify(collaboration.update_workspace(client_id_from(payload), current_actor(payload), payload))

    @app.route("/agh/api/cases/<path:case>/files/<path:filename>/view-state", methods=["GET"])
    def get_view_state(case, filename):
        denied = require_permission("view")
        if denied:
            return denied
        image_path(cfg.data_root, case, filename)
        return jsonify(collaboration.get_view_state(case, filename))

    @app.route("/agh/api/cases/<path:case>/files/<path:filename>/view-state", methods=["PATCH"])
    def save_view_state(case, filename):
        denied = require_permission("view")
        if denied:
            return denied
        image_path(cfg.data_root, case, filename)
        payload = request.get_json(silent=True) or {}
        return jsonify(collaboration.update_view_state(case, filename, current_actor(payload), payload))

    @app.route("/agh/api/audit/export-pdf", methods=["POST"])
    def audit_export_pdf():
        denied = require_permission("view")
        if denied:
            return denied
        payload = request.get_json(silent=True) or {}
        audit_event(
            action="EXPORT_PDF",
            case_id=payload.get("caseId"),
            filename=payload.get("filename"),
            result="success",
            details={"withAnnotations": bool(payload.get("withAnnotations"))},
        )
        return jsonify({"ok": True})

    @app.route("/agh/api/audit/export", methods=["POST"])
    def audit_export():
        denied = require_permission("view")
        if denied:
            return denied
        payload = request.get_json(silent=True) or {}
        export_format = str(payload.get("format") or "").strip().lower()
        if export_format not in {"pdf", "png", "jpeg"}:
            return jsonify({"error": "Unsupported export format"}), 400
        audit_event(
            action=f"EXPORT_{export_format.upper()}",
            case_id=payload.get("caseId"),
            filename=payload.get("filename"),
            result="success",
            details={
                "includeAnnotations": payload.get("includeAnnotations") is True,
                "includeAnnotationNames": payload.get("includeAnnotationNames") is True,
                "includeSegmentationPredictions": payload.get("includeSegmentationPredictions") is True,
            },
        )
        return jsonify({"ok": True})

    register_analysis_routes(app, cfg, analysis_store)
    register_ef_routes(app, cfg, raw_channel_cache)

    return app
