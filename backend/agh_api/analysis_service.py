import json
import uuid
from pathlib import Path

import tifffile

from .analysis_artifacts import metric_artifact_name, metric_directory, run_directory
from .analysis_profiles import resolve_process_watershed
from .errors import BadRequest, Conflict
from .magnifyseg_engine.metrics import (
    compute_gbm_thickness,
    compute_process_nnd,
    labels_to_contours,
    preview_process_area_filter,
)
from .magnifyseg_engine.overlays import write_binary_overlay, write_segmentation_overlays
from .magnifyseg_engine.segmentation import run_segmentation
from .path_guard import image_path
from .analysis_validation import normalize_calibration
from .tiff_service import ImageCacheService


def execute_analysis(config, store, job, segmentation_runner=run_segmentation):
    request_payload = job["request"]
    image = image_path(config.data_root, job["case"], job["filename"])
    cache = ImageCacheService(config.data_root, config.cache_root)
    metadata = cache.get_metadata(image)
    run_dir = run_directory(config.analysis_root, job["runId"])
    run_dir.mkdir(parents=True, exist_ok=True)

    manifest = _manifest(job, request_payload, metadata, image)
    _write_json(run_dir / "manifest.json", manifest)

    completed = []
    segmentation_paths = {}
    for model_name in request_payload["modelNames"]:
        store.update_progress(job["runId"], model_name, completed)
        out_path = segmentation_runner(
            image_path=image,
            workspace=run_dir,
            model_root=config.model_root,
            model_name=model_name,
            request_payload=request_payload,
        )
        segmentation_paths[model_name] = out_path
        completed.append(model_name)
        store.update_progress(job["runId"], None, completed)

    overlays = write_segmentation_overlays(segmentation_paths, run_dir)
    result = {
        "runId": job["runId"],
        "completed": completed,
        "manifest": "manifest.json",
        "segmentations": {model: path.name for model, path in segmentation_paths.items()},
        "overlays": overlays,
        "width": metadata["width"],
        "height": metadata["height"],
    }
    _write_json(run_dir / "status.json", result)
    return result


def create_metric_run(store, segmentation_run_id, operation, payload):
    if operation not in {"gbm-thickness", "process-nnd"}:
        raise BadRequest("Invalid metric operation")
    segmentation_run = _require_succeeded(store.get_run(segmentation_run_id))
    pixel_size, pixel_unit, calibration = _effective_pixel_size(segmentation_run, payload)
    if operation == "gbm-thickness":
        _nhs_segmentation_name(segmentation_run)
    else:
        _actn4_segmentation_name(segmentation_run)
    request_payload = {
        "segmentationRunId": segmentation_run_id,
        "roi": (payload or {}).get("roi"),
        "calibration": calibration,
    }
    if operation == "process-nnd":
        request_payload["watershed"] = resolve_process_watershed(
            (payload or {}).get("watershed"),
            effective_pixel_size=pixel_size,
            pixel_unit=pixel_unit,
        )
    return store.create_run(segmentation_run["case"], segmentation_run["filename"], operation, request_payload)


def create_metric_run_for_file(store, case, filename, operation, payload):
    segmentation_run = newest_segmentation_for_metric(store, case, filename, operation)
    metric_run = create_metric_run(store, segmentation_run["runId"], operation, payload)
    source_model = _source_model_for_metric(segmentation_run, operation)
    metric_run["sourceSegmentationRunId"] = segmentation_run["runId"]
    metric_run["sourceModel"] = source_model
    metric_run["sourceCreatedAt"] = segmentation_run.get("createdAt")
    return metric_run


