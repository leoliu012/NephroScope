"""Stack analysis jobs, per-plane decisions and human corrections for GBM predictions.

The model's saved mask is never changed. What counts as measurable GBM is derived
on request from three things: the saved prediction, the stack analysis in
:mod:`gbm_cross_section`, and a list of corrections people have made. Removing the
corrections restores the model's prediction exactly.

A click is a suggestion, and it changes thresholds around it:

* Marking excluded GBM as real pins that piece and relaxes the tilt limit nearby,
  in 3D, up to the clicked piece's tilt, so similar neighbours come back too.
* Marking GBM as wrong pins that piece out and tightens the limit nearby in the
  same way.
* Clicking where the model predicted nothing lowers the *probability* threshold
  around the click to take in what is there (see :func:`find_region_at_click`).

A brush stroke is an instruction: exactly the centerline under it is kept or
removed, and nothing nearby changes. Where a keeping stroke crosses background, it
adds what the probability map shows under the brush (see :func:`region_under_band`).
"""
from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import lru_cache
from io import BytesIO
import hashlib
import json
import logging
import math
from pathlib import Path
import threading
import time
from typing import Any

import numpy as np
from PIL import Image, ImageDraw

from .analysis_artifacts import (
    attempt_directory,
    probability_path,
    read_mask,
    read_probability,
    resolve_under_root,
    thickness_geometry_path,
    write_bytes_atomic,
)
from .errors import BadRequest, Conflict, ServiceUnavailable
from .gbm_cross_section import (
    ALGORITHM_VERSION,
    DEFAULT_MAX_THICKNESS_NM,
    DEFAULT_MAX_WINDOW,
    DEFAULT_MIN_THICKNESS_NM,
    MIP_PLANES,
    REASON_ARTIFACT,
    REASON_KEPT,
    REASON_MANUAL,
    REASON_NAMES,
    SAMPLE_OK,
    FilterSettings,
    PlaneAnalysis,
    FieldMotion,
    StackPlane,
    analyze_stack,
    build_pieces,
    decide_from_evidence,
    decide_jointly,
    estimate_field_motion,
    piece_evidence,
    to_plane,
    to_shared,
)
from .gbm_thickness import ThicknessGeometry, load_thickness_geometry, thickness_geometry_to_arrays
from .path_guard import image_path

log = logging.getLogger(__name__)

STACK_OPERATION = "gbm-stack-analysis"
PAINT_KINDS = ("paint-keep", "paint-remove")
# Corrections that change the plane's mask or pieces, not only decisions about them.
STRUCTURAL_KINDS = ("add", *PAINT_KINDS)
MAX_STROKE_POINTS = 5000
# Browsers keep filtered measurements under a token. Evidence from an analysis stays
# valid when only the decision rules change, so the rules have their own version.
DECISION_VERSION = "d3"
SEGMENTATION_OPERATION = "gbm-segmentation"
MAX_WINDOW_LIMIT = 200
# A correction's influence falls off over this many typical thicknesses (Gaussian
# sigma) and stops below CORRECTION_MIN_WEIGHT, so far-away pieces stay untouched.
CORRECTION_RADIUS_THICKNESSES = 4.0
CORRECTION_MIN_WEIGHT = 0.25
# Removing a piece only says "this tilt is too much" when its tilt is near the
# limit. A wrong piece that is nearly vertical is wrong for some other reason.
TIGHTEN_FROM_LIMIT_FRACTION = 0.6
BASE_PROBABILITY_THRESHOLD = 0.55
# Decisions are made for a whole stack at once, so the last few stacks decided are kept.
STACK_DECISION_CACHE = 16
_stack_decisions: OrderedDict = OrderedDict()
_stack_decisions_lock = threading.Lock()


def _digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def _source_key(path: Path) -> str:
    stat = Path(path).stat()
    return f"{int(stat.st_size)}:{int(stat.st_mtime_ns)}"


def parse_filter(raw: Any) -> tuple[FilterSettings, dict] | None:
    """Validate a request's filter options; ``None`` means the raw prediction."""
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise BadRequest("filter must be an object")

    def number(name, low, high, default=None):
        value = raw.get(name, default)
        if value is None:
            return None
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise BadRequest(f"filter.{name} must be a number")
        if not low <= value <= high:
            raise BadRequest(f"filter.{name} must be between {low} and {high}")
        return float(value)

    settings = FilterSettings(
        cross_section=raw.get("crossSection", True) is not False,
        max_tilt_deg=number("maxTiltDeg", 1, 89),
        thickness_limits=raw.get("thicknessLimits", True) is not False,
        min_nm=number("minNm", 0, 100000, DEFAULT_MIN_THICKNESS_NM),
        max_nm=number("maxNm", 0, 1000000, DEFAULT_MAX_THICKNESS_NM),
    )
    if settings.min_nm >= settings.max_nm:
        raise BadRequest("filter.minNm must be below filter.maxNm")
    window = number("window", 1, MAX_WINDOW_LIMIT, DEFAULT_MAX_WINDOW)
    options = {
        "window": int(window),
        "zStepUm": number("zStepUm", 1e-4, 1000),
    }
    return settings, options


def _members(store, config, case: str, filename: str, channel: int, path: Path) -> tuple[list[dict], bool]:
    stat = Path(path).stat()
    runs = store.list_latest_runs_by_z(
        case, filename, operation=SEGMENTATION_OPERATION,
        source_identity={"size": int(stat.st_size), "mtimeNs": int(stat.st_mtime_ns)},
        channel_index=channel,
    )
    members, active = [], False
    for run in runs:
        if run["status"] in ("QUEUED", "RUNNING"):
            active = True
        if run["status"] != "SUCCEEDED" or (run.get("result") or {}).get("thicknessGeometryAvailable") is False:
            continue
        window = (run.get("request") or {}).get("zWindow") or [run["zIndex"]]
        members.append({
            "zIndex": int(run["zIndex"]),
            "runId": run["runId"],
            "attempt": (run.get("result") or {}).get("artifactAttempt"),
            "center": (min(window) + max(window)) / 2.0,
            "mipZ": len(window),
        })
    return members, active


def stack_state(
    config, store, case: str, filename: str, channel: int,
    *, window: int = DEFAULT_MAX_WINDOW, ensure: bool = False, retry: bool = False, memo: dict | None = None,
) -> dict:
    """Where the stack analysis of one image and channel stands.

    A new analysis waits until no segmentation of this image is running, so a
    long batch does not recompute after every finished slice. Meanwhile an older
    analysis is still used for the planes it covers. A failed analysis is only
    run again when asked to (``retry``); requests would otherwise keep queueing it.
    """
    memo_key = (case, filename, int(channel), int(window), bool(ensure))
    if memo is not None and memo_key in memo:
        return memo[memo_key]
    path = image_path(config.active_data_root, case, filename)
    members, active = _members(store, config, case, filename, channel, path)
    state = {
        "case": case, "filename": filename, "channelIndex": channel, "window": window,
        "planes": len(members), "activeSegmentation": active,
        "state": "none", "job": None, "usable": None, "stale": False,
    }
    if memo is not None:
        memo[memo_key] = state
    if not members:
        return state
    request = {
        "zIndex": -1, "channelIndex": channel, "window": window, "members": members,
        "algorithm": ALGORITHM_VERSION, "sourceKey": _source_key(path),
    }
    key = _digest({"case": case, "filename": filename, **request})
    job = store.best_runs_for_cache_keys([key]).get(key)
    wanted = job is None or job["status"] == "CANCELED" or (job["status"] == "FAILED" and retry)
    if wanted and (ensure or retry) and not active:
        job, _ = store.create_or_reuse_run(case, filename, STACK_OPERATION, request, cache_key=key, requested_by="")
    if job is not None and job["status"] == "SUCCEEDED":
        state.update(state="ready", usable=store.get_run(job["runId"]))
        state["job"] = {"runId": job["runId"], "status": job["status"], "progress": job.get("progress")}
        return state
    previous = store.latest_stack_run(case, filename, channel, window, operation=STACK_OPERATION)
    if previous is not None and all((previous.get("request") or {}).get(name) == request[name] for name in ("sourceKey", "algorithm")):
        state.update(usable=previous, stale=True)
    if job is not None and job["status"] != "CANCELED":
        state["job"] = {"runId": job["runId"], "status": job["status"], "progress": job.get("progress"),
                        "error": job.get("error"), "heartbeatAgeSeconds": _seconds_since(job.get("heartbeatAt"))}
        state["state"] = {"QUEUED": "queued", "RUNNING": "running"}.get(job["status"], "failed")
    else:
        state["state"] = "waiting" if active else "none"
    return state


