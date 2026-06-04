import shutil

from flask import jsonify, request, send_file

from .analysis_artifacts import artifact_mimetype, artifact_path, run_directory
from .analysis_service import (
    analysis_capabilities,
    create_metric_run,
    create_metric_run_for_file,
    create_process_area_preview,
)
from .analysis_validation import validate_analysis_request
from .errors import BadRequest
from .path_guard import image_path


def register_analysis_routes(app, config, cache, store):
    @app.route("/agh/api/cases/<path:case>/files/<path:filename>/analysis-runs", methods=["POST"])
    def create_analysis_run(case, filename):
        path = image_path(config.data_root, case, filename)
        metadata = cache.get_metadata(path)
        payload = validate_analysis_request(request.get_json(silent=True), metadata)
        run = store.create_run(case, filename, "magnifyseg-segmentation", payload)
        return jsonify({"runId": run["runId"], "status": run["status"]}), 202

    @app.route("/agh/api/cases/<path:case>/files/<path:filename>/analysis-runs", methods=["GET"])
    def list_analysis_runs(case, filename):
        image_path(config.data_root, case, filename)
        operation = request.args.get("operation") or None
        limit = request.args.get("limit", 20)
        return jsonify({"runs": store.list_runs(case, filename, operation=operation, limit=limit)})

    @app.route("/agh/api/cases/<path:case>/files/<path:filename>/metrics/gbm-thickness", methods=["POST"])
    def compute_file_gbm_thickness(case, filename):
        image_path(config.data_root, case, filename)
        run = create_metric_run_for_file(store, case, filename, "gbm-thickness", request.get_json(silent=True) or {})
        return jsonify(_metric_created_response(run)), 202

    @app.route("/agh/api/cases/<path:case>/files/<path:filename>/metrics/process-nnd", methods=["POST"])
    def compute_file_process_nnd(case, filename):
        image_path(config.data_root, case, filename)
        run = create_metric_run_for_file(store, case, filename, "process-nnd", request.get_json(silent=True) or {})
        return jsonify(_metric_created_response(run)), 202

    @app.route("/agh/api/analysis-runs/<run_id>")
    def get_analysis_run(run_id):
        return jsonify(store.get_run(run_id))

    @app.route("/agh/api/analysis-runs/<run_id>/capabilities")
    def get_analysis_capabilities(run_id):
        return jsonify(analysis_capabilities(store.get_run(run_id), _calibration_override_from_query()))

    @app.route("/agh/api/analysis-runs/<run_id>", methods=["DELETE"])
    def delete_analysis_run(run_id):
        run = store.delete_run(run_id)
        if run["operation"] == "magnifyseg-segmentation":
            shutil.rmtree(run_directory(config.analysis_root, run_id), ignore_errors=True)
        return jsonify({"deleted": True, "runId": run_id})

    @app.route("/agh/api/analysis-runs/<run_id>/artifacts/<path:artifact>")
    def get_analysis_artifact(run_id, artifact):
        path = artifact_path(config.analysis_root, run_id, artifact)
        return send_file(path, mimetype=artifact_mimetype(path), conditional=True, max_age=0)

    @app.route("/agh/api/analysis-runs/<run_id>/metrics", methods=["GET"])
    def list_analysis_metrics(run_id):
        run = store.get_run(run_id)
        if run["operation"] != "magnifyseg-segmentation":
            raise BadRequest("Metric children can only be listed for a segmentation run")
        limit = request.args.get("limit", 50)
        return jsonify({"runs": store.list_metric_runs(run_id, limit=limit)})

    @app.route("/agh/api/analysis-runs/<run_id>/metrics/gbm-thickness", methods=["POST"])
    def compute_gbm_thickness(run_id):
        run = create_metric_run(store, run_id, "gbm-thickness", request.get_json(silent=True) or {})
        return jsonify(_metric_created_response(run)), 202

    @app.route("/agh/api/analysis-runs/<run_id>/metrics/process-nnd", methods=["POST"])
    def compute_process_nnd(run_id):
        run = create_metric_run(store, run_id, "process-nnd", request.get_json(silent=True) or {})
        return jsonify(_metric_created_response(run)), 202

    @app.route("/agh/api/analysis-runs/<run_id>/process-area-preview", methods=["POST"])
    def preview_process_area(run_id):
        preview = create_process_area_preview(config, store, run_id, request.get_json(silent=True) or {})
        return jsonify(preview)


def _metric_created_response(run):
    response = {
        "runId": run["runId"],
        "status": run["status"],
        "operation": run["operation"],
    }
    for key in ("sourceSegmentationRunId", "sourceModel", "sourceCreatedAt"):
        if run.get(key) is not None:
            response[key] = run[key]
    return response


def _calibration_override_from_query():
    keys = {
        "pixelSize",
        "pixelUnit",
        "expanded",
        "expansionFactor",
        "effectivePixelSizeOverride",
    }
    if not any(key in request.args for key in keys):
        return None
    payload = {}
    for key in keys:
        if key not in request.args:
            continue
        value = request.args.get(key)
        if key == "expanded":
            payload[key] = str(value).lower() in {"1", "true", "yes", "on"}
        else:
            payload[key] = value
    return payload