def newest_segmentation_for_metric(store, case, filename, operation):
    if operation not in {"gbm-thickness", "process-nnd"}:
        raise BadRequest("Invalid metric operation")
    runs = store.list_runs(case, filename, operation="magnifyseg-segmentation", limit=100)
    for run in runs:
        if run.get("status") != "SUCCEEDED":
            continue
        segmentations = (run.get("result") or {}).get("segmentations") or {}
        if operation == "gbm-thickness" and any(
            name in segmentations for name in ("NHS_COMBINED_ACTN4", "NHS_SINGLE_CHANNEL")
        ):
            return run
        if operation == "process-nnd" and "ACTN4" in segmentations:
            return run
    if operation == "gbm-thickness":
        raise BadRequest("No NHS Ester segmentation is available for GBM thickness")
    raise BadRequest("No ACTN4 segmentation is available for Process NND")


def analysis_capabilities(run, calibration_override=None):
    segmentations = (run.get("result") or {}).get("segmentations") or {}
    has_actn4 = "ACTN4" in segmentations
    has_nhs = any(name in segmentations for name in ("NHS_COMBINED_ACTN4", "NHS_SINGLE_CHANNEL"))
    run_ready = run.get("status") == "SUCCEEDED"
    calibration_blocker = _calibration_blocker(run, calibration_override)

    gbm_blockers = []
    process_blockers = []
    if not run_ready:
        blocker = {
            "code": "SEGMENTATION_PENDING",
            "message": "Segmentation is still running.",
            "fixAction": "VIEW_PROGRESS",
        }
        gbm_blockers.append(blocker)
        process_blockers.append(blocker)
    if run_ready and not has_nhs:
        gbm_blockers.append({
            "code": "NHS_SEGMENTATION_REQUIRED",
            "message": "NHS segmentation is required.",
            "fixAction": "RUN_NHS_SEGMENTATION",
        })
    if run_ready and not has_actn4:
        process_blockers.append({
            "code": "ACTN4_SEGMENTATION_REQUIRED",
            "message": "ACTN4 segmentation is required.",
            "fixAction": "RUN_ACTN4_SEGMENTATION",
        })
    if calibration_blocker:
        gbm_blockers.append(calibration_blocker)
        process_blockers.append(calibration_blocker)

    return {
        "segmentation": {
            "actn4": {"available": run_ready and has_actn4},
            "nhs": {"available": run_ready and has_nhs},
        },
        "measurements": {
            "gbmThickness": {
                "available": len(gbm_blockers) == 0,
                "blockers": gbm_blockers,
            },
            "processNnd": {
                "available": len(process_blockers) == 0,
                "blockers": process_blockers,
            },
        },
    }


def execute_gbm_thickness(config, store, job):
    payload = job["request"]
    segmentation_run_id = payload["segmentationRunId"]
    segmentation_run = _require_succeeded(store.get_run(segmentation_run_id))
    run_dir = run_directory(config.analysis_root, segmentation_run_id)
    metric_dir = metric_directory(config.analysis_root, segmentation_run_id, job["runId"])
    metric_dir.mkdir(parents=True, exist_ok=True)
    _write_json(metric_dir / "request.json", payload)

    pixel_size, unit, calibration = _effective_pixel_size(segmentation_run, payload)
    nhs_name = _nhs_segmentation_name(segmentation_run)
    labels = tifffile.imread(run_dir / nhs_name)
    mask = labels == 1
    result = compute_gbm_thickness(mask, pixel_size, metric_dir, roi=payload.get("roi"))
    result.update({
        "kind": "gbm-thickness",
        "segmentationRunId": segmentation_run_id,
        "metricRunId": job["runId"],
        "unit": unit,
        "calibration": calibration,
        "artifacts": {
            "request": metric_artifact_name(job["runId"], "request.json"),
            "result": metric_artifact_name(job["runId"], "result.json"),
            "csv": metric_artifact_name(job["runId"], result["csv"]),
        },
    })
    _write_json(metric_dir / "result.json", result)
    return result