def filter_token(state: dict, revision: str, cross_section: bool) -> str | None:
    """Identifies a filtered result while it stays valid; ``None`` means do not cache."""
    stack = state.get("usable")
    if stack is not None and not state["stale"]:
        return f"{stack['runId']}:{revision}:{DECISION_VERSION}"
    if not cross_section and revision == "0":
        return "limits"
    return None


def filter_tokens(config, store, runs: dict[str, dict], settings: FilterSettings, options: dict) -> dict:
    """Cheap validity check for results a browser cached, without measuring again.

    Also starts a Z analysis that has become due, because a browser waiting for
    one polls this rather than measuring every slice again.
    """
    memo: dict = {}
    revisions: dict = {}
    tokens: dict[str, str | None] = {}
    states: dict[str, str] = {}
    window = int(options.get("window") or DEFAULT_MAX_WINDOW)
    for run_id, run in runs.items():
        if run.get("status") != "SUCCEEDED" or run.get("operation") != SEGMENTATION_OPERATION:
            tokens[run_id] = None
            continue
        case, filename, channel = run["case"], run["filename"], int(run["channelIndex"])
        state = stack_state(config, store, case, filename, channel, window=window, ensure=True, memo=memo)
        image = (case, filename, channel)
        if image not in revisions:
            path = image_path(config.active_data_root, case, filename)
            revisions[image] = edits_revision(store.list_prediction_edits(case, filename, channel, _source_key(path)))
        tokens[run_id] = filter_token(state, revisions[image], settings.cross_section)
        states[run_id] = state["state"]
    return {"tokens": tokens, "states": states}


def _seconds_since(stamp: str | None) -> float | None:
    if not stamp:
        return None
    try:
        then = datetime.fromisoformat(stamp)
    except ValueError:
        return None
    return max(0.0, (datetime.now(timezone.utc) - then).total_seconds())


def _plane_path(config, stack_run: dict, z_index: int) -> Path:
    attempt = (stack_run.get("result") or {}).get("artifactAttempt")
    directory = attempt_directory(config.analysis_root, stack_run["runId"], attempt)
    return resolve_under_root(directory, f"plane_{int(z_index)}.npz")


def _label_path(config, stack_run: dict, z_index: int) -> Path:
    attempt = (stack_run.get("result") or {}).get("artifactAttempt")
    directory = attempt_directory(config.analysis_root, stack_run["runId"], attempt)
    return resolve_under_root(directory, f"label_{int(z_index)}.png")


# Deciding a stack reads every plane of it, so one stack's planes should all fit.
@lru_cache(maxsize=256)
def _load_plane_cached(path_text: str, mtime_ns: int) -> PlaneAnalysis:
    with np.load(path_text, allow_pickle=False) as archive:
        return PlaneAnalysis.from_arrays(archive)


def load_plane(config, stack_run: dict, z_index: int) -> PlaneAnalysis | None:
    path = _plane_path(config, stack_run, z_index)
    if not path.is_file():
        return None
    return _load_plane_cached(str(path), path.stat().st_mtime_ns)


def _encode_label(geometry: ThicknessGeometry, mask: np.ndarray, piece: np.ndarray, artifact: np.ndarray) -> bytes:
    """Piece id of every mask pixel (R + 256 G, 0 = none).

    B marks the centerline: 255 for measured samples, 128 for skeleton artifacts
    (tapers, spurs, junctions), which never count while filtering.
    """
    from scipy.ndimage import distance_transform_edt

    height, width = geometry.shape
    output = np.zeros((height, width, 3), dtype=np.uint8)
    y, x = geometry.skeleton_y, geometry.skeleton_x
    if y.size:
        skeleton = np.zeros((height, width), dtype=bool)
        skeleton[y, x] = True
        sample = np.full((height, width), -1, dtype=np.int32)
        sample[y, x] = np.arange(y.size, dtype=np.int32)
        nearest = distance_transform_edt(~skeleton, return_distances=False, return_indices=True)
        owner = sample[nearest[0], nearest[1]]
        ids = np.where(np.asarray(mask, dtype=bool), piece[owner] + 1, 0)
        output[..., 0] = ids & 255
        output[..., 1] = ids >> 8
        output[y, x, 2] = np.where(artifact == SAMPLE_OK, 255, 128)
    payload = BytesIO()
    Image.fromarray(output, mode="RGB").save(payload, format="PNG", compress_level=6)
    return payload.getvalue()


def _save_plane(path: Path, analysis: PlaneAnalysis) -> None:
    payload = BytesIO()
    arrays = analysis.to_arrays()
    arrays["algorithm_version"] = np.asarray([ALGORITHM_VERSION], dtype="U64")
    np.savez_compressed(payload, **arrays)
    write_bytes_atomic(path, payload.getvalue())


def execute_stack_analysis(config, job: dict, *, progress=None, before_publish=None) -> dict:
    """Worker entry point: measure orientation evidence for a whole image."""
    request = job.get("request") or {}
    members = request.get("members") or []
    attempt = job.get("attempts")
    if isinstance(attempt, bool) or not isinstance(attempt, int) or attempt < 1:
        raise RuntimeError("Stack analysis job is missing its claimed attempt number")

    def report(fraction, message):
        if progress:
            fraction = float(np.clip(fraction, 0.0, 1.0))
            progress({"stage": "stack", "fraction": fraction, "percent": round(fraction * 100.0, 1), "message": message})

    motion, measured = _measure_field_motion(config, job, members, lambda fraction, message: report(0.08 * fraction, message))
    planes = []
    for index, member in enumerate(members):
        geometry = load_thickness_geometry(thickness_geometry_path(
            config.analysis_root, member["runId"], attempt=member.get("attempt"),
        ))
        mask = read_mask(config.analysis_root, member["runId"], attempt=member.get("attempt"))
        registration = motion.at(float(member["center"])) if motion is not None else None
        planes.append(StackPlane(int(member["zIndex"]), float(member["center"]), mask, geometry, registration))
        report(0.08 + 0.02 * (index + 1) / len(members), "Reading saved Z predictions")

    started = time.monotonic()
    results = analyze_stack(
        planes,
        max_window=int(request.get("window") or DEFAULT_MAX_WINDOW),
        progress=lambda fraction, message: report(0.1 + 0.75 * fraction, message),
    )
    log.info("Stack analysis %s measured %d planes in %.1fs; saving", job["runId"], len(planes), time.monotonic() - started)
    directory = attempt_directory(config.analysis_root, job["runId"], attempt, create=True)
    reach = []
    for index, plane in enumerate(planes):
        analysis = results[plane.z_index]
        _save_plane(resolve_under_root(directory, f"plane_{plane.z_index}.npz"), analysis)
        write_bytes_atomic(
            resolve_under_root(directory, f"label_{plane.z_index}.png"),
            _encode_label(plane.geometry, plane.mask, analysis.sample_piece, analysis.sample_artifact),
        )
        if analysis.sample_piece.size:
            reach.append(analysis.sample_window_planes)
        report(0.85 + 0.15 * (index + 1) / len(planes), "Saving Z analysis")
    if before_publish:
        before_publish()
    reach_all = np.concatenate(reach) if reach else np.empty(0)
    return {
        "algorithm": ALGORITHM_VERSION,
        "artifactAttempt": attempt,
        "planes": len(planes),
        "window": int(request.get("window") or DEFAULT_MAX_WINDOW),
        "medianReachPlanes": float(np.median(reach_all)) if reach_all.size else 0.0,
        "fieldMotion": _motion_summary(motion, measured),
    }


def _measure_field_motion(config, job: dict, members: list[dict], progress) -> tuple[FieldMotion | None, bool]:
    """How the field moved through this stack, and whether that could be measured.

    Tilt can still be measured without it, and is only wrong on stacks where the field
    moves, so a stack that cannot be read is not a reason to fail. The result says so instead.
    """
    if len(members) < 2:
        return None, True
    from .tiff_service import read_channel_plane

    centers = [float(member["center"]) for member in members]
    try:
        path = image_path(config.active_data_root, job["case"], job["filename"])
        channel = int(job["request"]["channelIndex"])
        motion = estimate_field_motion(
            lambda z: read_channel_plane(path, channel, z), math.floor(min(centers)), math.ceil(max(centers)), progress=progress,
        )
    except Exception:
        log.warning("Could not measure field motion for stack analysis %s", job.get("runId"), exc_info=True)
        return None, False
    return motion, motion is not None


