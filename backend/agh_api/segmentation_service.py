"""Validation and orchestration around the lazily imported MorphoGBM engine.

The Flask API imports this module without importing PyTorch.  Only the separate
analysis worker reaches ``morphogbm_v10.segment_plane``.
"""
from __future__ import annotations

from functools import lru_cache
import hashlib
import json
import math
from pathlib import Path

import numpy as np

from .analysis_artifacts import (
    thickness_geometry_path,
    write_manifest_atomic,
    write_mask_atomic,
    write_skeleton_atomic,
    write_thickness_geometry_atomic,
)
from .errors import BadRequest, Conflict
from .path_guard import image_path
from .tiff_service import choose_z_window, get_metadata, read_z_mip


OPERATION = "gbm-segmentation"
PIPELINE_VERSION = "morphogbm-v10-mip5-ce-p1-p99.7-v13-halo-d4-hyst-v1"


def prepare_analysis_request(config, path: Path, payload) -> tuple[dict, str]:
    if not isinstance(payload, dict):
        raise BadRequest("JSON body is required")
    unknown = sorted(set(payload).difference({"zIndex", "channelIndex"}))
    if unknown:
        raise BadRequest(f"Unsupported analysis request field: {unknown[0]}")
    if "zIndex" not in payload or "channelIndex" not in payload:
        raise BadRequest("zIndex and channelIndex are required")

    z_index = _strict_index(payload.get("zIndex"), "zIndex")
    channel_index = _strict_index(payload.get("channelIndex"), "channelIndex")
    metadata = get_metadata(path)
    z_count = max(1, int(metadata.get("zCount") or 1))
    channel_count = max(1, int(metadata.get("channelCount") or 1))
    if z_index >= z_count:
        raise BadRequest(f"zIndex must be between 0 and {z_count - 1}")
    if channel_index >= channel_count:
        raise BadRequest(f"channelIndex must be between 0 and {channel_count - 1}")

    requested_mip_z = 5 if z_count > 1 else 1
    z_window = choose_z_window(z_index, z_count, requested_mip_z)
    stat = Path(path).stat()
    checkpoint = checkpoint_identity(config.model_checkpoint)
    source = {
        "size": int(stat.st_size),
        "mtimeNs": int(stat.st_mtime_ns),
        "format": metadata.get("sourceFormat"),
        "width": int(metadata["width"]),
        "height": int(metadata["height"]),
        "zCount": z_count,
        "channelCount": channel_count,
    }
    request_payload = {
        "zIndex": z_index,
        "channelIndex": channel_index,
        "mipZRequested": requested_mip_z,
        "mipZ": len(z_window),
        "zWindow": list(z_window),
        "source": source,
        "model": checkpoint,
        "pipelineVersion": PIPELINE_VERSION,
    }
    cache_material = {
        "sourcePath": str(Path(path).resolve()),
        "source": source,
        "zIndex": z_index,
        "channelIndex": channel_index,
        "zWindow": list(z_window),
        "modelSha256": checkpoint.get("sha256"),
        "modelSize": checkpoint.get("size"),
        "pipelineVersion": PIPELINE_VERSION,
    }
    cache_key = hashlib.sha256(
        json.dumps(cache_material, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return request_payload, cache_key


def execute_segmentation(
    config,
    job: dict,
    *,
    progress=None,
    before_publish=None,
) -> dict:
    """Execute one claimed queue job and atomically publish its mask."""
    if job.get("operation") != OPERATION:
        raise ValueError(f"Unsupported analysis operation: {job.get('operation')}")
    artifact_attempt = job.get("attempts")
    if (
        isinstance(artifact_attempt, bool)
        or not isinstance(artifact_attempt, int)
        or artifact_attempt < 1
    ):
        raise RuntimeError("Analysis job is missing its claimed attempt number")
    request_payload = job.get("request") or {}
    path = image_path(config.data_root, job["case"], job["filename"])
    _assert_source_version(path, request_payload.get("source") or {})
    _report(progress, "loading", 0.02, "Reading the source Z window")

    raw_plane, actual_window = read_z_mip(
        path,
        int(request_payload["channelIndex"]),
        int(request_payload["zIndex"]),
        int(request_payload.get("mipZRequested") or 1),
    )
    expected_window = tuple(int(value) for value in request_payload.get("zWindow") or ())
    if tuple(actual_window) != expected_window:
        raise RuntimeError("Source Z geometry changed after this run was queued")
    expected_shape = (
        int(request_payload["source"]["height"]),
        int(request_payload["source"]["width"]),
    )
    if tuple(raw_plane.shape) != expected_shape:
        raise RuntimeError(
            f"Extracted plane shape {tuple(raw_plane.shape)} does not match source geometry {expected_shape}"
        )
    _assert_source_version(path, request_payload.get("source") or {})
    _assert_checkpoint_version(config.model_checkpoint, request_payload.get("model") or {})

    _report(progress, "inference", 0.05, "Running MorphoGBM v10")
    try:
        from .morphogbm_v10 import segment_plane
    except ImportError as exc:
        raise RuntimeError("MorphoGBM v10 inference support is not installed") from exc

    def model_progress(fraction, message="Running MorphoGBM v10"):
        try:
            fraction = float(fraction)
        except (TypeError, ValueError):
            fraction = 0.0
        overall = 0.05 + (max(0.0, min(1.0, fraction)) * 0.88)
        _report(progress, "inference", overall, str(message or "Running MorphoGBM v10"))

    output = segment_plane(
        raw_plane,
        Path(config.model_checkpoint),
        device=config.inference_device,
        progress=model_progress,
    )
    if not isinstance(output, dict) or "mask" not in output:
        raise RuntimeError("MorphoGBM v10 returned an invalid result")
    mask = _normalize_mask(output["mask"], expected_shape)

    _report(progress, "geometry", 0.93, "Preparing GBM thickness geometry")
    try:
        from .gbm_thickness import prepare_thickness_geometry, thickness_geometry_to_arrays
    except ImportError as exc:
        raise RuntimeError("GBM thickness geometry support is not installed") from exc
    thickness_arrays = None
    thickness_error = None
    try:
        thickness_geometry = prepare_thickness_geometry(mask)
        thickness_arrays = thickness_geometry_to_arrays(thickness_geometry)
    except ValueError as exc:
        # A valid segmentation can contain no foreground/skeleton.  Keep the
        # mask usable as an overlay and report that this run is not measurable.
        thickness_error = str(exc)

    _assert_source_version(path, request_payload.get("source") or {})
    if before_publish is not None:
        before_publish()
    _report(progress, "publishing", 0.95, "Publishing the segmentation mask")

    model_metadata = _public_model_metadata(output.get("metadata") or {})
    result = {
        "width": expected_shape[1],
        "height": expected_shape[0],
        "zIndex": int(request_payload["zIndex"]),
        "zWindow": list(actual_window),
        "mipZ": len(actual_window),
        "channelIndex": int(request_payload["channelIndex"]),
        "maskUrl": f"/agh/api/analysis-runs/{job['runId']}/mask",
        "skeletonUrl": f"/agh/api/analysis-runs/{job['runId']}/skeleton",
        "modelId": "morphogbm-v10-topology-robust",
        "modelSha256": (request_payload.get("model") or {}).get("sha256"),
        "pipelineVersion": PIPELINE_VERSION,
        "artifactAttempt": artifact_attempt,
        "thicknessGeometryAvailable": thickness_arrays is not None,
        "thicknessGeometryError": thickness_error,
        "metadata": model_metadata,
    }
    manifest = {
        "runId": job["runId"],
        "case": job["case"],
        "filename": job["filename"],
        "request": request_payload,
        "result": result,
    }
    write_mask_atomic(
        config.analysis_root,
        job["runId"],
        mask,
        attempt=artifact_attempt,
    )
    if thickness_arrays is not None:
        write_thickness_geometry_atomic(
            config.analysis_root,
            job["runId"],
            thickness_arrays,
            attempt=artifact_attempt,
        )
        write_skeleton_atomic(
            config.analysis_root,
            job["runId"],
            thickness_arrays["skeleton_y"],
            thickness_arrays["skeleton_x"],
            thickness_arrays["shape"],
            attempt=artifact_attempt,
        )
    write_manifest_atomic(
        config.analysis_root,
        job["runId"],
        manifest,
        attempt=artifact_attempt,
    )
    _report(progress, "publishing", 0.99, "Finalizing the analysis run")
    return result


def measure_run_thickness(config, run: dict, payload) -> dict:
    if run.get("status") != "SUCCEEDED":
        raise Conflict("Segmentation run is not finished")
    if (run.get("result") or {}).get("thicknessGeometryAvailable") is False:
        raise Conflict("Segmentation contains no measurable GBM thickness geometry")
    roi, calibration = validate_thickness_request(payload, run)
    try:
        from .gbm_thickness import (
            load_thickness_geometry,
            measure_gbm_thickness_from_geometry,
        )
    except ImportError as exc:
        raise RuntimeError("GBM thickness measurement support is not installed") from exc

    geometry = load_thickness_geometry(
        thickness_geometry_path(
            config.analysis_root,
            run["runId"],
            attempt=(run.get("result") or {}).get("artifactAttempt"),
        )
    )
    try:
        result = measure_gbm_thickness_from_geometry(
            geometry,
            roi["points"],
            pixel_size_x_um=calibration["pixelSizeXUm"],
            pixel_size_y_um=calibration["pixelSizeYUm"],
            expansion_factor=(
                calibration["expansionFactor"]
                if calibration["expansionEnabled"]
                else 1.0
            ),
        )
    except ValueError as exc:
        raise BadRequest(str(exc)) from exc
    if not isinstance(result, dict):
        raise RuntimeError("GBM thickness measurement returned an invalid result")
    normalized = _jsonable(result)
    mean_thickness = normalized.get("meanThickness")
    if mean_thickness is None:
        mean_thickness = normalized.get("corrected_mean_um")
    sample_count = normalized.get("sampleCount")
    if sample_count is None:
        sample_count = normalized.get("centerline_sample_count")
    return {
        "analysisRunId": run["runId"],
        "zIndex": int((run.get("request") or {}).get("zIndex") or 0),
        "roi": roi,
        "calibration": calibration,
        **normalized,
        "meanThickness": mean_thickness,
        "unit": normalized.get("unit") or "µm",
        "sampleCount": sample_count,
    }


def validate_thickness_request(payload, run: dict) -> tuple[dict, dict]:
    if not isinstance(payload, dict):
        raise BadRequest("JSON body is required")
    unknown = sorted(set(payload).difference({"roi", "calibration"}))
    if unknown:
        raise BadRequest(f"Unsupported thickness request field: {unknown[0]}")
    roi = payload.get("roi")
    calibration = payload.get("calibration")
    if not isinstance(roi, dict) or not isinstance(calibration, dict):
        raise BadRequest("roi and calibration are required")
    unknown_roi = sorted(set(roi).difference({"type", "points"}))
    if unknown_roi:
        raise BadRequest(f"Unsupported ROI field: {unknown_roi[0]}")
    if roi.get("type") != "polygon":
        raise BadRequest("ROI type must be polygon")
    points = roi.get("points")
    if not isinstance(points, list) or len(points) < 3 or len(points) > 10000:
        raise BadRequest("ROI polygon must contain between 3 and 10000 points")

    request_source = (run.get("request") or {}).get("source") or {}
    width = int(request_source.get("width") or 0)
    height = int(request_source.get("height") or 0)
    normalized_points = []
    for point in points:
        if not isinstance(point, (list, tuple)) or len(point) != 2:
            raise BadRequest("Each ROI point must be an [x, y] pair")
        x = _finite_number(point[0], "ROI x coordinate")
        y = _finite_number(point[1], "ROI y coordinate")
        if x < 0 or y < 0 or x > width or y > height:
            raise BadRequest("ROI points must lie within the source image")
        normalized_points.append([x, y])
    if abs(_polygon_area(normalized_points)) < 0.5:
        raise BadRequest("ROI polygon must have a non-zero area")

    allowed_calibration = {
        "pixelSizeXUm",
        "pixelSizeYUm",
        "expansionEnabled",
        "expansionFactor",
    }
    unknown_calibration = sorted(set(calibration).difference(allowed_calibration))
    if unknown_calibration:
        raise BadRequest(f"Unsupported calibration field: {unknown_calibration[0]}")
    if "pixelSizeXUm" not in calibration:
        raise BadRequest("calibration.pixelSizeXUm is required")
    pixel_size_x = _positive_number(calibration.get("pixelSizeXUm"), "pixelSizeXUm")
    pixel_size_y = _positive_number(
        calibration.get("pixelSizeYUm", pixel_size_x), "pixelSizeYUm"
    )
    expansion_factor = _positive_number(
        calibration.get("expansionFactor", 1.0), "expansionFactor"
    )
    expansion_enabled = calibration.get("expansionEnabled", False)
    if not isinstance(expansion_enabled, bool):
        raise BadRequest("expansionEnabled must be a boolean")
    return (
        {"type": "polygon", "points": normalized_points},
        {
            "pixelSizeXUm": pixel_size_x,
            "pixelSizeYUm": pixel_size_y,
            "expansionEnabled": expansion_enabled,
            "expansionFactor": expansion_factor,
        },
    )


def checkpoint_identity(path: Path) -> dict:
    checkpoint = Path(path)
    try:
        stat = checkpoint.stat()
    except OSError:
        return {
            "filename": checkpoint.name,
            "size": None,
            "mtimeNs": None,
            "sha256": None,
            "available": False,
        }
    digest = _checkpoint_sha256(str(checkpoint.resolve()), stat.st_size, stat.st_mtime_ns)
    return {
        "filename": checkpoint.name,
        "size": int(stat.st_size),
        "mtimeNs": int(stat.st_mtime_ns),
        "sha256": digest,
        "available": True,
    }


@lru_cache(maxsize=8)
def _checkpoint_sha256(resolved_path: str, size: int, mtime_ns: int) -> str:
    digest = hashlib.sha256()
    with open(resolved_path, "rb") as handle:
        while True:
            chunk = handle.read(4 * 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def _assert_checkpoint_version(path: Path, expected: dict) -> None:
    current = checkpoint_identity(path)
    if not current.get("available"):
        raise FileNotFoundError("MorphoGBM v10 checkpoint is not installed")
    if current.get("sha256") != expected.get("sha256"):
        raise RuntimeError("MorphoGBM checkpoint changed after this run was queued")


def _assert_source_version(path: Path, expected: dict) -> None:
    stat = Path(path).stat()
    if int(stat.st_size) != int(expected.get("size") or -1) or int(stat.st_mtime_ns) != int(
        expected.get("mtimeNs") or -1
    ):
        raise RuntimeError("Source image changed after this run was queued")


def _normalize_mask(mask, expected_shape):
    array = np.asarray(mask)
    if array.ndim != 2 or tuple(array.shape) != tuple(expected_shape):
        raise RuntimeError(
            f"MorphoGBM mask shape {tuple(array.shape)} does not match source geometry {tuple(expected_shape)}"
        )
    if not np.isfinite(array).all():
        raise RuntimeError("MorphoGBM mask contains NaN or Inf")
    unique = np.unique(array)
    if not np.all(np.isin(unique, (0, 1, False, True))):
        raise RuntimeError("MorphoGBM mask must contain only 0 and 1")
    return np.ascontiguousarray(array.astype(np.uint8))


def _report(callback, stage: str, fraction: float, message: str) -> None:
    if callback is None:
        return
    fraction = max(0.0, min(1.0, float(fraction)))
    callback(
        {
            "stage": stage,
            "fraction": round(fraction, 6),
            "percent": round(fraction * 100.0, 1),
            "message": message,
        }
    )


def _strict_index(value, label):
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise BadRequest(f"{label} must be a non-negative integer")
    return value


def _finite_number(value, label):
    if isinstance(value, bool):
        raise BadRequest(f"{label} must be a finite number")
    try:
        parsed = float(value)
    except (TypeError, ValueError) as exc:
        raise BadRequest(f"{label} must be a finite number") from exc
    if not math.isfinite(parsed):
        raise BadRequest(f"{label} must be a finite number")
    return parsed


def _positive_number(value, label):
    parsed = _finite_number(value, label)
    if parsed <= 0:
        raise BadRequest(f"{label} must be positive")
    return parsed


def _polygon_area(points) -> float:
    area = 0.0
    for index, (x1, y1) in enumerate(points):
        x2, y2 = points[(index + 1) % len(points)]
        area += (x1 * y2) - (x2 * y1)
    return area / 2.0


def _jsonable(value):
    if value is None or isinstance(value, (str, int, bool)):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            return None
        return value
    if isinstance(value, np.generic):
        return _jsonable(value.item())
    if isinstance(value, Path):
        return value.name
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    return str(value)


def _public_model_metadata(metadata):
    """Remove host paths while retaining checkpoint provenance."""
    public = _jsonable(metadata)
    if not isinstance(public, dict):
        return public
    model = public.get("model")
    if isinstance(model, dict) and model.get("checkpoint_path"):
        model["checkpoint_path"] = Path(model["checkpoint_path"]).name
    if public.get("checkpoint_path"):
        public["checkpoint_path"] = Path(public["checkpoint_path"]).name
    return public
