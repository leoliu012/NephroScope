"""Routes for cross-section filtering and human corrections of GBM predictions."""
from __future__ import annotations

import math

from flask import g, jsonify, request, send_file

from .analysis_artifacts import ensure_run_id
from .audit import audit_event
from .auth import has_permission
from .errors import BadRequest, Conflict
from .gbm_cross_section import DEFAULT_MAX_WINDOW, FilterSettings
from .gbm_refinement import (
    MAX_STROKE_POINTS,
    SEGMENTATION_OPERATION,
    create_edit,
    create_stroke_edit,
    filter_tokens,
    label_file,
    parse_filter,
    refinement_frames,
    refinement_view,
    remove_edits,
    stack_state,
)
from .gbm_refinement import _public_state
from .path_guard import image_path
from .segmentation_service import validate_thickness_request

MAX_TOKEN_RUNS = 5000


def register_gbm_refinement_routes(app, config, store):
    def require(permission):
        if has_permission(permission):
            return None
        audit_event(action="ACCESS_DENIED", result="failure", details={"permission": permission})
        return jsonify({"error": "Forbidden"}), 403

    def segmentation_run(run_id) -> dict:
        run = store.get_run(ensure_run_id(run_id))
        if run["status"] != "SUCCEEDED" or run["operation"] != SEGMENTATION_OPERATION:
            raise Conflict("Segmentation run is not finished")
        if (run.get("result") or {}).get("thicknessGeometryAvailable") is False:
            raise Conflict("This segmentation has no saved thickness geometry")
        return run

    def filter_and_calibration(body, run) -> tuple[FilterSettings, dict, dict]:
        parsed = parse_filter(body.get("filter") if body.get("filter") is not None else {})
        source = (run.get("request") or {}).get("source") or {}
        _, calibration = validate_thickness_request({
            "calibration": body.get("calibration"),
            "roi": {"type": "polygon", "points": [
                [0, 0], [source["width"], 0], [source["width"], source["height"]], [0, source["height"]],
            ]},
        }, run)
        return parsed[0], parsed[1], calibration

    @app.route("/agh/api/cases/<path:case>/files/<path:filename>/gbm-refinement", methods=["GET", "POST"])
    def gbm_refinement_status(case, filename):
        """Status of the Z stack analysis; POST also starts it, or retries a failed one."""
        denied = require("view")
        if denied:
            return denied
        image_path(config.active_data_root, case, filename)
        channel = _bounded_int(request.args.get("channel"), "channel", 0, 10000, 0)
        window = _bounded_int(request.args.get("window"), "window", 1, 200, DEFAULT_MAX_WINDOW)
        starting = request.method == "POST"
        state = stack_state(config, store, case, filename, channel, window=window, ensure=starting, retry=starting)
        return jsonify(_public_state(state))

    @app.route("/agh/api/analysis-runs/<run_id>/refinement", methods=["POST"])
    def gbm_run_refinement(run_id):
        denied = require("view")
        if denied:
            return denied
        run = segmentation_run(run_id)
        settings, options, calibration = filter_and_calibration(_json_body(), run)
        return jsonify(refinement_view(config, store, run, settings, options, calibration))

    @app.route("/agh/api/analysis-runs/<run_id>/refinement/label.png", methods=["GET"])
    def gbm_run_label(run_id):
        denied = require("view")
        if denied:
            return denied
        run = segmentation_run(run_id)
        window = _bounded_int(request.args.get("window"), "window", 1, 200, DEFAULT_MAX_WINDOW)
        path = label_file(config, store, run, {"window": window})
        response = send_file(path, mimetype="image/png", conditional=True, max_age=config.versioned_response_cache_seconds)
        # The URL carries a token that changes whenever these pieces do.
        response.headers["Cache-Control"] = f"private, max-age={config.versioned_response_cache_seconds}, immutable"
        return response

    @app.route("/agh/api/analysis-runs/refinement-tokens", methods=["POST"])
    def gbm_refinement_tokens():
        denied = require("view")
        if denied:
            return denied
        body = _json_body()
        run_ids = body.get("runIds")
        if not isinstance(run_ids, list) or not run_ids or len(run_ids) > MAX_TOKEN_RUNS:
            raise BadRequest(f"runIds must list 1 to {MAX_TOKEN_RUNS} runs")
        settings, options = parse_filter(body.get("filter") if body.get("filter") is not None else {})
        runs = store.get_runs(ensure_run_id(run_id) for run_id in run_ids)
        return jsonify(filter_tokens(config, store, runs, settings, options))

    @app.route("/agh/api/analysis-runs/refinement-frames", methods=["POST"])
    def gbm_refinement_frames():
        """What to draw for every slice of a stack, for smooth scrubbing."""
        denied = require("view")
        if denied:
            return denied
        body = _json_body()
        run_ids = body.get("runIds")
        if not isinstance(run_ids, list) or not run_ids or len(run_ids) > MAX_TOKEN_RUNS:
            raise BadRequest(f"runIds must list 1 to {MAX_TOKEN_RUNS} runs")
        runs = store.get_runs(ensure_run_id(run_id) for run_id in run_ids)
        if not runs:
            return jsonify({"frames": {}, "reasonNames": {}})
        settings, options = parse_filter(body.get("filter") if body.get("filter") is not None else {})
        _, calibration = validate_thickness_request({
            "calibration": body.get("calibration"),
            "roi": {"type": "polygon", "points": [[0, 0], [1, 0], [1, 1]]},
        }, next(iter(runs.values())))
        return jsonify(refinement_frames(config, store, runs, settings, options, calibration))

    @app.route("/agh/api/analysis-runs/<run_id>/edits", methods=["POST"])
    def gbm_create_edit(run_id):
        denied = require("annotate")
        if denied:
            return denied
        run = segmentation_run(run_id)
        body = _json_body()
        settings, options, calibration = filter_and_calibration(body, run)
        actor = getattr(g, "remote_user", "") or ""
        if body.get("stroke") is not None:
            edit = create_stroke_edit(
                config, store, run, body.get("kind"), _stroke(body.get("stroke")), _radius(body.get("radius")), actor, options,
            )
        else:
            x, y = _coordinate(body.get("x"), "x"), _coordinate(body.get("y"), "y")
            edit = create_edit(config, store, run, body.get("kind"), x, y, actor, settings, options, calibration)
        audit_event(
            action="GBM_PREDICTION_EDITED", case_id=run["case"], filename=run["filename"], result="success",
            details={"runId": run["runId"], "zIndex": run["zIndex"], "kind": edit["kind"], "editId": edit["id"]},
        )
        return jsonify({
            "edit": {key: edit[key] for key in ("id", "kind", "x", "y", "zIndex")},
            "refinement": refinement_view(config, store, run, settings, options, calibration),
        }), 201

    @app.route("/agh/api/analysis-runs/<run_id>/edits", methods=["DELETE"])
    def gbm_delete_edits(run_id):
        """Undo one correction (``edit``), or restore a slice or the whole image (``scope``)."""
        denied = require("annotate")
        if denied:
            return denied
        run = segmentation_run(run_id)
        edit_id = request.args.get("edit")
        scope = request.args.get("scope")
        if bool(edit_id) == bool(scope) or scope not in (None, "slice", "image"):
            raise BadRequest("Give either edit, or scope as slice or image")
        removed = remove_edits(
            config, store, run,
            edit_id=ensure_run_id(edit_id) if edit_id else None, whole_image=scope == "image",
        )
        audit_event(
            action="GBM_PREDICTION_RESTORED", case_id=run["case"], filename=run["filename"], result="success",
            details={"runId": run["runId"], "zIndex": run["zIndex"], "scope": scope or "edit", "removed": removed},
        )
        return jsonify({"removed": removed})

    return store


def _json_body() -> dict:
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        raise BadRequest("JSON body is required")
    return payload


def _bounded_int(value, label, low, high, default):
    if value in (None, ""):
        return default
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise BadRequest(f"{label} must be a whole number") from exc
    if not low <= parsed <= high:
        raise BadRequest(f"{label} must be between {low} and {high}")
    return parsed


def _stroke(value) -> list:
    if not isinstance(value, list) or not value or len(value) > MAX_STROKE_POINTS:
        raise BadRequest(f"stroke must list 1 to {MAX_STROKE_POINTS} points")
    points = []
    for point in value:
        if not isinstance(point, list) or len(point) != 2:
            raise BadRequest("Each stroke point must be [x, y]")
        points.append([_coordinate(point[0], "x"), _coordinate(point[1], "y")])
    return points


def _radius(value) -> float:
    radius = _coordinate(value, "radius")
    if not 0.5 <= radius <= 1000:
        raise BadRequest("radius must be between 0.5 and 1000")
    return radius


def _coordinate(value, label) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise BadRequest(f"{label} must be a number")
    return float(value)
