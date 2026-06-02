import logging
from typing import Optional

from flask import Flask, jsonify, request, send_file

from .annotation_service import AnnotationService
from .analysis_routes import register_analysis_routes
from .analysis_store import AnalysisStore
from .config import Config
from .errors import APIError
from .path_guard import image_path, list_cases, list_tiff_files
from .tiff_service import ImageCacheService


log = logging.getLogger(__name__)
VERSION = "0.3.0"


def create_app(config: Optional[Config] = None):
    cfg = config or Config.from_env()
    cfg.ensure_directories()

    app = Flask(__name__)
    cache = ImageCacheService(cfg.data_root, cfg.cache_root)
    annotations = AnnotationService(cfg.ann_root)
    analysis_store = AnalysisStore(cfg.analysis_db)

    @app.errorhandler(APIError)
    def handle_api_error(exc):
        return jsonify({"error": exc.message}), exc.status_code

    @app.errorhandler(Exception)
    def handle_unexpected_error(exc):
        log.exception("Unhandled API error")
        return jsonify({"error": "Internal server error"}), 500

    @app.route("/agh/api/health")
    @app.route("/agh/api/v1/health")
    def health():
        return jsonify({
            "ok": True,
            "service": "agh-viewer-api",
            "version": VERSION,
            "analysis": {
                "queue": "sqlite",
                "enabled": True,
            },
        })

    @app.route("/agh/api/cases")
    def cases():
        return jsonify({"cases": list_cases(cfg.data_root)})

    @app.route("/agh/api/cases/<path:case>/files")
    def files(case):
        return jsonify({"files": list_tiff_files(cfg.data_root, case)})

    @app.route("/agh/api/cases/<path:case>/files/<path:filename>/meta")
    def image_meta(case, filename):
        path = image_path(cfg.data_root, case, filename)
        return jsonify(cache.get_metadata(path))

    @app.route("/agh/api/cases/<path:case>/files/<path:filename>/channel/<int:ch>")
    def get_channel(case, filename, ch):
        path = image_path(cfg.data_root, case, filename)
        projection = (request.args.get("projection") or "mip").lower()
        z_raw = request.args.get("z")
        z_index = None
        if z_raw not in (None, ""):
            try:
                z_index = int(z_raw)
            except ValueError:
                raise APIError("Invalid Z-slice index", status_code=400)
        png_path = cache.get_channel_path(path, ch, z_index=z_index, projection=projection)
        return send_file(png_path, mimetype="image/png", conditional=True, max_age=86400)

    @app.route("/agh/api/cases/<path:case>/files/<path:filename>/thumbnail")
    def get_thumbnail(case, filename):
        path = image_path(cfg.data_root, case, filename)
        png_path = cache.get_thumbnail_path(path)
        return send_file(png_path, mimetype="image/png", conditional=True, max_age=86400)

    @app.route("/agh/api/cases/<path:case>/files/<path:filename>/annotations", methods=["GET"])
    def get_annotations(case, filename):
        image_path(cfg.data_root, case, filename)
        return jsonify(annotations.get(case, filename))

    @app.route("/agh/api/cases/<path:case>/files/<path:filename>/annotations", methods=["POST", "PUT"])
    def save_annotations(case, filename):
        image_path(cfg.data_root, case, filename)
        updated_by = request.headers.get("X-Remote-User") or request.headers.get("X-AGH-User", "")
        result = annotations.save(
            case,
            filename,
            request.get_json(silent=True),
            updated_by,
            require_revision=request.method == "PUT",
        )
        return jsonify(result)

    register_analysis_routes(app, cfg, cache, analysis_store)

    return app