def execute_process_nnd(config, store, job):
    payload = job["request"]
    segmentation_run_id = payload["segmentationRunId"]
    segmentation_run = _require_succeeded(store.get_run(segmentation_run_id))
    run_dir = run_directory(config.analysis_root, segmentation_run_id)
    metric_dir = metric_directory(config.analysis_root, segmentation_run_id, job["runId"])
    metric_dir.mkdir(parents=True, exist_ok=True)
    _write_json(metric_dir / "request.json", payload)

    pixel_size, unit, calibration = _effective_pixel_size(segmentation_run, payload)
    seg_name = _actn4_segmentation_name(segmentation_run)
    labels = tifffile.imread(run_dir / seg_name)
    mask = labels > 0
    watershed = resolve_process_watershed(
        payload.get("watershed"),
        effective_pixel_size=pixel_size,
        pixel_unit=unit,
    )
    result = compute_process_nnd(
        mask,
        pixel_size,
        metric_dir,
        roi=payload.get("roi"),
        max_pair_px=float(watershed.get("maxPairDistance", 560.0)),
        ws_min_dist=float(watershed.get("minDistance", 150.0)),
        ws_thresh_rel=float(watershed.get("thresholdRelative", 0.26)),
        ws_sigma=float(watershed.get("sigma", 0.0)),
        min_area_percentile=float(watershed.get("minAreaPercentile", 0.0)),
        max_area_percentile=float(watershed.get("maxAreaPercentile", 100.0)),
    )
    result.update({
        "kind": "process-nnd",
        "segmentationRunId": segmentation_run_id,
        "metricRunId": job["runId"],
        "unit": unit,
        "calibration": calibration,
        "watershed": watershed,
    })
    included_overlay_filename = "proc_included_overlay.png"
    if result.get("labels"):
        write_binary_overlay(
            tifffile.imread(metric_dir / result["labels"]) > 0,
            metric_dir / included_overlay_filename,
            (0, 255, 0),
        )
        result["includedProcessOverlay"] = metric_artifact_name(job["runId"], included_overlay_filename)
    contour_artifacts = []
    contour_layers = []
    for key, filename, color, label in (
        ("outerContours", "proc_outer_contours.png", (255, 214, 10), "Original process boundary"),
        ("includedContours", "proc_included_contours.png", (0, 190, 255), "Included process labels"),
        ("excludedContours", "proc_excluded_contours.png", (220, 80, 180), "Excluded process labels"),
        ("allContours", "proc_all_contours.png", (0, 224, 255), "All watershed process labels"),
    ):
        source = result.get(key)
        if source:
            artifact = metric_artifact_name(job["runId"], filename)
            write_binary_overlay(tifffile.imread(metric_dir / source) > 0, metric_dir / filename, color, alpha=220)
            contour_artifacts.append(artifact)
            contour_layers.append({
                "id": key,
                "label": label,
                "group": "Process separation",
                "artifact": artifact,
                "defaultOpacity": 0.0 if key in {"excludedContours", "allContours"} else (0.90 if key == "includedContours" else 0.75),
            })
    result["contourOverlays"] = contour_artifacts
    result["contourLayers"] = contour_layers
    artifacts = {
        "request": metric_artifact_name(job["runId"], "request.json"),
        "result": metric_artifact_name(job["runId"], "result.json"),
        "csv": metric_artifact_name(job["runId"], result["csv"]),
    }
    for key in ("labels", "allLabels", "contours", "allContours", "includedContours", "excludedContours", "outerContours"):
        if result.get(key):
            artifacts[key] = metric_artifact_name(job["runId"], result[key])
    if result.get("includedProcessOverlay"):
        artifacts["includedProcessOverlay"] = result["includedProcessOverlay"]
    result["artifacts"] = artifacts
    _write_json(metric_dir / "result.json", result)
    return result