def _motion_summary(motion: FieldMotion | None, measured: bool) -> dict:
    """What a saved analysis keeps about field motion: enough to report it and to use it."""
    rates = motion.px_per_plane() if motion is not None else np.empty(0)
    return {
        "measured": bool(measured),
        "corrected": bool(rates.size and rates.max() > 0.0),
        "medianPxPerPlane": round(float(np.median(rates)), 3) if rates.size else 0.0,
        "maxPxPerPlane": round(float(rates.max()), 3) if rates.size else 0.0,
        "z": [] if motion is None else [float(value) for value in motion.z],
        "registration": [] if motion is None else [[round(float(value), 6) for value in row] for row in motion.registration.reshape(motion.z.size, -1)],
        "shape": [] if motion is None else [int(size) for size in motion.shape],
    }


def _saved_motion(stack_run: dict | None) -> FieldMotion | None:
    saved = ((stack_run or {}).get("result") or {}).get("fieldMotion") or {}
    if not saved.get("corrected"):
        return None
    return FieldMotion(
        np.asarray(saved["z"], dtype=np.float64),
        np.asarray(saved["registration"], dtype=np.float64).reshape(-1, 2, 3),
        tuple(saved["shape"]),
    )


def resolve_z_step(config, run: dict, override: float | None) -> dict:
    """The Z step to use: entered by a person, from the file, or unknown.

    It is never guessed from the image. Estimates from assumed orientation
    statistics were off by up to five times on test stacks, which would exclude
    good GBM; the classifier has a criterion that needs no Z step instead.
    """
    if override:
        return {"um": float(override), "source": "entered"}
    from .segmentation_service import _cached_metadata

    path = image_path(config.active_data_root, run["case"], run["filename"])
    stat = Path(path).stat()
    metadata = _cached_metadata(str(Path(path).resolve()), int(stat.st_size), int(stat.st_mtime_ns))
    if metadata.get("zStepUm"):
        return {"um": float(metadata["zStepUm"]), "source": "metadata"}
    return {"um": None, "source": None}


def _mean_pixel(calibration: dict) -> float:
    return 0.5 * (float(calibration["pixelSizeXUm"]) + float(calibration["pixelSizeYUm"]))


def _expansion(calibration: dict) -> float:
    return float(calibration["expansionFactor"]) if calibration.get("expansionEnabled") else 1.0


def edits_revision(edits: list[dict]) -> str:
    return _digest([edit["id"] for edit in edits])[:16] if edits else "0"


def _nearest_sample(geometry: ThicknessGeometry, x: float, y: float) -> tuple[int, float]:
    if geometry.skeleton_y.size == 0:
        return -1, math.inf
    d2 = (geometry.skeleton_x.astype(np.float64) - x) ** 2 + (geometry.skeleton_y.astype(np.float64) - y) ** 2
    index = int(d2.argmin())
    return index, math.sqrt(float(d2[index]))


def _local_limits(
    analysis: PlaneAnalysis, base_limit: float | None, edits: list[dict], z_index: int, pixel_size_um: float, z_step_um: float | None, reference_px: float,
    motion: FieldMotion | None = None,
) -> tuple[np.ndarray | None, np.ndarray]:
    """Per-piece tilt limit and vouched-for reasons from nearby corrections.

    With no Z step there is no angle to adjust, so only the reasons carry over. A
    correction made on another plane reaches the same place in the sample, which
    field motion may have moved in this plane.
    """
    count = analysis.piece_samples.size
    field_ = None if base_limit is None else np.full(count, float(base_limit))
    trusted = np.full(count, -1, dtype=np.int32)
    if not edits or count == 0:
        return field_, trusted
    radius = max(CORRECTION_RADIUS_THICKNESSES * reference_px, 40.0)
    axial = (float(z_step_um) / float(pixel_size_um)) if z_step_um else 0.0
    x = np.asarray(analysis.piece_center_x, dtype=np.float64)
    y = np.asarray(analysis.piece_center_y, dtype=np.float64)
    tighten_floor = 0.0 if base_limit is None else TIGHTEN_FROM_LIMIT_FRACTION * float(base_limit)
    for edit in edits:
        if edit["kind"] not in ("include", "exclude"):
            continue
        payload = edit.get("payload") or {}
        tilt = payload.get("tiltDeg")
        edit_x, edit_y = float(edit["x"]), float(edit["y"])
        if motion is not None:
            edit_y, edit_x = to_plane(motion.at(float(z_index)), *to_shared(motion.at(float(edit["zIndex"])), edit_y, edit_x))
        distance2 = (x - edit_x) ** 2 + (y - edit_y) ** 2 + ((z_index - edit["zIndex"]) * axial) ** 2
        weight = np.nan_to_num(np.exp(-distance2 / (2.0 * radius * radius)))
        weight[weight < CORRECTION_MIN_WEIGHT] = 0.0
        if tilt is not None and field_ is not None:
            if edit["kind"] == "include":
                field_ += weight * np.maximum(float(tilt) + 3.0 - field_, 0.0)
            elif float(tilt) >= tighten_floor:
                field_ += weight * np.minimum(max(float(tilt) - 3.0, tighten_floor) - field_, 0.0)
        if edit["kind"] == "include" and payload.get("reason") not in (None, REASON_KEPT, REASON_MANUAL):
            trusted[weight > 0.5] = int(payload["reason"])
    return field_, trusted


def _new_plane_from_geometry(geometry: ThicknessGeometry, base: PlaneAnalysis | None, base_geometry: ThicknessGeometry | None) -> tuple[PlaneAnalysis, np.ndarray]:
    """Pieces for an edited plane, carrying evidence over from the original samples."""
    from scipy.spatial import cKDTree

    piece, artifact, edges = build_pieces(geometry)
    count = geometry.skeleton_y.size
    piece_count = int(piece.max()) + 1 if count else 0
    tan_chord = np.full(count, np.nan)
    tan_drift = np.full(count, np.nan)
    tan_error = np.full(count, np.nan)
    censored = np.ones(count, dtype=bool)
    planes = np.full(count, np.nan)
    reach = np.zeros(count)
    added = np.ones(count, dtype=bool)
    origin = np.full(piece_count, -1, dtype=np.int32)
    neighbour_planes = 0
    if base is not None and base_geometry is not None and base_geometry.skeleton_y.size and count:
        tree = cKDTree(np.column_stack([base_geometry.skeleton_y, base_geometry.skeleton_x]))
        distance, nearest = tree.query(np.column_stack([geometry.skeleton_y, geometry.skeleton_x]), distance_upper_bound=4.0)
        found = np.isfinite(distance)
        tan_chord[found] = base.sample_tan_chord[nearest[found]]
        tan_drift[found] = base.sample_tan_drift[nearest[found]]
        tan_error[found] = base.sample_tan_error[nearest[found]]
        censored[found] = base.sample_chord_censored[nearest[found]]
        planes[found] = base.sample_chord_planes[nearest[found]]
        reach[found] = base.sample_window_planes[nearest[found]]
        added = ~found
        neighbour_planes = base.neighbour_planes
        if found.any():
            # The original piece most of each new piece's centerline came from.
            pairs, shared = np.unique(
                np.stack([piece[found].astype(np.int64), base.sample_piece[nearest[found]].astype(np.int64)], axis=1), axis=0, return_counts=True,
            )
            order = np.lexsort((shared, pairs[:, 0]))
            pairs = pairs[order]
            most = np.concatenate([pairs[1:, 0] != pairs[:-1, 0], [True]])
            origin[pairs[most, 0]] = pairs[most, 1]
    from .gbm_cross_section import _aggregate, _component_aspect

    clean = artifact == SAMPLE_OK
    width = geometry.local_thickness_pixels.astype(np.float64)
    median_width = float(np.median(width)) if count else 0.0
    analysis = PlaneAnalysis(
        z_index=base.z_index if base is not None else -1,
        shape=tuple(geometry.shape),
        sample_piece=piece,
        sample_artifact=artifact,
        sample_tan_chord=tan_chord,
        sample_tan_drift=tan_drift,
        sample_tan_error=tan_error,
        sample_chord_censored=censored,
        sample_chord_planes=planes,
        sample_window_planes=reach,
        piece_samples=np.bincount(piece, minlength=piece_count) if count else np.empty(0, dtype=np.int64),
        piece_center_x=_aggregate(piece, piece_count, geometry.skeleton_x.astype(np.float64), clean),
        piece_center_y=_aggregate(piece, piece_count, geometry.skeleton_y.astype(np.float64), clean),
        piece_width_px=_aggregate(piece, piece_count, width, clean),
        piece_tan_chord=_aggregate(piece, piece_count, tan_chord, clean),
        piece_tan_drift=_aggregate(piece, piece_count, tan_drift, clean),
        piece_tan_error=_aggregate(piece, piece_count, tan_error, clean),
        piece_track_planes=_aggregate(piece, piece_count, planes, clean),
        piece_censored=_aggregate(piece, piece_count, censored.astype(np.float64), clean),
        piece_chord_planes=_aggregate(piece, piece_count, planes, clean),
        piece_artifact=_aggregate(piece, piece_count, (~clean).astype(np.float64), np.ones(count, dtype=bool)),
        piece_component_aspect=_aggregate(piece, piece_count, _component_aspect(geometry, median_width), clean),
        piece_cc_samples=np.full(piece_count, 10**9, dtype=np.int64),
        piece_cc_span=np.full(piece_count, 10**6, dtype=np.float64),
        piece_edges=edges,
        neighbour_planes=neighbour_planes,
        median_width_px=base.median_width_px if base is not None else median_width,
        piece_origin=origin,
    )
    piece_added = _aggregate(piece, piece_count, added.astype(np.float64), np.ones(count, dtype=bool)) >= 0.5
    return analysis, piece_added


