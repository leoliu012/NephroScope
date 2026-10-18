"""Batch run endpoints and saved case analyses.

Case analysis touches hundreds of Z slices at once. These endpoints submit,
poll, cancel and measure them in a few requests instead of one request per
slice, and keep saved analyses on the server so they can be reopened, resumed
and merged. Saved analyses reference runs by cache key, so a slice segmented
by any analysis or by the viewer counts as done everywhere.
"""
from __future__ import annotations

import hashlib
import json
import logging
import math

from flask import g, jsonify, request

from .analysis_artifacts import ensure_run_id
from .analysis_store import RUN_PRIORITY
from .audit import audit_event
from .auth import has_permission
from .errors import APIError, BadRequest
from .path_guard import image_path
from .segmentation_service import (
    OPERATION,
    analysis_request_cache_key,
    analysis_request_context,
    build_analysis_request,
    measure_run_distribution,
)


log = logging.getLogger(__name__)

MAX_BATCH_RUNS = 5000
MAX_COVERAGE_IMAGES = 500
MAX_DISTRIBUTIONS = 60
MAX_GAP = 8
REUSABLE_STATUSES = ("SUCCEEDED", "QUEUED", "RUNNING")


def register_case_analysis_routes(app, config, store):
    def require_view():
        if has_permission("view"):
            return None
        audit_event(action="ACCESS_DENIED", result="failure", details={"permission": "view"})
        return jsonify({"error": "Forbidden"}), 403

    def actor() -> str:
        return getattr(g, "remote_user", "") or ""

    def prepare(items: list[dict]) -> list[dict]:
        """Build request payloads, reading each image's metadata only once."""
        contexts: dict[tuple[str, str], tuple] = {}
        prepared = []
        for item in items:
            image = (item["case"], item["filename"])
            if image not in contexts:
                try:
                    path = image_path(config.active_data_root, *image)
                    contexts[image] = (path, analysis_request_context(config, path), None)
                except APIError as exc:
                    contexts[image] = (None, None, exc.message)
                except Exception:  # unreadable or unsupported source file
                    log.exception("Unable to prepare analysis requests for %s/%s", *image)
                    contexts[image] = (None, None, "This image could not be read")
            path, context, error = contexts[image]
            if error:
                prepared.append({"error": error})
                continue
            try:
                payload, key = build_analysis_request(path, context, item["zIndex"], item["channelIndex"])
            except APIError as exc:
                prepared.append({"error": exc.message})
                continue
            prepared.append({
                "request": payload,
                "cacheKey": key,
                "legacyCacheKey": analysis_request_cache_key(path, payload, legacy_source=True),
            })
        return prepared

    def submit(items: list[dict], prepared: list[dict]) -> list[dict]:
        results = []
        for item, prep in zip(items, prepared):
            echo = {key: item[key] for key in ("case", "filename", "zIndex", "channelIndex")}
            if "error" in prep:
                results.append({**echo, "status": "SUBMIT_ERROR", "error": {"message": prep["error"]}})
                continue
            run, reused = store.create_or_reuse_run(
                item["case"], item["filename"], OPERATION, prep["request"],
                cache_key=prep["cacheKey"], requested_by=actor(),
                cache_key_aliases=(prep["legacyCacheKey"],),
            )
            results.append({**echo, **_brief_run(run), "reused": reused})
        queued = sum(1 for result in results if result["status"] in ("QUEUED", "RUNNING") and not result.get("reused"))
        audit_event(
            action="SEGMENTATION_BATCH_QUEUED",
            result="pending" if queued else "success",
            details={
                "count": len(results),
                "queued": queued,
                "reused": sum(1 for result in results if result.get("reused")),
                "errors": sum(1 for result in results if result["status"] == "SUBMIT_ERROR"),
            },
        )
        return results

    def analysis_response(owner: str, analysis_id: str, **extra):
        record = store.get_case_analysis(owner, analysis_id)
        best = store.best_runs_for_cache_keys(_job_keys(record["jobs"]))
        return {**_analysis_payload(record, best, include_jobs=True), **extra}

    @app.route("/agh/api/analysis-runs/batch", methods=["POST"])
    def submit_analysis_run_batch():
        denied = require_view()
        if denied:
            return denied
        items = _run_items(_json_body().get("runs"))
        return jsonify({"runs": submit(items, prepare(items))}), 202

    @app.route("/agh/api/analysis-runs/lookup", methods=["POST"])
    def lookup_analysis_runs():
        denied = require_view()
        if denied:
            return denied
        run_ids = _run_ids(_json_body().get("runIds"))
        runs = store.get_runs(run_ids)
        return jsonify({"runs": {run_id: _brief_run(run) for run_id, run in runs.items()}})

    @app.route("/agh/api/analysis-runs/cancel", methods=["POST"])
    def cancel_analysis_runs():
        denied = require_view()
        if denied:
            return denied
        canceled, kept = store.cancel_queued_runs(_run_ids(_json_body().get("runIds")))
        audit_event(action="SEGMENTATION_CANCELED", result="success",
                    details={"canceled": len(canceled), "kept": len(kept)})
        return jsonify({"canceled": canceled, "kept": kept})

    @app.route("/agh/api/analysis-runs/distributions", methods=["POST"])
    def analysis_run_distributions():
        denied = require_view()
        if denied:
            return denied
        items = _json_body().get("items")
        if not isinstance(items, list) or not items or len(items) > MAX_DISTRIBUTIONS:
            raise BadRequest(f"items must list 1 to {MAX_DISTRIBUTIONS} runs")
        requested = [(ensure_run_id(item.get("runId") if isinstance(item, dict) else None), item) for item in items]
        runs = store.get_runs(run_id for run_id, _ in requested)
        results = []
        for run_id, item in requested:
            run = runs.get(run_id)
            if run is None:
                results.append({"runId": run_id, "status": 404, "error": "Analysis run not found"})
                continue
            try:
                distribution = measure_run_distribution(config, run, {"calibration": item.get("calibration")})
                results.append({"runId": run_id, "distribution": distribution})
            except APIError as exc:
                results.append({"runId": run_id, "status": exc.status_code, "error": exc.message})
            except Exception:
                log.exception("Unable to measure the distribution for run %s", run_id)
                results.append({"runId": run_id, "status": 500, "error": "Internal error"})
        audit_event(
            action="MEASURE_GBM_DISTRIBUTION", result="success",
            details={"count": len(results), "errors": sum(1 for result in results if "error" in result)},
        )
        return jsonify({"results": results})

    @app.route("/agh/api/analysis-coverage", methods=["POST"])
    def analysis_coverage():
        """Every reusable/active/failed run per Z slice for the current pipeline."""
        denied = require_view()
        if denied:
            return denied
        images = _json_body().get("images")
        if not isinstance(images, list) or not images or len(images) > MAX_COVERAGE_IMAGES:
            raise BadRequest(f"images must list 1 to {MAX_COVERAGE_IMAGES} images")
        output, keyed = [], []
        for raw in images:
            image = _image_ref(raw)
            echo = {"case": image["case"], "filename": image["filename"], "channelIndex": image["channelIndex"]}
            try:
                path = image_path(config.active_data_root, image["case"], image["filename"])
                context = analysis_request_context(config, path)
            except APIError as exc:
                output.append({**echo, "error": exc.message})
                continue
            except Exception:
                log.exception("Unable to read coverage for %s/%s", image["case"], image["filename"])
                output.append({**echo, "error": "This image could not be read"})
                continue
            z_count = context["source"]["zCount"]
            if image["channelIndex"] >= context["source"]["channelCount"]:
                output.append({**echo, "zCount": z_count, "error": "Channel is not available in this image"})
                continue
            slices = {}
            for z_index in range(z_count):
                payload, key = build_analysis_request(path, context, z_index, image["channelIndex"])
                slices[z_index] = (key, analysis_request_cache_key(path, payload, legacy_source=True))
                keyed.extend(slices[z_index])
            output.append({**echo, "zCount": z_count, "slices": slices})
        best = store.best_runs_for_cache_keys(keyed)
        for entry in output:
            slices = entry.pop("slices", None)
            if slices is None:
                continue
            entry["runs"] = {
                str(z_index): _brief_run(run)
                for z_index, keys in slices.items()
                if (run := _best_of(best, keys)) is not None
            }
        return jsonify({"images": output})

    @app.route("/agh/api/case-analyses", methods=["GET"])
    def list_case_analyses():
        denied = require_view()
        if denied:
            return denied
        records = store.list_case_analyses(actor())
        best = store.best_runs_for_cache_keys(key for record in records for key in _job_keys(record["jobs"]))
        return jsonify({"analyses": [_analysis_payload(record, best, include_jobs=False) for record in records]})

    @app.route("/agh/api/case-analyses", methods=["POST"])
    def create_case_analysis():
        denied = require_view()
        if denied:
            return denied
        body = _json_body()
        definition, jobs = _analysis_definition(body)
        items = [{"case": job["caseId"], "filename": job["filename"], "zIndex": job["zIndex"],
                  "channelIndex": job["channelIndex"]} for job in jobs]
        prepared = prepare(items)
        failure = next((prep["error"] for prep in prepared if "error" in prep), None)
        if failure:
            raise BadRequest(failure)
        rows = [{**job, "cacheKey": prep["cacheKey"], "legacyCacheKey": prep["legacyCacheKey"]}
                for job, prep in zip(jobs, prepared)]
        owner = actor()
        analysis_id, merged = store.save_case_analysis(owner, _signature(definition), definition, rows)
        pending, submitted = [], []
        if body.get("start", True) is not False:
            best = store.best_runs_for_cache_keys(_job_keys(rows))
            pending = [index for index, row in enumerate(rows) if not _reusable(_best_of(best, _row_keys(row)))]
            submitted = submit([items[i] for i in pending], [prepared[i] for i in pending])
        audit_event(action="CASE_ANALYSIS_SAVED", result="success", details={
            "analysisId": analysis_id, "merged": merged, "images": len(definition["images"]),
            "jobs": len(rows), "submitted": len(submitted),
        })
        response = jsonify(analysis_response(owner, analysis_id, merged=merged, submitErrors=_submit_errors(rows, pending, submitted)))
        response.status_code = 200 if merged else 201
        return response

    @app.route("/agh/api/case-analyses/<analysis_id>", methods=["GET"])
    def get_case_analysis(analysis_id):
        denied = require_view()
        if denied:
            return denied
        return jsonify(analysis_response(actor(), _analysis_id(analysis_id)))

    @app.route("/agh/api/case-analyses/<analysis_id>", methods=["DELETE"])
    def delete_case_analysis(analysis_id):
        denied = require_view()
        if denied:
            return denied
        owner, analysis_id = actor(), _analysis_id(analysis_id)
        record = store.get_case_analysis(owner, analysis_id)
        canceled, _ = store.cancel_queued_runs(_queued_run_ids(store, record["jobs"]), exclude_analysis_id=analysis_id)
        store.delete_case_analysis(owner, analysis_id)
        audit_event(action="CASE_ANALYSIS_DELETED", result="success",
                    details={"analysisId": analysis_id, "canceled": len(canceled)})
        return jsonify({"deleted": analysis_id, "canceled": len(canceled)})

    @app.route("/agh/api/case-analyses/<analysis_id>/interrupt", methods=["POST"])
    def interrupt_case_analysis(analysis_id):
        denied = require_view()
        if denied:
            return denied
        owner, analysis_id = actor(), _analysis_id(analysis_id)
        record = store.get_case_analysis(owner, analysis_id)
        store.set_case_analysis_state(owner, analysis_id, "interrupted")
        canceled, kept = store.cancel_queued_runs(_queued_run_ids(store, record["jobs"]), exclude_analysis_id=analysis_id)
        audit_event(action="CASE_ANALYSIS_INTERRUPTED", result="success",
                    details={"analysisId": analysis_id, "canceled": len(canceled), "kept": len(kept)})
        return jsonify(analysis_response(owner, analysis_id, canceled=len(canceled), kept=len(kept)))

    @app.route("/agh/api/case-analyses/<analysis_id>/cancel", methods=["POST"])
    def cancel_case_analysis_jobs(analysis_id):
        denied = require_view()
        if denied:
            return denied
        owner, analysis_id = actor(), _analysis_id(analysis_id)
        job_ids = _json_body().get("jobIds")
        if not isinstance(job_ids, list) or not job_ids or not all(isinstance(value, str) for value in job_ids):
            raise BadRequest("jobIds must list the jobs to cancel")
        wanted = set(job_ids)
        record = store.get_case_analysis(owner, analysis_id)
        jobs = [job for job in record["jobs"] if job["id"] in wanted]
        canceled, kept = store.cancel_queued_runs(_queued_run_ids(store, jobs), exclude_analysis_id=analysis_id)
        audit_event(action="SEGMENTATION_CANCELED", result="success",
                    details={"analysisId": analysis_id, "canceled": len(canceled), "kept": len(kept)})
        return jsonify(analysis_response(owner, analysis_id, canceled=len(canceled), kept=len(kept)))

    @app.route("/agh/api/case-analyses/<analysis_id>/resume", methods=["POST"])
    def resume_case_analysis(analysis_id):
        denied = require_view()
        if denied:
            return denied
        owner, analysis_id = actor(), _analysis_id(analysis_id)
        record = store.get_case_analysis(owner, analysis_id)
        jobs = record["jobs"]
        items = [{"case": job["caseId"], "filename": job["filename"], "zIndex": job["zIndex"],
                  "channelIndex": job["channelIndex"]} for job in jobs]
        prepared = prepare(items)
        # Refresh keys so a replaced image or model is analyzed afresh.
        rows = [{**job, "cacheKey": prep["cacheKey"], "legacyCacheKey": prep["legacyCacheKey"]}
                if "error" not in prep else job for job, prep in zip(jobs, prepared)]
        store.update_case_analysis_jobs(owner, analysis_id, rows)
        store.set_case_analysis_state(owner, analysis_id, "active")
        best = store.best_runs_for_cache_keys(_job_keys(rows))
        pending = [index for index, row in enumerate(rows) if not _reusable(_best_of(best, _row_keys(row)))]
        submitted = submit([items[i] for i in pending], [prepared[i] for i in pending])
        return jsonify(analysis_response(owner, analysis_id, submitErrors=_submit_errors(rows, pending, submitted)))

    return store