def create_process_area_preview(config, store, metric_run_id, payload):
    metric_run = store.get_run(metric_run_id)
    if metric_run["operation"] != "process-nnd":
        raise BadRequest("Area preview is only available for Process NND metrics")
    if metric_run["status"] != "SUCCEEDED":
        raise Conflict("Process NND metric is not finished")

    request_payload = metric_run.get("request") or {}
    result = metric_run.get("result") or {}
    segmentation_run_id = request_payload.get("segmentationRunId")
    if not segmentation_run_id:
        raise BadRequest("Process NND metric is missing its source segmentation")

    metric_dir = metric_directory(config.analysis_root, segmentation_run_id, metric_run_id)
    labels_name = result.get("allLabels") or result.get("labels")
    if not labels_name:
        raise BadRequest("Process NND metric does not contain watershed labels")

    labels = tifffile.imread(metric_dir / labels_name)
    calibration = request_payload.get("calibration") or result.get("calibration") or {}
    pixel_size = calibration.get("effectivePixelSize")
    if pixel_size is None:
        raise BadRequest("Process NND metric is missing calibration")
    watershed = request_payload.get("watershed") or result.get("watershed") or {}

    min_percentile = _percentile_value((payload or {}).get("minPercentile", 0.0), "minPercentile")
    max_percentile = _percentile_value((payload or {}).get("maxPercentile", 100.0), "maxPercentile")
    if min_percentile >= max_percentile:
        raise BadRequest("minPercentile must be lower than maxPercentile")

    preview = preview_process_area_filter(
        labels,
        float(pixel_size),
        min_percentile=min_percentile,
        max_percentile=max_percentile,
        max_pair_px=float(watershed.get("maxPairDistance", 560.0)),
    )
    revision = uuid.uuid4().hex[:8]
    included_mask_overlay_name = f"preview_{revision}_proc_included_overlay.png"
    included_outer_overlay_name = f"preview_{revision}_proc_outer_contours.png"
    included_overlay_name = f"preview_{revision}_proc_included_contours.png"
    excluded_overlay_name = f"preview_{revision}_proc_excluded_contours.png"
    included_labels = (preview["includedMask"] * labels).astype("uint16")
    excluded_labels = (preview["excludedMask"] * labels).astype("uint16")
    write_binary_overlay(
        included_labels > 0,
        metric_dir / included_mask_overlay_name,
        (0, 255, 0),
    )
    write_binary_overlay(
        labels_to_contours((included_labels > 0).astype("uint16")) > 0,
        metric_dir / included_outer_overlay_name,
        (255, 214, 10),
        alpha=220,
    )
    write_binary_overlay(
        labels_to_contours(included_labels) > 0,
        metric_dir / included_overlay_name,
        (0, 190, 255),
        alpha=220,
    )
    write_binary_overlay(
        labels_to_contours(excluded_labels) > 0,
        metric_dir / excluded_overlay_name,
        (220, 80, 180),
        alpha=220,
    )
    return {
        "previewRevision": revision,
        "meanDistance": preview["meanDistance"],
        "processCount": preview["processCount"],
        "pairCount": preview["pairCount"],
        "displayPairCount": preview["displayPairCount"],
        "displayExcludedPairCount": preview["displayExcludedPairCount"],
        "pairs": preview["pairs"],
        "displayPairs": preview["displayPairs"],
        "areaFilter": preview["areaFilter"],
        "includedMaskOverlay": metric_artifact_name(metric_run_id, included_mask_overlay_name),
        "includedOuterOverlay": metric_artifact_name(metric_run_id, included_outer_overlay_name),
        "includedOverlay": metric_artifact_name(metric_run_id, included_overlay_name),
        "excludedOverlay": metric_artifact_name(metric_run_id, excluded_overlay_name),
    }


def _require_succeeded(run):
    if run["status"] == "FAILED":
        raise Conflict("Analysis run failed")
    if run["status"] != "SUCCEEDED":
        raise Conflict("Analysis run is not finished")
    return run