def _rle_encode(region: np.ndarray) -> dict:
    ys, xs = np.nonzero(region)
    if ys.size == 0:
        return {"y": 0, "x": 0, "h": 0, "w": 0, "runs": []}
    y0, y1, x0, x1 = int(ys.min()), int(ys.max()) + 1, int(xs.min()), int(xs.max()) + 1
    flat = region[y0:y1, x0:x1].ravel().astype(np.int8)
    change = np.nonzero(np.diff(np.concatenate([[0], flat, [0]])))[0]
    return {"y": y0, "x": x0, "h": y1 - y0, "w": x1 - x0, "runs": change.tolist()}


def _rle_paint(target: np.ndarray, rle: dict) -> None:
    if not rle.get("h"):
        return
    flat = np.zeros(int(rle["h"]) * int(rle["w"]), dtype=bool)
    runs = rle["runs"]
    for start, stop in zip(runs[0::2], runs[1::2]):
        flat[int(start):int(stop)] = True
    y0, x0 = int(rle["y"]), int(rle["x"])
    window = target[y0:y0 + int(rle["h"]), x0:x0 + int(rle["w"])]
    window |= flat.reshape(int(rle["h"]), int(rle["w"]))[: window.shape[0], : window.shape[1]]


@dataclass
class PlaneView:
    """Everything needed to judge or measure one plane."""

    geometry: ThicknessGeometry
    analysis: PlaneAnalysis | None
    stack_run: dict | None
    state: dict
    edits: list[dict]
    all_edits: list[dict]
    piece_added: np.ndarray | None
    piece_paint: np.ndarray | None
    piece_paint_edit: np.ndarray | None
    revision: str


def _effective_directory(config, run: dict, key: str) -> Path:
    attempt = (run.get("result") or {}).get("artifactAttempt")
    directory = attempt_directory(config.analysis_root, run["runId"], attempt)
    return resolve_under_root(directory, f"effective_{key}")


def plane_view(config, store, run: dict, options: dict, *, ensure: bool = True) -> PlaneView:
    """Load the plane's geometry and evidence, applying any added regions."""
    case, filename = run["case"], run["filename"]
    channel, z_index = int(run["channelIndex"]), int(run["zIndex"])
    state = stack_state(
        config, store, case, filename, channel,
        window=int(options.get("window") or DEFAULT_MAX_WINDOW), ensure=ensure, memo=options.get("memo"),
    )
    stack_run = state.get("usable")
    attempt = (run.get("result") or {}).get("artifactAttempt")
    geometry = load_thickness_geometry(thickness_geometry_path(config.analysis_root, run["runId"], attempt=attempt))
    analysis = load_plane(config, stack_run, z_index) if stack_run else None
    # An analysis older than this run's mask describes different samples.
    if analysis is not None and analysis.sample_piece.size != geometry.skeleton_y.size:
        analysis = None
    path = image_path(config.active_data_root, case, filename)
    all_edits = store.list_prediction_edits(case, filename, channel, _source_key(path))
    edits = [edit for edit in all_edits if edit["zIndex"] == z_index]
    structural = [edit for edit in edits if edit["kind"] in STRUCTURAL_KINDS]
    piece_added = piece_paint = piece_paint_edit = None
    if structural:
        geometry, analysis, piece_added, piece_paint, piece_paint_edit = _effective_plane(
            config, run, geometry, analysis, structural, stack_run,
        )
    return PlaneView(geometry, analysis, stack_run, state, edits, all_edits, piece_added, piece_paint, piece_paint_edit, edits_revision(all_edits))


def _require_scipy() -> None:
    """Added regions are re-skeletonized in the web API, which needs these packages."""
    try:
        import scipy.ndimage  # noqa: F401
        import skimage.morphology  # noqa: F401
    except ImportError as exc:
        raise ServiceUnavailable(
            "Adding GBM needs scipy and scikit-image on the API server; install backend/requirements.txt"
        ) from exc


def _effective_key(structural: list[dict], stack_run: dict | None) -> str:
    return _digest({"edits": [edit["id"] for edit in structural], "stack": (stack_run or {}).get("runId"), "algorithm": ALGORITHM_VERSION})[:20]


def stroke_band(stroke: list, radius: float, shape: tuple[int, int]) -> np.ndarray:
    """Pixels under a brush stroke."""
    height, width = shape
    image = Image.new("1", (width, height), 0)
    draw = ImageDraw.Draw(image)
    points = [(float(x), float(y)) for x, y in stroke]
    if len(points) > 1:
        draw.line(points, fill=1, width=max(1, int(round(2.0 * radius))))
    for x, y in points:
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=1)
    return np.asarray(image, dtype=bool)


def _sample_owner(geometry: ThicknessGeometry) -> np.ndarray:
    """Index of the nearest centerline sample of every pixel."""
    from scipy.ndimage import distance_transform_edt

    height, width = geometry.shape
    skeleton = np.ones((height, width), dtype=bool)
    skeleton[geometry.skeleton_y, geometry.skeleton_x] = False
    nearest = distance_transform_edt(skeleton, return_distances=False, return_indices=True)
    sample = np.zeros((height, width), dtype=np.int32)
    sample[geometry.skeleton_y, geometry.skeleton_x] = np.arange(geometry.skeleton_y.size, dtype=np.int32)
    return sample[nearest[0], nearest[1]]


