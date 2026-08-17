"""Authenticated API routes for asynchronous MorphoGBM analysis runs."""
from __future__ import annotations

import logging

from flask import g, jsonify, request, send_file

from .analysis_artifacts import ensure_run_id, mask_path, remove_run_artifacts
from .analysis_store import public_run
from .audit import audit_event
from .auth import has_permission
from .errors import APIError, BadRequest, Conflict
from .path_guard import image_path
from .segmentation_service import (
    OPERATION,
    measure_run_thickness,
    prepare_analysis_request,
)


log = logging.getLogger(__name__)


def register_analysis_routes(app, config, store):
    def require_view():
        if has_permission("view"):
            return None
        audit_event(action="ACCESS_DENIED", result="failure", details={"permission": "view"})
        return jsonify({"error": "Forbidden"}), 403

    @app.route(
        "/agh/api/cases/<path:case>/files/<path:filename>/analysis-runs",
        methods=["POST"],
    )
    def create_analysis_run(case, filename):
        denied = require_view()
        if denied:
            return denied
        path = image_path(config.data_root, case, filename)
        normalized, cache_key = prepare_analysis_request(
            config, path, request.get_json(silent=True)
        )
        actor = getattr(g, "remote_user", "") or ""
        run, reused = store.create_or_reuse_run(
            case,
            filename,
            OPERATION,
            normalized,
            cache_key=cache_key,
            requested_by=actor,
        )
        audit_event(
            action="SEGMENTATION_QUEUED",
            case_id=case,
            filename=filename,
            result="pending" if run["status"] in {"QUEUED", "RUNNING"} else "success",
            details={
                "runId": run["runId"],
                "zIndex": normalized["zIndex"],
                "channelIndex": normalized["channelIndex"],
                "zWindow": normalized["zWindow"],
                "reused": reused,
                "status": run["status"],
            },
        )
        response = jsonify(
            {
                "runId": run["runId"],
                "status": run["status"],
                "operation": run["operation"],
                "statusUrl": f"/agh/api/analysis-runs/{run['runId']}",
                "reused": reused,
            }
        )
        response.status_code = 202
        response.headers["Location"] = f"/agh/api/analysis-runs/{run['runId']}"
        return response

    @app.route(
        "/agh/api/cases/<path:case>/files/<path:filename>/analysis-runs",
        methods=["GET"],
    )
    def list_analysis_runs(case, filename):
        denied = require_view()
        if denied:
            return denied
        path = image_path(config.data_root, case, filename)
        z_index = _optional_z_index(request.args.get("zIndex"))
        latest_per_z = _optional_boolean(request.args.get("latestPerZ"), "latestPerZ")
        if latest_per_z:
            stat = path.stat()
            source_identity = {
                "size": int(stat.st_size),
                "mtimeNs": int(stat.st_mtime_ns),
            }
            runs = store.list_latest_runs_by_z(
                case,
                filename,
                operation=OPERATION,
                source_identity=source_identity,
            )
        else:
            runs = store.list_runs(
                case,
                filename,
                operation=OPERATION,
                z_index=z_index,
                limit=request.args.get("limit", 20),
            )
        return jsonify({"runs": [public_run(run) for run in runs]})

    @app.route(
        "/agh/api/cases/<path:case>/files/<path:filename>/analysis-runs",
        methods=["DELETE"],
    )
    def delete_analysis_runs_for_slice(case, filename):
        denied = require_view()
        if denied:
            return denied
        image_path(config.data_root, case, filename)
        z_index = _required_z_index(request.args.get("zIndex"))
        run_ids = store.delete_terminal_runs_for_slice(
            case,
            filename,
            operation=OPERATION,
            z_index=z_index,
        )
        cleanup_failures = 0
        for run_id in run_ids:
            try:
                remove_run_artifacts(config.analysis_root, run_id)
            except OSError:
                cleanup_failures += 1
                log.exception("Unable to remove artifacts for deleted analysis run %s", run_id)
        audit_event(
            action="SEGMENTATION_DELETED",
            case_id=case,
            filename=filename,
            result="success",
            details={
                "zIndex": z_index,
                "deletedRunCount": len(run_ids),
                "artifactCleanupFailures": cleanup_failures,
            },
        )
        return jsonify({"deleted": len(run_ids), "zIndex": z_index})

    @app.route("/agh/api/analysis-runs/<run_id>", methods=["GET"])
    def get_analysis_run(run_id):
        denied = require_view()
        if denied:
            return denied
        run_id = ensure_run_id(run_id)
        return jsonify(public_run(store.get_run(run_id)))

    @app.route("/agh/api/analysis-runs/<run_id>/mask", methods=["GET"])
    def get_analysis_mask(run_id):
        denied = require_view()
        if denied:
            return denied
        run_id = ensure_run_id(run_id)
        run = store.get_run(run_id)
        if run["status"] == "FAILED":
            raise Conflict("Segmentation run failed")
        if run["status"] != "SUCCEEDED":
            raise Conflict("Segmentation run is not finished")
        path = mask_path(
            config.analysis_root,
            run_id,
            attempt=(run.get("result") or {}).get("artifactAttempt"),
        )
        response = send_file(
            path,
            mimetype="image/png",
            conditional=True,
            max_age=config.versioned_response_cache_seconds,
        )
        response.set_etag(f"analysis-mask-{run['cacheKey']}")
        response.headers["Cache-Control"] = (
            f"private, max-age={config.versioned_response_cache_seconds}, immutable"
        )
        return response.make_conditional(request)

    @app.route(
        "/agh/api/analysis-runs/<run_id>/measurements/gbm-thickness",
        methods=["POST"],
    )
    def measure_analysis_gbm_thickness(run_id):
        denied = require_view()
        if denied:
            return denied
        run_id = ensure_run_id(run_id)
        run = store.get_run(run_id)
        try:
            result = measure_run_thickness(config, run, request.get_json(silent=True))
        except Exception as exc:
            audit_event(
                action="MEASURE_GBM_THICKNESS",
                case_id=run.get("case"),
                filename=run.get("filename"),
                result="failure",
                details={
                    "runId": run_id,
                    "error": exc.message if isinstance(exc, APIError) else "Internal error",
                },
            )
            raise
        audit_event(
            action="MEASURE_GBM_THICKNESS",
            case_id=run.get("case"),
            filename=run.get("filename"),
            result="success",
            details={
                "runId": run_id,
                "zIndex": result.get("zIndex"),
                "sampleCount": result.get("sampleCount"),
                "roiPointCount": len((result.get("roi") or {}).get("points") or []),
            },
        )
        return jsonify(result)

    return store


def _optional_z_index(value):
    if value in (None, ""):
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise BadRequest("zIndex must be a non-negative integer") from exc
    if parsed < 0 or str(value).strip() != str(parsed):
        raise BadRequest("zIndex must be a non-negative integer")
    return parsed


def _required_z_index(value):
    if value in (None, ""):
        raise BadRequest("zIndex is required")
    return _optional_z_index(value)


def _optional_boolean(value, field):
    if value in (None, "", "0", "false"):
        return False
    if value in ("1", "true"):
        return True
    raise BadRequest(f"{field} must be true or false")
