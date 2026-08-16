"""Ephemeral upload store for the manual line-pair expansion-factor tool.

Files a user drags in from their own machine to calibrate an expansion factor
are *not* part of the curated case dataset, so they never touch ``data_root``.
They live in a dedicated scratch directory under a UUID name, are validated as
TIFF/ND2 exactly like case images, and are swept away after a TTL. The preview
and metadata handlers reuse ``tiff_service`` so an upload behaves identically to
a case image inside the calibration UI (multi-Z, pixel-size detection, etc.).

The routes are namespaced under ``/agh/api/ef/`` and gated behind the same
``view`` permission as browsing, keeping the surface small and isolated.
"""
from __future__ import annotations

import json
import re
import shutil
import time
import uuid
from pathlib import Path

from flask import g, jsonify, request, send_file

from .audit import audit_event
from .auth import has_permission
from .errors import APIError, BadRequest, NotFound
from .path_guard import IMAGE_EXTS
from .tiff_service import RawChannelCache, get_metadata, render_preview_png


UPLOAD_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_COPY_CHUNK = 4 * 1024 * 1024


class PayloadTooLarge(APIError):
    status_code = 413
    message = "Uploaded file is too large"


def _safe_ext(filename: str) -> str:
    ext = Path(filename or "").suffix.lower()
    if ext not in IMAGE_EXTS:
        raise BadRequest("Only .tif, .tiff, and .nd2 files are supported")
    return ext


class EfUploadStore:
    """Bounded, self-cleaning scratch store for calibration uploads."""

    def __init__(self, root: Path, max_bytes: int, ttl_seconds: int):
        self.root = Path(root)
        self.max_bytes = max(0, int(max_bytes or 0))
        self.ttl_seconds = max(0, int(ttl_seconds or 0))

    def _ensure_root(self):
        self.root.mkdir(parents=True, exist_ok=True)

    def _dir_for(self, upload_id: str) -> Path:
        if not isinstance(upload_id, str) or not UPLOAD_ID_RE.match(upload_id):
            raise NotFound("Upload not found")
        candidate = (self.root / upload_id).resolve()
        try:
            candidate.relative_to(self.root.resolve())
        except ValueError as exc:  # pragma: no cover - defensive
            raise NotFound("Upload not found") from exc
        return candidate

    def path_for(self, upload_id: str) -> Path:
        directory = self._dir_for(upload_id)
        meta_path = directory / "upload.json"
        if not meta_path.is_file():
            raise NotFound("Upload not found")
        try:
            record = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise NotFound("Upload not found") from exc
        stored = directory / record["storedName"]
        if not stored.is_file():
            raise NotFound("Upload not found")
        return stored

    def record_for(self, upload_id: str) -> dict:
        directory = self._dir_for(upload_id)
        meta_path = directory / "upload.json"
        if not meta_path.is_file():
            raise NotFound("Upload not found")
        return json.loads(meta_path.read_text(encoding="utf-8"))

    def save(self, file_storage) -> dict:
        self._ensure_root()
        self.sweep()

        if file_storage is None or not getattr(file_storage, "filename", ""):
            raise BadRequest("No file was uploaded")

        original_name = file_storage.filename
        ext = _safe_ext(original_name)

        declared = request.content_length or 0
        if self.max_bytes and declared and declared > self.max_bytes:
            raise PayloadTooLarge(
                f"Uploaded file exceeds the {self.max_bytes // (1024 * 1024)} MB limit"
            )

        upload_id = uuid.uuid4().hex
        directory = self.root / upload_id
        directory.mkdir(parents=True, exist_ok=False)
        stored_name = f"image{ext}"
        stored_path = directory / stored_name

        written = 0
        try:
            stream = file_storage.stream
            with open(stored_path, "wb") as dest:
                while True:
                    chunk = stream.read(_COPY_CHUNK)
                    if not chunk:
                        break
                    written += len(chunk)
                    if self.max_bytes and written > self.max_bytes:
                        raise PayloadTooLarge(
                            f"Uploaded file exceeds the {self.max_bytes // (1024 * 1024)} MB limit"
                        )
                    dest.write(chunk)
            if written == 0:
                raise BadRequest("Uploaded file was empty")
            # Validate it really is a readable TIFF/ND2 before we advertise it.
            meta = get_metadata(stored_path)
        except Exception:
            shutil.rmtree(directory, ignore_errors=True)
            raise

        record = {
            "uploadId": upload_id,
            "originalName": original_name,
            "storedName": stored_name,
            "sizeBytes": written,
            "createdAt": time.time(),
        }
        (directory / "upload.json").write_text(json.dumps(record), encoding="utf-8")

        meta = dict(meta)
        meta["source"] = "upload"
        meta["uploadId"] = upload_id
        meta["originalName"] = original_name
        meta["sourceRelPath"] = original_name
        return {"uploadId": upload_id, "originalName": original_name, "meta": meta}

    def meta(self, upload_id: str) -> dict:
        path = self.path_for(upload_id)
        record = self.record_for(upload_id)
        meta = dict(get_metadata(path))
        meta["source"] = "upload"
        meta["uploadId"] = upload_id
        meta["originalName"] = record.get("originalName")
        meta["sourceRelPath"] = record.get("originalName")
        return meta

    def sweep(self):
        """Best-effort removal of uploads older than the configured TTL."""
        if not self.ttl_seconds or not self.root.exists():
            return
        cutoff = time.time() - self.ttl_seconds
        for child in self.root.iterdir():
            if not child.is_dir():
                continue
            meta_path = child / "upload.json"
            created = None
            try:
                if meta_path.is_file():
                    created = json.loads(meta_path.read_text(encoding="utf-8")).get("createdAt")
            except (OSError, ValueError):
                created = None
            if created is None:
                try:
                    created = child.stat().st_mtime
                except OSError:
                    continue
            if created < cutoff:
                shutil.rmtree(child, ignore_errors=True)