def _split_for_paint(
    analysis: PlaneAnalysis, geometry: ThicknessGeometry, mask: np.ndarray, strokes: list[dict], piece_added: np.ndarray,
) -> tuple[PlaneAnalysis, np.ndarray, np.ndarray, np.ndarray]:
    """Make painted centerline its own pieces, so a stroke acts on exactly what it covers.

    A sample is painted when a stroke covers mask pixels it owns: the same rule that
    colours the overlay. Later strokes win. New pieces keep the tilt evidence of the
    piece they came from.
    """
    from .gbm_cross_section import _aggregate

    count = geometry.skeleton_y.size
    state = np.zeros(count, dtype=np.int64)
    latest = np.full(count, -1, dtype=np.int64)
    empty = np.empty(0, dtype=np.int64)
    if count == 0:
        return analysis, piece_added, empty, empty
    owner = _sample_owner(geometry)
    for index, edit in enumerate(strokes):
        payload = edit.get("payload") or {}
        band = stroke_band(payload.get("stroke") or [], float(payload.get("radius") or 1.0), tuple(geometry.shape))
        touched = np.unique(owner[band & mask])
        state[touched] = 1 if edit["kind"] == "paint-keep" else 2
        latest[touched] = index
    keys = np.stack([analysis.sample_piece.astype(np.int64), state, latest], axis=1)
    _, first, inverse = np.unique(keys, axis=0, return_index=True, return_inverse=True)
    inverse = inverse.reshape(-1).astype(np.int32)
    source = analysis.sample_piece[first]
    new_count = first.size
    clean = analysis.sample_artifact == SAMPLE_OK
    every = np.ones(count, dtype=bool)
    representative = np.full(int(source.max()) + 1, -1, dtype=np.int64)
    representative[source[::-1]] = np.arange(new_count)[::-1]
    edges = [[representative[a], representative[b]] for a, b in np.asarray(analysis.piece_edges, dtype=np.int64)
             if representative[a] >= 0 and representative[b] >= 0]
    edges += [[representative[source[piece]], piece] for piece in range(new_count) if representative[source[piece]] != piece]
    width = geometry.local_thickness_pixels.astype(np.float64)
    split = PlaneAnalysis(
        z_index=analysis.z_index,
        shape=analysis.shape,
        sample_piece=inverse,
        sample_artifact=analysis.sample_artifact,
        sample_tan_chord=analysis.sample_tan_chord,
        sample_tan_drift=analysis.sample_tan_drift,
        sample_tan_error=analysis.sample_tan_error,
        sample_chord_censored=analysis.sample_chord_censored,
        sample_chord_planes=analysis.sample_chord_planes,
        sample_window_planes=analysis.sample_window_planes,
        piece_samples=np.bincount(inverse, minlength=new_count),
        piece_center_x=_aggregate(inverse, new_count, geometry.skeleton_x.astype(np.float64), clean),
        piece_center_y=_aggregate(inverse, new_count, geometry.skeleton_y.astype(np.float64), clean),
        piece_width_px=_aggregate(inverse, new_count, width, clean),
        piece_tan_chord=analysis.piece_tan_chord[source],
        piece_tan_drift=analysis.piece_tan_drift[source],
        piece_tan_error=analysis.piece_tan_error[source],
        piece_track_planes=analysis.piece_track_planes[source],
        piece_censored=analysis.piece_censored[source],
        piece_chord_planes=analysis.piece_chord_planes[source],
        piece_artifact=_aggregate(inverse, new_count, (~clean).astype(np.float64), every),
        piece_component_aspect=analysis.piece_component_aspect[source],
        piece_cc_samples=analysis.piece_cc_samples[source],
        piece_cc_span=analysis.piece_cc_span[source],
        piece_edges=np.asarray(edges, dtype=np.int32).reshape(-1, 2),
        neighbour_planes=analysis.neighbour_planes,
        median_width_px=analysis.median_width_px,
        piece_origin=np.asarray(analysis.piece_origin, dtype=np.int32)[source],
    )
    return split, np.asarray(piece_added, dtype=bool)[source], state[first], latest[first]


def _effective_plane(config, run, base_geometry, base_analysis, structural, stack_run):
    """The plane with added regions and painted pieces. Saved predictions stay as they are."""
    from .gbm_thickness import prepare_thickness_geometry

    directory = _effective_directory(config, run, _effective_key(structural, stack_run))
    plane_file = directory / "plane.npz"
    geometry_file = directory / "thickness_geometry.npz"
    extras_file = directory / "extras.npz"
    if plane_file.is_file() and geometry_file.is_file() and extras_file.is_file():
        with np.load(plane_file, allow_pickle=False) as archive:
            analysis = PlaneAnalysis.from_arrays(archive)
        with np.load(extras_file, allow_pickle=False) as extras:
            return (
                load_thickness_geometry(geometry_file), analysis,
                extras["added"], extras["paint"], extras["paint_edit"],
            )
    _require_scipy()
    attempt = (run.get("result") or {}).get("artifactAttempt")
    mask = read_mask(config.analysis_root, run["runId"], attempt=attempt).copy()
    regions = [(edit.get("payload") or {}).get("region") for edit in structural]
    regions = [region for region in regions if region and region.get("h")]
    for region in regions:
        _rle_paint(mask, region)
    geometry = prepare_thickness_geometry(mask) if regions else base_geometry
    if regions or base_analysis is None:
        analysis, added = _new_plane_from_geometry(geometry, base_analysis, base_geometry if base_analysis is not None else None)
    else:
        analysis, added = base_analysis, np.zeros(base_analysis.piece_samples.size, dtype=bool)
    strokes = [edit for edit in structural if edit["kind"] in PAINT_KINDS]
    analysis, added, paint, paint_edit = _split_for_paint(analysis, geometry, mask, strokes, added)
    payload = BytesIO()
    np.savez_compressed(payload, **thickness_geometry_to_arrays(geometry))
    write_bytes_atomic(geometry_file, payload.getvalue())
    _save_plane(plane_file, analysis)
    write_bytes_atomic(directory / "label.png", _encode_label(geometry, mask, analysis.sample_piece, analysis.sample_artifact))
    buffer = BytesIO()
    np.savez(buffer, added=added, paint=paint, paint_edit=paint_edit)
    write_bytes_atomic(extras_file, buffer.getvalue())
    return geometry, analysis, added, paint, paint_edit


def label_file(config, store, run: dict, options: dict) -> Path:
    """The label raster to display for this plane."""
    view = plane_view(config, store, run, options, ensure=False)
    structural = [edit for edit in view.edits if edit["kind"] in STRUCTURAL_KINDS]
    if structural:
        path = _effective_directory(config, run, _effective_key(structural, view.stack_run)) / "label.png"
        if path.is_file():
            return path
    if view.stack_run is None:
        raise Conflict("The Z analysis of this image is not ready yet")
    path = _label_path(config, view.stack_run, int(run["zIndex"]))
    if not path.is_file():
        raise Conflict("The Z analysis of this image is not ready yet")
    return path


def stack_exclusions(
    config, stack_run: dict, settings: FilterSettings, pixel: float, z_step_um: float | None,
    all_edits: list[dict], revision: str, memo: dict | None = None,
) -> dict[int, np.ndarray]:
    """Which pieces the stack's analysis excludes, per plane, decided for the whole stack at once.

    GBM is continuous through Z as well as along its centerline, so one plane cannot be
    decided without the planes around it. This reads every plane's saved evidence, applies
    the tilt limits that clicks have changed, and decides them together. Corrections to
    single pieces are not part of it: ``decide`` puts those on top, so they always win.
    """
    key = (
        "stack-exclusions", stack_run["runId"], (stack_run.get("result") or {}).get("artifactAttempt"), settings.max_tilt_deg,
        round(float(pixel), 9), None if not z_step_um else round(float(z_step_um), 9), revision,
    )
    if memo is not None and key in memo:
        return memo[key]
    with _stack_decisions_lock:
        decided = _stack_decisions.get(key)
        if decided is not None:
            _stack_decisions.move_to_end(key)
    if decided is None:
        members = (stack_run.get("request") or {}).get("members") or []
        plane_step = _plane_step(members)
        motion = _saved_motion(stack_run)
        clicks = [edit for edit in all_edits if edit["kind"] in ("include", "exclude")]
        analyses, evidence = [], []
        for member in members:
            z_index = int(member["zIndex"])
            analysis = load_plane(config, stack_run, z_index)
            if analysis is None:
                continue
            plane_settings = FilterSettings(
                cross_section=True, max_tilt_deg=settings.max_tilt_deg, thickness_limits=False,
                mip_planes=int(member.get("mipZ") or MIP_PLANES), plane_step=plane_step,
            )
            entry = piece_evidence(analysis, plane_settings, pixel_size_um=pixel, z_step_um=z_step_um)
            if clicks:
                field_, _ = _local_limits(analysis, entry["limit_deg"], clicks, z_index, pixel, z_step_um, entry["reference_px"], motion)
                entry = piece_evidence(analysis, plane_settings, pixel_size_um=pixel, z_step_um=z_step_um, tilt_limit_field=field_)
            analyses.append(analysis)
            evidence.append(entry)
        decided = {
            int(analysis.z_index): excluded
            for analysis, excluded in zip(analyses, decide_jointly(analyses, evidence)) if excluded is not None
        }
        with _stack_decisions_lock:
            _stack_decisions[key] = decided
            while len(_stack_decisions) > STACK_DECISION_CACHE:
                _stack_decisions.popitem(last=False)
    if memo is not None:
        memo[key] = decided
    return decided