def _effective_pixel_size(run, metric_payload=None):
    base = (run.get("request") or {}).get("calibration") or {}
    override = (metric_payload or {}).get("calibration") or {}
    if not isinstance(override, dict):
        raise BadRequest("Invalid calibration")

    merged = dict(base)
    if override:
        # Metric controls are allowed to override calibration without rerunning
        # segmentation. Drop previously derived values so they are recomputed
        # from the current raw size / EF or from the direct effective override.
        merged.update(override)
        merged.pop("effectivePixelSize", None)
        merged.pop("effectivePixelSizeSource", None)
    calibration = normalize_calibration(merged)
    pixel_size = calibration.get("effectivePixelSize")
    if pixel_size is None:
        raise BadRequest(
            "Physical pixel size is required for this metric. Expansion factor alone is not enough; "
            "enter the raw XY pixel size or an effective pixel size override."
        )
    return float(pixel_size), calibration.get("pixelUnit") or "um", calibration


def _calibration_blocker(run, calibration_override=None):
    try:
        _effective_pixel_size(run, {"calibration": calibration_override or {}})
        return None
    except BadRequest as exc:
        return {
            "code": "CALIBRATION_REQUIRED",
            "message": (
                "Enter the raw XY pixel size or provide the effective post-expansion size."
            ),
            "fixAction": "OPEN_CALIBRATION",
            "detail": str(exc),
        }


def _nhs_segmentation_name(run):
    segmentations = (run.get("result") or {}).get("segmentations") or {}
    for model_name in ("NHS_COMBINED_ACTN4", "NHS_SINGLE_CHANNEL"):
        if model_name in segmentations:
            return segmentations[model_name]
    raise BadRequest("GBM thickness requires an NHS segmentation")


def _actn4_segmentation_name(run):
    seg_name = (run.get("result") or {}).get("segmentations", {}).get("ACTN4")
    if not seg_name:
        raise BadRequest("Process NND requires an ACTN4 segmentation")
    return seg_name


def _source_model_for_metric(run, operation):
    segmentations = (run.get("result") or {}).get("segmentations") or {}
    if operation == "gbm-thickness":
        if "NHS_COMBINED_ACTN4" in segmentations:
            return "NHS_COMBINED_ACTN4"
        if "NHS_SINGLE_CHANNEL" in segmentations:
            return "NHS_SINGLE_CHANNEL"
    if operation == "process-nnd" and "ACTN4" in segmentations:
        return "ACTN4"
    return None


def _percentile_value(value, label):
    try:
        parsed = float(value)
    except (TypeError, ValueError) as exc:
        raise BadRequest(f"Invalid {label}") from exc
    if parsed < 0 or parsed > 100:
        raise BadRequest(f"{label} must be between 0 and 100")
    return parsed


def _manifest(job, request_payload, metadata, image: Path):
    stat = image.stat()
    return {
        "runId": job["runId"],
        "case": job["case"],
        "filename": job["filename"],
        "source": {
            "size": stat.st_size,
            "mtimeNs": stat.st_mtime_ns,
            "cacheKey": metadata.get("cacheKey"),
        },
        "input": {
            "zIndex": request_payload["zIndex"],
            "channels": request_payload["channels"],
        },
        "models": request_payload["modelNames"],
        "preprocessing": _preprocessing_manifest(request_payload.get("preprocessingMode", "percentile-stretch")),
        "calibration": request_payload["calibration"],
    }


def _preprocessing_manifest(mode):
    if mode in {"percentile-stretch", "magnifyseg-enhanced"}:
        return {
            "mode": "percentile-stretch",
            "normalizeByMax": False,
            "percentileLow": 1.0,
            "percentileHigh": 99.7,
            "modelInputScale": "uint8/255",
        }
    return {
        "mode": "direct-uint8",
        "normalizeByMax": False,
        "percentileStretch": False,
        "modelInputScale": "uint8/255",
    }


def _write_json(path, payload):
    with Path(path).open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.write("\n")