def register_ef_routes(app, cfg, raw_channel_cache=None):
    """Attach the calibration upload endpoints to an existing Flask app."""
    store = EfUploadStore(
        cfg.ef_upload_root,
        cfg.ef_upload_max_bytes,
        cfg.ef_upload_ttl_seconds,
    )
    # Reuse the app's raw-channel cache so uploaded calibration images render
    # through the exact same channel pipeline as case images.
    cache = raw_channel_cache or RawChannelCache(cfg.raw_channel_cache_bytes)
    app.extensions.setdefault("agh_ef", {})["uploads"] = store

    def _require_view():
        if has_permission("view"):
            return None
        audit_event(action="ACCESS_DENIED", result="failure", details={"permission": "view"})
        return jsonify({"error": "Forbidden"}), 403

    def _preview_z_index():
        try:
            value = int(request.args.get("z", "0"))
        except ValueError:
            value = 0
        return max(0, value)

    @app.route("/agh/api/ef/uploads", methods=["POST"])
    def ef_upload_create():
        denied = _require_view()
        if denied:
            return denied
        result = store.save(request.files.get("file"))
        audit_event(
            action="EF_UPLOAD",
            result="success",
            details={
                "uploadId": result["uploadId"],
                "originalName": result["originalName"],
                "user": getattr(g, "remote_user", "") or "",
            },
        )
        return jsonify(result)

    @app.route("/agh/api/ef/uploads/<upload_id>/meta")
    def ef_upload_meta(upload_id):
        denied = _require_view()
        if denied:
            return denied
        return jsonify(store.meta(upload_id))

    @app.route("/agh/api/ef/uploads/<upload_id>/preview")
    def ef_upload_preview(upload_id):
        denied = _require_view()
        if denied:
            return denied
        path = store.path_for(upload_id)
        buf = render_preview_png(path, request.args.get("max"), _preview_z_index())
        response = send_file(buf, mimetype="image/png", max_age=0)
        response.headers["Cache-Control"] = "private, no-cache"
        return response

    @app.route("/agh/api/ef/uploads/<upload_id>/channels/<int:channel_index>/raw")
    def ef_upload_raw_channel(upload_id, channel_index):
        denied = _require_view()
        if denied:
            return denied
        path = store.path_for(upload_id)
        z_index = _preview_z_index()
        payload = cache.channel_bytes(path, channel_index, z_index).getvalue()
        response = app.response_class(payload, mimetype="application/octet-stream")
        stat = path.stat()
        response.set_etag(f"{stat.st_size}-{stat.st_mtime_ns}-{channel_index}-{z_index}")
        versioned = bool(request.args.get("v"))
        response.headers["Cache-Control"] = (
            f"private, max-age={cfg.versioned_response_cache_seconds}, immutable"
            if versioned else "private, no-cache"
        )
        return response.make_conditional(request)

    return store