def _exclusions_for_plane(
    config, view: PlaneView, settings: FilterSettings, evidence: dict, pixel: float, z_step_um: float | None, z_index: int, memo: dict | None,
) -> np.ndarray | None:
    """This plane's part of the stack's decision, or ``None`` if it has to be decided on its own.

    Where a correction has cut the plane's pieces differently, each piece takes the
    decision of the original piece it came from, so a correction changes nothing around it.
    """
    if evidence["score"] is None or view.stack_run is None:
        return None
    decided = stack_exclusions(config, view.stack_run, settings, pixel, z_step_um, view.all_edits, view.revision, memo).get(int(z_index))
    origin = np.asarray(view.analysis.piece_origin, dtype=np.int64).reshape(-1)
    if decided is None or origin.size != evidence["score"].size:
        return None
    known = (origin >= 0) & (origin < decided.size)
    if not known.any():
        return None
    own = (evidence["score"] > 0.0) & ~evidence["artifact"]
    return np.where(known, decided[np.where(known, origin, 0)], own)


def decide(
    config, view: PlaneView, settings: FilterSettings, calibration: dict, z_step: dict, z_index: int, mip_planes: int, plane_step: float,
    memo: dict | None = None,
) -> dict:
    """Reasons per piece for one plane, including all corrections."""
    analysis = view.analysis
    pixel = _mean_pixel(calibration)
    expansion = _expansion(calibration)
    settings = FilterSettings(
        cross_section=settings.cross_section, max_tilt_deg=settings.max_tilt_deg,
        thickness_limits=settings.thickness_limits, min_nm=settings.min_nm, max_nm=settings.max_nm,
        mip_planes=mip_planes, plane_step=plane_step,
    )
    first = piece_evidence(analysis, settings, pixel_size_um=pixel, z_step_um=z_step["um"])
    field_, trusted = _local_limits(
        analysis, first["limit_deg"], view.all_edits, z_index, pixel, z_step["um"], first["reference_px"], _saved_motion(view.stack_run),
    )
    evidence = piece_evidence(analysis, settings, pixel_size_um=pixel, z_step_um=z_step["um"], tilt_limit_field=field_)
    result = decide_from_evidence(
        analysis, evidence, settings, pixel_size_um=pixel, expansion_factor=expansion, trusted_reasons=trusted,
        excluded=_exclusions_for_plane(config, view, settings, evidence, pixel, z_step["um"], z_index, memo),
    )
    reasons = result["reasons"]
    # People outrank the algorithm, and a later click outranks an earlier one.
    pinned = np.zeros(reasons.size, dtype=bool)
    clicked = np.zeros(reasons.size, dtype=bool)
    if view.piece_added is not None:
        added = np.asarray(view.piece_added, dtype=bool)
        reasons[added] = REASON_KEPT
        pinned |= added
    # When each piece was last painted, as a position in this plane's corrections.
    painted_at = np.full(reasons.size, -1, dtype=np.int64)
    if view.piece_paint is not None and view.piece_paint.size == reasons.size:
        positions = [index for index, edit in enumerate(view.edits) if edit["kind"] in PAINT_KINDS]
        keep = view.piece_paint == 1
        remove = view.piece_paint == 2
        reasons[keep] = REASON_KEPT
        pinned[keep] = True
        clicked[keep] = True
        reasons[remove] = REASON_MANUAL
        pinned[remove] = False
        clicked[remove] = False
        touched = view.piece_paint_edit >= 0
        painted_at[touched] = np.asarray(positions, dtype=np.int64)[view.piece_paint_edit[touched]]
    for position, edit in enumerate(view.edits):
        if edit["kind"] not in ("include", "exclude"):
            continue
        index, _ = _nearest_sample(view.geometry, edit["x"], edit["y"])
        if index < 0:
            continue
        piece = int(analysis.sample_piece[index])
        if position < painted_at[piece]:
            continue
        reasons[piece] = REASON_KEPT if edit["kind"] == "include" else REASON_MANUAL
        pinned[piece] = edit["kind"] == "include"
        clicked[piece] = edit["kind"] == "include"
    result["pinned"] = pinned
    result["clicked"] = clicked
    return result


def filtered_samples(config, store, run: dict, settings: FilterSettings, options: dict, calibration: dict) -> dict:
    """Which centerline samples of a run count, and why the others do not."""
    view = plane_view(config, store, run, options)
    pixel = _mean_pixel(calibration)
    geometry = view.geometry
    count = geometry.skeleton_y.size
    within_limits = np.ones(count, dtype=bool)
    if settings.thickness_limits:
        thickness_nm = 2.0 * np.hypot(
            geometry.nearest_background_dy_pixels.astype(np.float64) * float(calibration["pixelSizeYUm"]),
            geometry.nearest_background_dx_pixels.astype(np.float64) * float(calibration["pixelSizeXUm"]),
        ) / _expansion(calibration) * 1000.0
        within_limits = (thickness_nm >= settings.min_nm) & (thickness_nm <= settings.max_nm)
    token = filter_token(view.state, view.revision, settings.cross_section)
    info = {
        "applied": False,
        "pending": bool(settings.cross_section or view.edits),
        "state": view.state["state"],
        "stale": view.state["stale"],
        "planes": view.state["planes"],
        "token": token,
        "totalSamples": int(count),
        "keptSamples": int(within_limits.sum()),
        "byReason": {},
        "crossSection": settings.cross_section,
    }
    if view.analysis is None:
        if not info["pending"]:
            info["applied"] = True
        return {"geometry": geometry, "keep": within_limits, "info": info, "view": view}
    z_step = resolve_z_step(config, run, options.get("zStepUm"))
    members = ((view.stack_run or {}).get("request") or {}).get("members") or []
    mip_planes = len((run.get("request") or {}).get("zWindow") or [MIP_PLANES])
    decided = decide(config, view, settings, calibration, z_step, int(run["zIndex"]), mip_planes, _plane_step(members), options.get("memo"))
    pieces = view.analysis.sample_piece
    pinned = decided["pinned"][pieces]
    sample_reason = decided["reasons"][pieces]
    keep = (sample_reason == REASON_KEPT) & (within_limits | pinned)
    if settings.cross_section:
        # Tapers, spurs and junctions belong to the GBM but are not measured.
        unmeasured = (view.analysis.sample_artifact != SAMPLE_OK) & ~decided["clicked"][pieces]
        keep &= ~unmeasured
        sample_reason = np.where(unmeasured & (sample_reason == REASON_KEPT), REASON_ARTIFACT, sample_reason)
    unique, totals = np.unique(sample_reason, return_counts=True)
    info.update(
        applied=True,
        pending=False,
        keptSamples=int(keep.sum()),
        byReason={REASON_NAMES[int(code)]: int(total) for code, total in zip(unique, totals)},
        limitDeg=decided["limit_deg"],
        zStep=z_step,
        hasNeighbours=view.analysis.neighbour_planes > 0,
    )
    return {"geometry": geometry, "keep": keep, "info": info, "view": view, "decided": decided, "zStep": z_step}


def _plane_step(members: list[dict]) -> float:
    centers = sorted({float(member["center"]) for member in members})
    if len(centers) < 2:
        return 1.0
    return float(np.median(np.diff(centers)))


def refinement_view(config, store, run: dict, settings: FilterSettings, options: dict, calibration: dict) -> dict:
    """What the viewer needs to colour one plane and explain its decisions."""
    outcome = filtered_samples(config, store, run, settings, options, calibration)
    view: PlaneView = outcome["view"]
    info = outcome["info"]
    response = {
        "runId": run["runId"],
        "zIndex": int(run["zIndex"]),
        "stack": _public_state(view.state),
        "summary": info,
        "revision": view.revision,
        "edits": [_public_edit(edit) for edit in view.edits],
        "editCount": len(view.all_edits),
        "probabilityAvailable": bool((run.get("result") or {}).get("probabilityAvailable")),
        "pieces": None,
    }
    if view.analysis is None or "decided" not in outcome:
        return response
    decided = outcome["decided"]
    pixel = _mean_pixel(calibration)
    expansion = _expansion(calibration)
    width_nm = np.asarray(view.analysis.piece_width_px, dtype=np.float64) * pixel / expansion * 1000.0
    tilt = decided["tilt_deg"]
    response["pieces"] = {
        "count": int(view.analysis.piece_samples.size),
        "reason": decided["reasons"].astype(int).tolist(),
        "tiltDeg": [None if not np.isfinite(value) else round(float(value), 1) for value in tilt],
        "widthNm": [None if not np.isfinite(value) else int(round(float(value))) for value in width_nm],
        "reasonNames": {str(code): name for code, name in REASON_NAMES.items()},
    }
    response["hasNeighbours"] = view.analysis.neighbour_planes > 0
    response["limitDeg"] = decided["limit_deg"]
    response["zStep"] = outcome["zStep"]
    response["medianReachPlanes"] = ((view.stack_run or {}).get("result") or {}).get("medianReachPlanes")
    response["labelToken"] = _label_token(view)
    return response