def _json_body() -> dict:
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        raise BadRequest("JSON body is required")
    return payload


def _index(value, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise BadRequest(f"{label} must be a non-negative integer")
    return value


def _text(value, label: str) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > 1024:
        raise BadRequest(f"{label} is required")
    return value


def _image_ref(raw) -> dict:
    if not isinstance(raw, dict):
        raise BadRequest("Each image must be an object")
    return {
        "case": _text(raw.get("case"), "case"),
        "filename": _text(raw.get("filename"), "filename"),
        "channelIndex": _index(raw.get("channelIndex"), "channelIndex"),
    }


def _run_items(raw) -> list[dict]:
    if not isinstance(raw, list) or not raw or len(raw) > MAX_BATCH_RUNS:
        raise BadRequest(f"runs must list 1 to {MAX_BATCH_RUNS} Z slices")
    items = []
    for value in raw:
        image = _image_ref(value)
        items.append({**image, "zIndex": _index(value.get("zIndex"), "zIndex")})
    return items


def _run_ids(raw) -> list[str]:
    if not isinstance(raw, list) or len(raw) > MAX_BATCH_RUNS:
        raise BadRequest(f"runIds must list up to {MAX_BATCH_RUNS} runs")
    return [ensure_run_id(value) for value in raw]


def _analysis_id(value: str) -> str:
    return ensure_run_id(value)


def _positive(value, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        raise BadRequest(f"{label} must be a positive number")
    return value


def _gap(value, *, optional=False):
    if value is None and optional:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= MAX_GAP:
        raise BadRequest(f"gap must be an integer from 0 to {MAX_GAP}")
    return value


def image_key(case: str, filename: str) -> str:
    # Matches the browser's JSON.stringify([caseId, filename]).
    return json.dumps([case, filename], ensure_ascii=False, separators=(",", ":"))


def job_id(case: str, filename: str, z_index: int) -> str:
    return f"{image_key(case, filename)}:{z_index}"


def _analysis_definition(body: dict) -> tuple[dict, list[dict]]:
    gap = _gap(body.get("gap"))
    raw_images = body.get("images")
    if not isinstance(raw_images, list) or not raw_images or len(raw_images) > MAX_COVERAGE_IMAGES:
        raise BadRequest(f"images must list 1 to {MAX_COVERAGE_IMAGES} images")
    images: dict[str, dict] = {}
    for raw in raw_images:
        if not isinstance(raw, dict):
            raise BadRequest("Each image must be an object")
        case = _text(raw.get("caseId"), "caseId")
        filename = _text(raw.get("filename"), "filename")
        key = image_key(case, filename)
        if key in images:
            raise BadRequest("Each image can only be included once")
        calibration = raw.get("calibration")
        if not isinstance(calibration, dict) or not isinstance(calibration.get("expansionEnabled"), bool):
            raise BadRequest("Each image needs a calibration")
        images[key] = {
            "key": key,
            "caseId": case,
            "filename": filename,
            "channelIndex": _index(raw.get("channelIndex"), "channelIndex"),
            "zCount": max(1, _index(raw.get("zCount"), "zCount")),
            "gap": _gap(raw.get("gap"), optional=True),
            "calibration": {
                "pixelSizeXUm": _positive(calibration.get("pixelSizeXUm"), "pixelSizeXUm"),
                "pixelSizeYUm": _positive(calibration.get("pixelSizeYUm"), "pixelSizeYUm"),
                "expansionEnabled": calibration["expansionEnabled"],
                "expansionFactor": _positive(calibration.get("expansionFactor"), "expansionFactor"),
            },
        }
    raw_jobs = body.get("jobs")
    if not isinstance(raw_jobs, list) or not raw_jobs or len(raw_jobs) > MAX_BATCH_RUNS:
        raise BadRequest(f"jobs must list 1 to {MAX_BATCH_RUNS} Z slices")
    jobs, seen = [], set()
    for raw in raw_jobs:
        if not isinstance(raw, dict):
            raise BadRequest("Each job must be an object")
        key = image_key(_text(raw.get("caseId"), "caseId"), _text(raw.get("filename"), "filename"))
        image = images.get(key)
        if image is None:
            raise BadRequest("Each job must belong to an included image")
        z_index = _index(raw.get("zIndex"), "zIndex")
        if z_index >= image["zCount"]:
            raise BadRequest(f"zIndex must be below {image['zCount']} for {image['filename']}")
        identifier = job_id(image["caseId"], image["filename"], z_index)
        if identifier in seen:
            continue
        seen.add(identifier)
        jobs.append({"id": identifier, "caseId": image["caseId"], "filename": image["filename"],
                     "zIndex": z_index, "channelIndex": image["channelIndex"]})
    if {job["caseId"] + "\0" + job["filename"] for job in jobs} != {
        image["caseId"] + "\0" + image["filename"] for image in images.values()
    }:
        raise BadRequest("Every included image needs at least one Z slice")
    return {"gap": gap, "images": list(images.values())}, jobs


def _signature(definition: dict) -> str:
    """Same images, channels and Z sampling => the same saved analysis."""
    material = sorted(
        (json.dumps([image["caseId"], image["filename"], image["channelIndex"],
                     definition["gap"] if image["gap"] is None else image["gap"]],
                    ensure_ascii=False, separators=(",", ":"))
         for image in definition["images"])
    )
    return hashlib.sha256("\n".join(material).encode("utf-8")).hexdigest()


def _row_keys(row: dict) -> tuple[str, ...]:
    return tuple(key for key in (row.get("cacheKey"), row.get("legacyCacheKey")) if key)


def _job_keys(jobs: list[dict]) -> list[str]:
    return [key for job in jobs for key in _row_keys(job)]


def _best_of(best: dict, keys) -> dict | None:
    choices = sorted((best[key] for key in keys if key in best),
                     key=lambda run: run.get("createdAt") or "", reverse=True)
    # min() keeps the first (newest) of equally useful runs.
    return min(choices, key=lambda run: RUN_PRIORITY.get(run["status"], 3)) if choices else None


def _reusable(run: dict | None) -> bool:
    return bool(run and run["status"] in REUSABLE_STATUSES)


def _queued_run_ids(store, jobs: list[dict]) -> list[str]:
    best = store.best_runs_for_cache_keys(_job_keys(jobs))
    runs = (_best_of(best, _row_keys(job)) for job in jobs)
    return [run["runId"] for run in runs if run and run["status"] == "QUEUED"]


def _submit_errors(rows: list[dict], pending: list[int], submitted: list[dict]) -> dict:
    return {
        rows[index]["id"]: result["error"]["message"]
        for index, result in zip(pending, submitted)
        if result.get("status") == "SUBMIT_ERROR"
    }


def _brief_run(run: dict) -> dict:
    return {
        "runId": run["runId"],
        "status": run["status"],
        "progress": run.get("progress") or {},
        "error": {"code": run.get("errorCode"), "message": run.get("error")} if run.get("error") else None,
        "createdAt": run.get("createdAt"),
        "finishedAt": run.get("finishedAt"),
        "thicknessGeometryAvailable": (run.get("result") or {}).get("thicknessGeometryAvailable"),
    }


def _analysis_payload(record: dict, best: dict, *, include_jobs: bool) -> dict:
    counts = {"total": 0, "succeeded": 0, "running": 0, "queued": 0, "failed": 0, "canceled": 0, "missing": 0}
    jobs = []
    for job in record["jobs"]:
        run = _best_of(best, _row_keys(job))
        status = run["status"] if run else "MISSING"
        counts["total"] += 1
        counts[{"SUCCEEDED": "succeeded", "RUNNING": "running", "QUEUED": "queued",
                "FAILED": "failed", "CANCELED": "canceled"}.get(status, "missing")] += 1
        if include_jobs:
            jobs.append({
                "id": job["id"],
                "imageKey": image_key(job["caseId"], job["filename"]),
                "caseId": job["caseId"],
                "filename": job["filename"],
                "zIndex": job["zIndex"],
                "channelIndex": job["channelIndex"],
                "run": _brief_run(run) if run else None,
            })
    definition = record["definition"]
    images = definition.get("images") or []
    payload = {
        "id": record["id"],
        "state": record["state"],
        "status": _derived_status(record["state"], counts),
        "createdAt": record["createdAt"],
        "updatedAt": record["updatedAt"],
        "gap": definition.get("gap", 0),
        "counts": counts,
        "caseIds": sorted({image["caseId"] for image in images}),
        "images": images if include_jobs else [
            {key: image.get(key) for key in ("key", "caseId", "filename", "channelIndex", "zCount", "gap")}
            for image in images
        ],
    }
    if include_jobs:
        payload["jobs"] = jobs
    return payload


def _derived_status(state: str, counts: dict) -> str:
    if counts["total"] and counts["succeeded"] == counts["total"]:
        return "complete"
    if state == "interrupted":
        return "interrupted"
    if counts["running"] or counts["queued"]:
        return "running"
    if counts["canceled"] or counts["missing"]:
        return "incomplete"
    return "finished-with-issues" if counts["failed"] else "complete"
