"""Path-safe, atomically published segmentation run artifacts."""
from __future__ import annotations

from io import BytesIO
import json
import os
from pathlib import Path
import shutil
import uuid

import numpy as np
from PIL import Image

from .errors import BadRequest, NotFound
from .path_guard import resolve_under_root


MASK_FILENAME = "mask.png"
SKELETON_FILENAME = "skeleton.png"
MANIFEST_FILENAME = "manifest.json"
THICKNESS_GEOMETRY_FILENAME = "thickness_geometry.npz"


def ensure_run_id(run_id: str) -> str:
    try:
        parsed = uuid.UUID(str(run_id))
    except (TypeError, ValueError, AttributeError) as exc:
        raise BadRequest("Invalid analysis run id") from exc
    return str(parsed)


def run_directory(analysis_root: Path, run_id: str, *, create: bool = False) -> Path:
    run_id = ensure_run_id(run_id)
    directory = resolve_under_root(Path(analysis_root) / "runs", run_id)
    if create:
        directory.mkdir(parents=True, exist_ok=True)
    return directory


def attempt_directory(
    analysis_root: Path,
    run_id: str,
    attempt: int | None,
    *,
    create: bool = False,
) -> Path:
    """Resolve one immutable lease-attempt directory.

    ``None`` retains the legacy run-directory layout for already-published
    artifacts. New worker attempts always use a positive attempt number so a
    reclaimed stale worker cannot overwrite the winning attempt's files.
    """
    directory = run_directory(analysis_root, run_id, create=create)
    if attempt is None:
        return directory
    if isinstance(attempt, bool) or not isinstance(attempt, int) or attempt < 1:
        raise ValueError("Artifact attempt must be a positive integer")
    directory = resolve_under_root(directory / "attempts", str(attempt))
    if create:
        directory.mkdir(parents=True, exist_ok=True)
    return directory


def mask_path(
    analysis_root: Path,
    run_id: str,
    *,
    attempt: int | None = None,
    require: bool = True,
) -> Path:
    path = resolve_under_root(attempt_directory(analysis_root, run_id, attempt), MASK_FILENAME)
    if require and not path.is_file():
        raise NotFound("Segmentation mask not found")
    return path


def skeleton_path(
    analysis_root: Path,
    run_id: str,
    *,
    attempt: int | None = None,
    require: bool = True,
) -> Path:
    path = resolve_under_root(
        attempt_directory(analysis_root, run_id, attempt), SKELETON_FILENAME
    )
    if require and not path.is_file():
        raise NotFound("GBM skeleton overlay not found")
    return path


def manifest_path(
    analysis_root: Path,
    run_id: str,
    *,
    attempt: int | None = None,
    require: bool = True,
) -> Path:
    path = resolve_under_root(
        attempt_directory(analysis_root, run_id, attempt), MANIFEST_FILENAME
    )
    if require and not path.is_file():
        raise NotFound("Segmentation manifest not found")
    return path


def thickness_geometry_path(
    analysis_root: Path,
    run_id: str,
    *,
    attempt: int | None = None,
    require: bool = True,
) -> Path:
    path = resolve_under_root(
        attempt_directory(analysis_root, run_id, attempt), THICKNESS_GEOMETRY_FILENAME
    )
    if require and not path.is_file():
        raise NotFound("GBM thickness geometry not found")
    return path


def write_mask_atomic(
    analysis_root: Path,
    run_id: str,
    mask,
    *,
    attempt: int | None = None,
) -> Path:
    array = np.asarray(mask)
    if array.ndim != 2:
        raise ValueError("Segmentation mask must be two-dimensional")
    if array.dtype == np.bool_:
        encoded = array.astype(np.uint8) * 255
    else:
        if not np.isfinite(array).all():
            raise ValueError("Segmentation mask contains NaN or Inf")
        encoded = (array > 0).astype(np.uint8) * 255

    payload = BytesIO()
    Image.fromarray(encoded, mode="L").save(payload, format="PNG", optimize=True)
    destination = mask_path(analysis_root, run_id, attempt=attempt, require=False)
    _atomic_write_bytes(destination, payload.getvalue())
    return destination


def write_skeleton_atomic(
    analysis_root: Path,
    run_id: str,
    skeleton_y,
    skeleton_x,
    shape,
    *,
    attempt: int | None = None,
) -> Path:
    """Publish the exact saved centerline samples as a one-pixel binary PNG."""
    dimensions = np.asarray(shape, dtype=np.int64).reshape(-1)
    if dimensions.size != 2 or np.any(dimensions < 1):
        raise ValueError("Skeleton overlay shape must contain positive height and width")
    height, width = int(dimensions[0]), int(dimensions[1])
    y = np.asarray(skeleton_y, dtype=np.int64).reshape(-1)
    x = np.asarray(skeleton_x, dtype=np.int64).reshape(-1)
    if y.size != x.size:
        raise ValueError("Skeleton X/Y coordinates have inconsistent lengths")
    if y.size and (
        np.any(y < 0)
        or np.any(y >= height)
        or np.any(x < 0)
        or np.any(x >= width)
    ):
        raise ValueError("Skeleton overlay contains out-of-bounds coordinates")
    encoded = np.zeros((height, width), dtype=np.uint8)
    encoded[y, x] = 255
    payload = BytesIO()
    Image.fromarray(encoded, mode="L").save(payload, format="PNG", optimize=True)
    destination = skeleton_path(
        analysis_root, run_id, attempt=attempt, require=False
    )
    _atomic_write_bytes(destination, payload.getvalue())
    return destination


def write_manifest_atomic(
    analysis_root: Path,
    run_id: str,
    manifest: dict,
    *,
    attempt: int | None = None,
) -> Path:
    destination = manifest_path(analysis_root, run_id, attempt=attempt, require=False)
    payload = json.dumps(manifest, indent=2, sort_keys=True, allow_nan=False).encode("utf-8") + b"\n"
    _atomic_write_bytes(destination, payload)
    return destination


def write_thickness_geometry_atomic(
    analysis_root: Path,
    run_id: str,
    arrays: dict,
    *,
    attempt: int | None = None,
) -> Path:
    if not isinstance(arrays, dict) or not arrays:
        raise ValueError("Thickness geometry arrays are required")
    normalized = {}
    for key, value in arrays.items():
        name = str(key)
        if not name or "/" in name or "\\" in name:
            raise ValueError("Invalid thickness geometry array name")
        array = np.asarray(value)
        if array.dtype.hasobject:
            raise ValueError("Thickness geometry cannot contain object arrays")
        normalized[name] = array
    payload = BytesIO()
    np.savez_compressed(payload, **normalized)
    destination = thickness_geometry_path(
        analysis_root, run_id, attempt=attempt, require=False
    )
    _atomic_write_bytes(destination, payload.getvalue())
    return destination


def read_mask(analysis_root: Path, run_id: str, *, attempt: int | None = None):
    with Image.open(mask_path(analysis_root, run_id, attempt=attempt)) as image:
        return np.asarray(image.convert("L")) > 0


def remove_run_artifacts(analysis_root: Path, run_id: str) -> bool:
    """Remove every immutable artifact attempt for one validated run id."""
    directory = run_directory(analysis_root, run_id)
    if not directory.exists():
        return False
    shutil.rmtree(directory)
    return True


def _atomic_write_bytes(destination: Path, payload: bytes) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.tmp")
    try:
        fd = os.open(str(temporary), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