def _label_token(view: PlaneView) -> str:
    return _digest({
        "stack": (view.stack_run or {}).get("runId"),
        "structural": [edit["id"] for edit in view.edits if edit["kind"] in STRUCTURAL_KINDS],
    })[:20]


def refinement_frames(config, store, runs: dict[str, dict], settings: FilterSettings, options: dict, calibration: dict) -> dict:
    """What to draw for every slice of a stack, so scrubbing needs no request per slice.

    Decisions come from the saved analysis alone, without reading any plane's geometry,
    unless a slice has corrections of its own.
    """
    memo: dict = {}
    options = {**options, "memo": memo}
    window = int(options.get("window") or DEFAULT_MAX_WINDOW)
    edits_by_image: dict = {}
    frames: dict[str, dict | None] = {}
    for run_id, run in runs.items():
        if run.get("status") != "SUCCEEDED" or run.get("operation") != SEGMENTATION_OPERATION:
            frames[run_id] = None
            continue
        case, filename = run["case"], run["filename"]
        channel, z_index = int(run["channelIndex"]), int(run["zIndex"])
        image = (case, filename, channel)
        if image not in edits_by_image:
            path = image_path(config.active_data_root, case, filename)
            edits_by_image[image] = store.list_prediction_edits(case, filename, channel, _source_key(path))
        all_edits = edits_by_image[image]
        edits = [edit for edit in all_edits if edit["zIndex"] == z_index]
        state = stack_state(config, store, case, filename, channel, window=window, ensure=True, memo=memo)
        stack_run = state.get("usable")
        if edits:
            view = plane_view(config, store, run, options)
        else:
            analysis = load_plane(config, stack_run, z_index) if stack_run else None
            view = PlaneView(None, analysis, stack_run, state, [], all_edits, None, None, None, edits_revision(all_edits))
        if view.analysis is None:
            frames[run_id] = None
            continue
        members = ((stack_run or {}).get("request") or {}).get("members") or []
        mip_planes = len((run.get("request") or {}).get("zWindow") or [MIP_PLANES])
        z_step = resolve_z_step(config, run, options.get("zStepUm"))
        decided = decide(config, view, settings, calibration, z_step, z_index, mip_planes, _plane_step(members), memo)
        frames[run_id] = {
            "zIndex": z_index,
            "reason": decided["reasons"].astype(int).tolist(),
            "labelToken": _label_token(view),
        }
    return {"frames": frames, "reasonNames": {str(code): name for code, name in REASON_NAMES.items()}}


def _public_motion(saved: dict | None) -> dict | None:
    if saved is None:
        return None
    return {name: saved.get(name) for name in ("measured", "corrected", "medianPxPerPlane", "maxPxPerPlane")}


def _public_state(state: dict) -> dict:
    usable = state.get("usable") or {}
    result = usable.get("result") or {}
    return {
        "state": state["state"],
        "stale": state["stale"],
        "planes": state["planes"],
        "window": state["window"],
        "activeSegmentation": state["activeSegmentation"],
        "job": state.get("job"),
        "analysedPlanes": result.get("planes"),
        "medianReachPlanes": result.get("medianReachPlanes"),
        "fieldMotion": _public_motion(result.get("fieldMotion")),
    }


def _public_edit(edit: dict) -> dict:
    payload = edit.get("payload") or {}
    return {
        "id": edit["id"], "kind": edit["kind"], "x": edit["x"], "y": edit["y"], "zIndex": edit["zIndex"],
        "stroke": payload.get("stroke"), "radius": payload.get("radius"),
        "createdBy": edit.get("createdBy"), "createdAt": edit.get("createdAt"),
        "tiltDeg": payload.get("tiltDeg"), "reason": payload.get("reason"), "tau": payload.get("tau"),
        "probabilitySource": payload.get("probabilitySource"),
    }


def find_region_at_click(probability: np.ndarray, mask: np.ndarray, x: float, y: float, reference_px: float, *, base: float = BASE_PROBABILITY_THRESHOLD) -> dict | None:
    """The region a click asks for, by lowering the threshold around it.

    The boundary of a structure in a smooth map sits at half the height between
    its peak and the local background, whether the model's confidence is high or
    faint, so the threshold at the click starts there. It returns to the model's
    own threshold with distance, so fainter evidence reaches less far. Should
    that region be wider than GBM nearby, it has leaked or is an en-face patch,
    and the threshold is raised until it is not.
    """
    from scipy.ndimage import binary_fill_holes, binary_opening, distance_transform_edt, gaussian_filter, label as component_label

    height, width = probability.shape
    radius = float(np.clip(6.0 * reference_px, 60.0, 320.0))
    x0, x1 = max(0, int(x - radius)), min(width, int(x + radius) + 1)
    y0, y1 = max(0, int(y - radius)), min(height, int(y + radius) + 1)
    # Image-derived maps are noisy; noise on the boundary would become skeleton spurs.
    crop = gaussian_filter(probability[y0:y1, x0:x1].astype(np.float32), max(1.0, 0.06 * reference_px))
    existing = np.asarray(mask[y0:y1, x0:x1], dtype=bool)
    yy, xx = np.mgrid[y0:y1, x0:x1]
    distance2 = (yy - y) ** 2 + (xx - x) ** 2
    falloff = 1.0 - np.exp(-distance2 / (2.0 * (radius / 2.0) ** 2))

    snap = max(3.0, 0.4 * reference_px)
    near = (distance2 <= snap * snap) & ~existing
    if not near.any():
        return None
    seed = np.unravel_index(int(np.where(near, crop, -1.0).argmax()), crop.shape)
    peak = float(crop[seed])
    outside = crop[~existing]
    background = float(np.percentile(outside, 20.0)) if outside.size else 0.0
    contrast = peak - background
    if contrast < 0.05:
        return None

    limit = 2.5 * max(reference_px, 8.0)
    structure = np.ones((3, 3), dtype=bool)
    opening = np.ones((3, 3), dtype=bool)
    for fraction in (0.5, 0.6, 0.7, 0.8):
        level = background + fraction * contrast
        threshold = level + max(max(base, peak) - level, 0.0) * falloff
        passing = binary_fill_holes(binary_opening(crop >= threshold, opening)) | (crop >= threshold) & near
        labels, _ = component_label(passing, structure=structure)
        if labels[seed] == 0:
            continue
        region = labels == labels[seed]
        if 2.0 * float(distance_transform_edt(region).max()) > limit:
            continue
        new = region & ~existing
        if int(new.sum()) < max(0.5 * reference_px * reference_px, 12.0):
            continue
        full = np.zeros(probability.shape, dtype=bool)
        full[y0:y1, x0:x1] = new
        return {"tau": round(level, 3), "radius": round(radius, 1), "region": _rle_encode(full), "area": int(new.sum())}
    return None


def region_under_band(probability: np.ndarray, mask: np.ndarray, band: np.ndarray, reference_px: float) -> dict | None:
    """What a keeping stroke adds where it crosses background.

    The brush says where; the map says how wide. Within the stroke, the region is
    cut at half height between the signal under the brush and the local background,
    so thickness still comes from the image and not from the size of the brush.
    """
    from scipy.ndimage import binary_fill_holes, binary_opening, gaussian_filter, label as component_label

    fresh = band & ~mask
    if not fresh.any():
        return None
    ys, xs = np.nonzero(band)
    margin = int(max(3.0 * reference_px, 24.0))
    y0, y1 = max(0, int(ys.min()) - margin), min(band.shape[0], int(ys.max()) + margin + 1)
    x0, x1 = max(0, int(xs.min()) - margin), min(band.shape[1], int(xs.max()) + margin + 1)
    crop = gaussian_filter(probability[y0:y1, x0:x1].astype(np.float32), max(1.0, 0.06 * reference_px))
    fresh_crop = fresh[y0:y1, x0:x1]
    outside = crop[~(mask[y0:y1, x0:x1] | band[y0:y1, x0:x1])]
    background = float(np.percentile(outside, 20.0)) if outside.size else 0.0
    peak = float(np.percentile(crop[fresh_crop], 90.0))
    contrast = peak - background
    if contrast < 0.05:
        return None
    level = background + 0.5 * contrast
    passing = binary_fill_holes(binary_opening(fresh_crop & (crop >= level), np.ones((3, 3), dtype=bool))) & fresh_crop
    labels, count = component_label(passing, structure=np.ones((3, 3), dtype=bool))
    if count == 0:
        return None
    sizes = np.bincount(labels.ravel(), minlength=count + 1)
    sizes[0] = 0
    keep = sizes >= max(0.25 * reference_px * reference_px, 12.0)
    if not keep.any():
        return None
    full = np.zeros(probability.shape, dtype=bool)
    full[y0:y1, x0:x1] = keep[labels]
    return {"tau": round(level, 3), "region": _rle_encode(full), "area": int(full.sum())}


def _simplified_stroke(stroke: list, radius: float, width: int, height: int) -> list[list[float]]:
    """In-bounds stroke points, without those closer together than the brush can show."""
    spacing = max(1.0, 0.25 * radius)
    points: list[list[float]] = []
    for x, y in stroke:
        point = [float(np.clip(x, 0, width - 1)), float(np.clip(y, 0, height - 1))]
        if not points or math.hypot(point[0] - points[-1][0], point[1] - points[-1][1]) >= spacing:
            points.append([round(point[0], 1), round(point[1], 1)])
    return points


def create_stroke_edit(config, store, run: dict, kind: str, stroke: list, radius: float, actor: str, options: dict) -> dict:
    """Turn a brush stroke into a correction of exactly what it covers."""
    if kind not in ("positive", "negative"):
        raise BadRequest("kind must be positive or negative")
    source = (run.get("request") or {}).get("source") or {}
    width, height = int(source.get("width") or 0), int(source.get("height") or 0)
    points = _simplified_stroke(stroke, radius, width, height)
    if not points:
        raise BadRequest("The stroke is empty")
    _require_scipy()
    case, filename = run["case"], run["filename"]
    channel, z_index = int(run["channelIndex"]), int(run["zIndex"])
    path = image_path(config.active_data_root, case, filename)
    attempt = (run.get("result") or {}).get("artifactAttempt")
    view = plane_view(config, store, run, options)
    mask = read_mask(config.analysis_root, run["runId"], attempt=attempt).copy()
    for edit in view.edits:
        region = (edit.get("payload") or {}).get("region")
        if region and region.get("h"):
            _rle_paint(mask, region)
    band = stroke_band(points, radius, (height, width))
    on_prediction = bool((band & mask).any())
    payload: dict[str, Any] = {"stroke": points, "radius": round(float(radius), 2)}
    if kind == "negative":
        if not on_prediction:
            raise Conflict("There is no predicted GBM under this stroke")
        resolved = "paint-remove"
    else:
        reference = float(np.median(view.geometry.local_thickness_pixels)) if view.geometry.skeleton_y.size else 20.0
        source_name = "probability"
        if probability_path(config.analysis_root, run["runId"], attempt=attempt, require=False).is_file():
            probability = read_probability(config.analysis_root, run["runId"], attempt=attempt)
        else:
            probability = _pseudo_probability(config, run)
            source_name = "image"
        region = region_under_band(probability, mask, band, reference)
        if region is not None:
            payload.update(region, probabilitySource=source_name)
        elif not on_prediction:
            raise Conflict("No GBM-like signal was found under this stroke")
        resolved = "paint-keep"
    return store.add_prediction_edit(
        case, filename, channel, _source_key(path), z_index, resolved, points[0][0], points[0][1], payload, actor,
    )


def _pseudo_probability(config, run: dict) -> np.ndarray:
    """Local image contrast, for runs from before probability maps were saved."""
    from .tiff_service import read_z_mip

    path = image_path(config.active_data_root, run["case"], run["filename"])
    request = run.get("request") or {}
    plane, _ = read_z_mip(path, int(request["channelIndex"]), int(request["zIndex"]), int(request.get("mipZRequested") or 1))
    plane = np.asarray(plane, dtype=np.float32)
    low, high = np.percentile(plane, (1.0, 99.7))
    if not high > low:
        return np.zeros(plane.shape, dtype=np.float32)
    return np.clip((plane - low) / (high - low), 0.0, 1.0)


def create_edit(config, store, run: dict, kind: str, x: float, y: float, actor: str, settings: FilterSettings, options: dict, calibration: dict) -> dict:
    """Turn a click into a correction. ``kind`` is ``positive`` or ``negative``."""
    if kind not in ("positive", "negative"):
        raise BadRequest("kind must be positive or negative")
    source = (run.get("request") or {}).get("source") or {}
    if not (0 <= x < int(source.get("width") or 0) and 0 <= y < int(source.get("height") or 0)):
        raise BadRequest("The click is outside the image")
    case, filename = run["case"], run["filename"]
    channel, z_index = int(run["channelIndex"]), int(run["zIndex"])
    path = image_path(config.active_data_root, case, filename)
    outcome = filtered_samples(config, store, run, settings, options, calibration)
    view: PlaneView = outcome["view"]
    geometry = view.geometry
    width = geometry.local_thickness_pixels
    reference = float(np.median(width)) if width.size else 20.0
    index, distance = _nearest_sample(geometry, x, y)
    attempt = (run.get("result") or {}).get("artifactAttempt")
    mask = read_mask(config.analysis_root, run["runId"], attempt=attempt)
    # On the prediction: inside the saved mask, or close to any centerline
    # (which also covers regions people added).
    near = index >= 0 and (bool(mask[int(y), int(x)]) or distance <= max(0.6 * float(width[index]), 4.0))
    payload: dict[str, Any] = {}
    if near:
        tilt = None
        reason = REASON_KEPT
        if view.analysis is not None and "decided" in outcome:
            piece = int(view.analysis.sample_piece[index])
            value = float(outcome["decided"]["tilt_deg"][piece])
            tilt = round(value, 1) if math.isfinite(value) else None
            reason = int(outcome["decided"]["reasons"][piece])
        payload = {"tiltDeg": tilt, "reason": reason}
        resolved = "include" if kind == "positive" else "exclude"
    else:
        if kind == "negative":
            raise Conflict("There is no predicted GBM at this point to remove")
        _require_scipy()
        source_name = "probability"
        if probability_path(config.analysis_root, run["runId"], attempt=attempt, require=False).is_file():
            probability = read_probability(config.analysis_root, run["runId"], attempt=attempt)
        else:
            probability = _pseudo_probability(config, run)
            source_name = "image"
        region = find_region_at_click(probability, mask, x, y, reference)
        if region is None:
            raise Conflict("No GBM-like signal was found near this point")
        payload = {**region, "probabilitySource": source_name}
        resolved = "add"
    edit = store.add_prediction_edit(
        case, filename, channel, _source_key(path), z_index, resolved, float(x), float(y), payload, actor,
    )
    return edit


def remove_edits(config, store, run: dict, *, edit_id: str | None = None, whole_image: bool = False) -> int:
    """Undo one correction, or restore the model's prediction for a slice or image."""
    path = image_path(config.active_data_root, run["case"], run["filename"])
    return store.delete_prediction_edits(
        run["case"], run["filename"], int(run["channelIndex"]), _source_key(path),
        edit_id=edit_id, z_index=None if (whole_image or edit_id) else int(run["zIndex"]),
    )


__all__ = [
    "STACK_OPERATION",
    "create_edit",
    "create_stroke_edit",
    "execute_stack_analysis",
    "filter_tokens",
    "filtered_samples",
    "find_region_at_click",
    "label_file",
    "parse_filter",
    "refinement_frames",
    "refinement_view",
    "remove_edits",
    "stack_state",
]
