"""Full-mask, polygon-ROI GBM thickness measurements.

This module mirrors the supplied interactive QuPath notebook: skeletonization
and Euclidean distance transforms are computed on the complete binary mask
before a polygon selects centerline samples.  That ordering prevents the ROI
edge from becoming an artificial GBM boundary.

Unlike the original notebook, anisotropic X/Y calibration is supported by
storing each skeleton sample's nearest-background Y/X EDT vector.  The web API
can apply calibration to those vectors later using NumPy only, while retaining
notebook-compatible pixel-diameter fields for auditability.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any
import importlib.util
import math

import numpy as np

THICKNESS_GEOMETRY_SCHEMA_VERSION = 1


@dataclass(frozen=True)
class ThicknessGeometry:
    """Calibration-independent full-mask geometry reusable across polygon ROIs."""

    shape: tuple[int, int]
    skeleton_y: np.ndarray
    skeleton_x: np.ndarray
    local_thickness_pixels: np.ndarray
    nearest_background_dy_pixels: np.ndarray
    nearest_background_dx_pixels: np.ndarray
    skeleton_degree: np.ndarray
    skeleton_component: np.ndarray
    border_components: np.ndarray
    total_component_count: int


def thickness_runtime_available() -> bool:
    """Check worker-only scientific dependencies without importing them."""
    try:
        return (
            importlib.util.find_spec("scipy.ndimage") is not None
            and importlib.util.find_spec("skimage.morphology") is not None
        )
    except (ImportError, ModuleNotFoundError, ValueError):
        return False


def _require_runtime() -> None:
    if not thickness_runtime_available():
        raise RuntimeError(
            "GBM thickness measurement requires scipy and scikit-image. "
            "Install backend/requirements-inference.txt."
        )


def _binary_mask(mask: Any) -> np.ndarray:
    array = np.asarray(mask)
    if array.ndim != 2:
        raise ValueError(f"GBM thickness expects one 2-D mask; got shape {array.shape}")
    if array.size == 0:
        raise ValueError("GBM thickness mask is empty")
    if not (
        np.issubdtype(array.dtype, np.bool_)
        or np.issubdtype(array.dtype, np.integer)
        or np.issubdtype(array.dtype, np.floating)
    ):
        raise ValueError(f"GBM thickness mask dtype is not numeric: {array.dtype}")
    if np.issubdtype(array.dtype, np.floating) and not np.isfinite(array).all():
        raise ValueError("GBM thickness mask contains NaN or Inf")
    values = np.unique(array)
    if values.size > 2 or not all(float(value) in (0.0, 1.0) for value in values):
        raise ValueError(
            "GBM thickness mask must be binary with values {0,1}; "
            f"found {values[:12].tolist()}"
        )
    return array.astype(bool, copy=False)


def _calibration(
    pixel_size_x_um: float,
    pixel_size_y_um: float | None,
    expansion_factor: float = 1.0,
) -> tuple[float, float, float]:
    size_x = float(pixel_size_x_um)
    size_y = size_x if pixel_size_y_um is None else float(pixel_size_y_um)
    expansion = float(expansion_factor)
    if not math.isfinite(size_x) or size_x <= 0:
        raise ValueError("pixel_size_x_um must be finite and greater than zero")
    if not math.isfinite(size_y) or size_y <= 0:
        raise ValueError("pixel_size_y_um must be finite and greater than zero")
    if not math.isfinite(expansion) or expansion <= 0:
        raise ValueError("expansion_factor must be finite and greater than zero")
    return size_x, size_y, expansion


def _skeleton_neighbor_degree(skeleton: np.ndarray) -> np.ndarray:
    """Count eight-connected skeleton neighbors without a convolution dependency."""
    binary = np.asarray(skeleton, dtype=np.uint8)
    padded = np.pad(binary, 1, mode="constant")
    height, width = binary.shape
    neighbors = np.zeros(binary.shape, dtype=np.uint8)
    for dy in range(3):
        for dx in range(3):
            if dy == 1 and dx == 1:
                continue
            neighbors += padded[dy : dy + height, dx : dx + width]
    return neighbors


def prepare_thickness_geometry(mask: Any) -> ThicknessGeometry:
    """Build calibration-independent full-mask geometry in an inference worker.

    SciPy and scikit-image are imported *inside* this function so loading the
    Flask/API module never imports the worker's scientific stack.  In addition
    to the notebook's pixel EDT diameter, the artifact stores the Y/X vector
    from every skeleton point to its nearest background point.  The API can
    therefore apply X/Y pixel calibration later using NumPy only.
    """
    _require_runtime()
    from scipy.ndimage import distance_transform_edt, label as component_label
    from skimage.morphology import skeletonize

    binary = _binary_mask(mask)
    if not binary.any():
        empty_i32 = np.empty(0, dtype=np.int32)
        return ThicknessGeometry(
            shape=tuple(map(int, binary.shape)),
            skeleton_y=empty_i32.copy(),
            skeleton_x=empty_i32.copy(),
            local_thickness_pixels=np.empty(0, dtype=np.float64),
            nearest_background_dy_pixels=empty_i32.copy(),
            nearest_background_dx_pixels=empty_i32.copy(),
            skeleton_degree=np.empty(0, dtype=np.uint8),
            skeleton_component=empty_i32.copy(),
            border_components=empty_i32.copy(),
            total_component_count=0,
        )

    full_skeleton = np.asarray(skeletonize(binary), dtype=bool)
    skeleton_y, skeleton_x = np.nonzero(full_skeleton)
    if skeleton_x.size == 0:
        raise ValueError("The selected mask has no measurable skeleton pixels")

    distance_pixels, nearest_indices = distance_transform_edt(
        binary,
        return_indices=True,
    )
    local_thickness_pixels = (
        2.0 * distance_pixels[skeleton_y, skeleton_x]
    ).astype(np.float64, copy=False)
    nearest_y = nearest_indices[0, skeleton_y, skeleton_x]
    nearest_x = nearest_indices[1, skeleton_y, skeleton_x]
    nearest_background_dy_pixels = (
        skeleton_y.astype(np.int64) - nearest_y.astype(np.int64)
    ).astype(np.int32, copy=False)
    nearest_background_dx_pixels = (
        skeleton_x.astype(np.int64) - nearest_x.astype(np.int64)
    ).astype(np.int32, copy=False)
    del distance_pixels, nearest_indices, nearest_y, nearest_x

    degrees = _skeleton_neighbor_degree(full_skeleton)[skeleton_y, skeleton_x]
    labels, count = component_label(
        binary,
        structure=np.ones((3, 3), dtype=np.uint8),
    )
    skeleton_component = labels[skeleton_y, skeleton_x]
    border_components = np.unique(
        np.concatenate([labels[0, :], labels[-1, :], labels[:, 0], labels[:, -1]])
    )
    border_components = border_components[border_components != 0]

    return ThicknessGeometry(
        shape=tuple(map(int, binary.shape)),
        skeleton_y=skeleton_y.astype(np.int32, copy=False),
        skeleton_x=skeleton_x.astype(np.int32, copy=False),
        local_thickness_pixels=local_thickness_pixels,
        nearest_background_dy_pixels=nearest_background_dy_pixels,
        nearest_background_dx_pixels=nearest_background_dx_pixels,
        skeleton_degree=degrees.astype(np.uint8, copy=False),
        skeleton_component=skeleton_component.astype(np.int32, copy=False),
        border_components=border_components.astype(np.int32, copy=False),
        total_component_count=int(count),
    )


def prepare_mask_thickness_geometry(
    mask: Any,
    *,
    pixel_size_x_um: float | None = None,
    pixel_size_y_um: float | None = None,
) -> ThicknessGeometry:
    """Backward-compatible alias; calibration is intentionally artifact-external."""
    if pixel_size_x_um is not None:
        _calibration(pixel_size_x_um, pixel_size_y_um)
    return prepare_thickness_geometry(mask)


def thickness_geometry_to_arrays(
    geometry: ThicknessGeometry,
) -> dict[str, np.ndarray]:
    """Return a pickle-free payload suitable for ``np.savez_compressed``."""
    if not isinstance(geometry, ThicknessGeometry):
        raise TypeError("geometry must be a ThicknessGeometry")
    return {
        "schema_version": np.asarray(
            [THICKNESS_GEOMETRY_SCHEMA_VERSION], dtype=np.int16
        ),
        "shape": np.asarray(geometry.shape, dtype=np.int64),
        "skeleton_y": np.asarray(geometry.skeleton_y, dtype=np.int32),
        "skeleton_x": np.asarray(geometry.skeleton_x, dtype=np.int32),
        "local_thickness_pixels": np.asarray(
            geometry.local_thickness_pixels, dtype=np.float64
        ),
        "nearest_background_dy_pixels": np.asarray(
            geometry.nearest_background_dy_pixels, dtype=np.int32
        ),
        "nearest_background_dx_pixels": np.asarray(
            geometry.nearest_background_dx_pixels, dtype=np.int32
        ),
        "skeleton_degree": np.asarray(geometry.skeleton_degree, dtype=np.uint8),
        "skeleton_component": np.asarray(
            geometry.skeleton_component, dtype=np.int32
        ),
        "border_components": np.asarray(geometry.border_components, dtype=np.int32),
        "total_component_count": np.asarray(
            [geometry.total_component_count], dtype=np.int32
        ),
    }


def _geometry_from_mapping(values: Mapping[str, Any]) -> ThicknessGeometry:
    required = {
        "schema_version",
        "shape",
        "skeleton_y",
        "skeleton_x",
        "local_thickness_pixels",
        "nearest_background_dy_pixels",
        "nearest_background_dx_pixels",
        "skeleton_degree",
        "skeleton_component",
        "border_components",
        "total_component_count",
    }
    missing = sorted(required.difference(values.keys()))
    if missing:
        raise ValueError(f"Thickness geometry artifact is missing fields: {missing}")
    schema = np.asarray(values["schema_version"]).reshape(-1)
    if schema.size != 1 or int(schema[0]) != THICKNESS_GEOMETRY_SCHEMA_VERSION:
        raise ValueError("Unsupported thickness geometry artifact schema")
    shape_values = np.asarray(values["shape"], dtype=np.int64).reshape(-1)
    if shape_values.size != 2 or np.any(shape_values < 1):
        raise ValueError("Thickness geometry artifact has an invalid shape")
    shape = (int(shape_values[0]), int(shape_values[1]))

    arrays = {
        "skeleton_y": np.asarray(values["skeleton_y"], dtype=np.int32).reshape(-1),
        "skeleton_x": np.asarray(values["skeleton_x"], dtype=np.int32).reshape(-1),
        "local_thickness_pixels": np.asarray(
            values["local_thickness_pixels"], dtype=np.float64
        ).reshape(-1),
        "nearest_background_dy_pixels": np.asarray(
            values["nearest_background_dy_pixels"], dtype=np.int32
        ).reshape(-1),
        "nearest_background_dx_pixels": np.asarray(
            values["nearest_background_dx_pixels"], dtype=np.int32
        ).reshape(-1),
        "skeleton_degree": np.asarray(
            values["skeleton_degree"], dtype=np.uint8
        ).reshape(-1),
        "skeleton_component": np.asarray(
            values["skeleton_component"], dtype=np.int32
        ).reshape(-1),
    }
    lengths = {array.size for array in arrays.values()}
    if len(lengths) != 1 or not lengths:
        raise ValueError("Thickness geometry skeleton arrays have inconsistent lengths")
    if (
        np.any(arrays["skeleton_y"] < 0)
        or np.any(arrays["skeleton_y"] >= shape[0])
        or np.any(arrays["skeleton_x"] < 0)
        or np.any(arrays["skeleton_x"] >= shape[1])
    ):
        raise ValueError("Thickness geometry contains out-of-bounds skeleton points")
    if (
        not np.isfinite(arrays["local_thickness_pixels"]).all()
        or np.any(arrays["local_thickness_pixels"] <= 0)
    ):
        raise ValueError("Thickness geometry contains invalid pixel diameters")
    vector_diameter = 2.0 * np.hypot(
        arrays["nearest_background_dy_pixels"].astype(np.float64),
        arrays["nearest_background_dx_pixels"].astype(np.float64),
    )
    if not np.allclose(
        vector_diameter,
        arrays["local_thickness_pixels"],
        rtol=0,
        atol=1e-8,
    ):
        raise ValueError("Thickness geometry EDT vectors fail the pixel-distance check")
    border_components = np.asarray(
        values["border_components"], dtype=np.int32
    ).reshape(-1)
    total_count = np.asarray(values["total_component_count"]).reshape(-1)
    skeleton_count = next(iter(lengths))
    if (
        total_count.size != 1
        or int(total_count[0]) < 0
        or (skeleton_count == 0 and int(total_count[0]) != 0)
        or (skeleton_count > 0 and int(total_count[0]) < 1)
    ):
        raise ValueError("Thickness geometry has an invalid component count")

    return ThicknessGeometry(
        shape=shape,
        border_components=border_components,
        total_component_count=int(total_count[0]),
        **arrays,
    )


def load_thickness_geometry(
    source: str | Path | Mapping[str, Any] | Any,
) -> ThicknessGeometry:
    """Load a pickle-free NPZ artifact using NumPy only.

    ``source`` may be a path/file object accepted by ``numpy.load`` or an
    already-loaded mapping such as ``numpy.lib.npyio.NpzFile``.
    """
    if isinstance(source, Mapping) or (
        hasattr(source, "keys") and hasattr(source, "__getitem__")
    ):
        return _geometry_from_mapping(source)
    archive = np.load(source, allow_pickle=False)
    try:
        return _geometry_from_mapping(archive)
    finally:
        if hasattr(archive, "close"):
            archive.close()


def polygon_area_pixels(vertices: Any) -> float:
    polygon = _polygon(vertices)
    x, y = polygon[:, 0], polygon[:, 1]
    return float(
        0.5
        * abs(
            np.dot(x, np.roll(y, 1))
            - np.dot(y, np.roll(x, 1))
        )
    )


def _polygon(vertices: Any) -> np.ndarray:
    if isinstance(vertices, dict):
        selected = None
        for key in ("vertices", "points", "roi_vertices", "roiVertices"):
            if key in vertices and vertices[key] is not None:
                selected = vertices[key]
                break
        vertices = selected
    polygon = np.asarray(vertices, dtype=np.float64)
    if polygon.ndim != 2 or polygon.shape[0] < 3 or polygon.shape[1] != 2:
        raise ValueError("ROI must contain at least three [x,y] vertices")
    if not np.isfinite(polygon).all():
        raise ValueError("ROI vertices contain NaN or Inf")
    if np.array_equal(polygon[0], polygon[-1]):
        polygon = polygon[:-1]
    if polygon.shape[0] < 3:
        raise ValueError("ROI must contain at least three distinct vertices")
    x, y = polygon[:, 0], polygon[:, 1]
    area_twice = abs(np.dot(x, np.roll(y, 1)) - np.dot(y, np.roll(x, 1)))
    if not area_twice > 0:
        raise ValueError("ROI polygon has zero area")
    return polygon


def _points_in_polygon(
    point_x: np.ndarray,
    point_y: np.ndarray,
    vertices: np.ndarray,
) -> np.ndarray:
    """Vectorized even-odd polygon test with boundary points included."""
    x = np.asarray(point_x, dtype=np.float64)
    y = np.asarray(point_y, dtype=np.float64)
    polygon = _polygon(vertices)
    inside = np.zeros(x.shape, dtype=bool)
    boundary = np.zeros(x.shape, dtype=bool)
    scale = max(1.0, float(np.max(np.abs(polygon))))
    tolerance = np.finfo(np.float64).eps * scale * 32.0

    previous_x, previous_y = polygon[-1]
    for current_x, current_y in polygon:
        edge_x = current_x - previous_x
        edge_y = current_y - previous_y
        cross = (x - previous_x) * edge_y - (y - previous_y) * edge_x
        on_line = np.abs(cross) <= tolerance * max(
            1.0, abs(edge_x) + abs(edge_y)
        )
        in_box = (
            (x >= min(previous_x, current_x) - tolerance)
            & (x <= max(previous_x, current_x) + tolerance)
            & (y >= min(previous_y, current_y) - tolerance)
            & (y <= max(previous_y, current_y) + tolerance)
        )
        boundary |= on_line & in_box

        crosses_scanline = (current_y > y) != (previous_y > y)
        denominator = previous_y - current_y
        if denominator != 0:
            intersection_x = (
                (previous_x - current_x) * (y - current_y) / denominator
                + current_x
            )
            inside ^= crosses_scanline & (x < intersection_x)
        previous_x, previous_y = current_x, current_y
    return inside | boundary


def measure_gbm_thickness_from_geometry(
    geometry: ThicknessGeometry,
    roi_vertices: Any,
    *,
    pixel_size_x_um: float,
    pixel_size_y_um: float | None = None,
    expansion_factor: float = 1.0,
) -> dict[str, Any]:
    """Measure one ROI from a saved geometry artifact using NumPy only."""
    if not isinstance(geometry, ThicknessGeometry):
        raise TypeError("geometry must be a loaded ThicknessGeometry")
    polygon = _polygon(roi_vertices)
    size_x, size_y, expansion = _calibration(
        pixel_size_x_um,
        pixel_size_y_um,
        expansion_factor,
    )

    inside = _points_in_polygon(
        geometry.skeleton_x,
        geometry.skeleton_y,
        polygon,
    )
    if not inside.any():
        raise ValueError(
            "No segmented GBM centerline lies inside this ROI. "
            "Draw a larger ROI that crosses predicted GBM."
    )

    local_pixels = geometry.local_thickness_pixels[inside]
    dy_pixels = geometry.nearest_background_dy_pixels[inside].astype(np.float64)
    dx_pixels = geometry.nearest_background_dx_pixels[inside].astype(np.float64)
    observed_um = 2.0 * np.hypot(dy_pixels * size_y, dx_pixels * size_x)
    corrected_um = observed_um / expansion
    selected_degree = geometry.skeleton_degree[inside]
    selected_component = geometry.skeleton_component[inside]
    contributing_components = np.unique(selected_component)
    contributing_components = contributing_components[contributing_components != 0]
    border_selected = np.isin(selected_component, geometry.border_components)
    sample_count = int(local_pixels.size)
    sample_std = float(np.std(corrected_um, ddof=1)) if sample_count > 1 else 0.0
    roi_area_pixels2 = polygon_area_pixels(polygon)
    isotropic = math.isclose(size_x, size_y, rel_tol=0, abs_tol=1e-15)

    result = {
        # Stable API aliases consumed by the viewer.  The notebook-compatible
        # snake_case fields below remain the scientific/audit contract.
        "meanThickness": float(np.mean(corrected_um)),
        "meanThicknessUm": float(np.mean(corrected_um)),
        "meanThicknessPixels": float(np.mean(local_pixels)),
        "observedMeanThicknessUm": float(np.mean(observed_um)),
        "efAdjustedMeanThicknessUm": float(np.mean(corrected_um)),
        "unit": "µm",
        "sampleCount": sample_count,
        "measurement_method": (
            "2 * full-mask nearest-background EDT vector, skeleton-pixel mean "
            "at centerline samples inside ROI"
        ),
        "mean_thickness_pixels": float(np.mean(local_pixels)),
        "median_thickness_pixels": float(np.median(local_pixels)),
        "observed_mean_um": float(np.mean(observed_um)),
        "corrected_mean_um": float(np.mean(corrected_um)),
        "corrected_median_um": float(np.median(corrected_um)),
        "corrected_std_um": sample_std,
        "corrected_p05_um": float(np.percentile(corrected_um, 5)),
        "corrected_p95_um": float(np.percentile(corrected_um, 95)),
        "centerline_sample_count": sample_count,
        "contributing_component_count": int(contributing_components.size),
        "endpoint_sample_count": int(np.sum(selected_degree <= 1)),
        "junction_sample_count": int(np.sum(selected_degree > 2)),
        "border_component_sample_count": int(np.sum(border_selected)),
        "total_mask_component_count": int(geometry.total_component_count),
        "roi_area_pixels2": roi_area_pixels2,
        "roi_area_observed_um2": float(roi_area_pixels2 * size_x * size_y),
        "roi_area_corrected_um2": float(
            roi_area_pixels2 * size_x * size_y / (expansion**2)
        ),
        # Retain the notebook key for isotropic callers without misrepresenting
        # anisotropic data as having one scalar pixel size.
        "pixel_size_um_per_pixel": size_x if isotropic else None,
        "pixel_size_x_um_per_pixel": size_x,
        "pixel_size_y_um_per_pixel": size_y,
        "anisotropic_pixel_size": not isotropic,
        "physical_edt_sampling_yx_um": [size_y, size_x],
        "physical_diameter_calculation": (
            "2*hypot(nearest_background_dy_pixels*pixel_size_y_um, "
            "nearest_background_dx_pixels*pixel_size_x_um)"
        ),
        "linear_expansion_factor": expansion,
        "roi_vertices_source_pixels": polygon.tolist(),
        "quality_control": {
            "fewer_than_20_centerline_samples": sample_count < 20,
            "median_diameter_below_3_pixels": float(np.median(local_pixels)) < 3.0,
            "includes_border_component_samples": bool(np.any(border_selected)),
            "includes_endpoint_samples": bool(np.any(selected_degree <= 1)),
            "includes_junction_samples": bool(np.any(selected_degree > 2)),
        },
    }
    return result


def measure_gbm_thickness(
    mask: Any,
    roi_vertices: Any,
    *,
    pixel_size_x_um: float,
    pixel_size_y_um: float | None = None,
    expansion_factor: float = 1.0,
    geometry: ThicknessGeometry | None = None,
) -> dict[str, Any]:
    """Worker convenience wrapper that can prepare full-mask geometry on demand.

    Web/API processes should load the worker-produced NPZ and call
    :func:`measure_gbm_thickness_from_geometry` directly so they never import
    SciPy or scikit-image.
    """
    binary = _binary_mask(mask)
    if geometry is None:
        geometry = prepare_thickness_geometry(binary)
    elif tuple(geometry.shape) != tuple(binary.shape):
        raise ValueError("Cached mask geometry does not match the selected mask")
    return measure_gbm_thickness_from_geometry(
        geometry,
        roi_vertices,
        pixel_size_x_um=pixel_size_x_um,
        pixel_size_y_um=pixel_size_y_um,
        expansion_factor=expansion_factor,
    )


__all__ = [
    "THICKNESS_GEOMETRY_SCHEMA_VERSION",
    "ThicknessGeometry",
    "load_thickness_geometry",
    "measure_gbm_thickness",
    "measure_gbm_thickness_from_geometry",
    "polygon_area_pixels",
    "prepare_mask_thickness_geometry",
    "prepare_thickness_geometry",
    "thickness_geometry_to_arrays",
    "thickness_runtime_available",
]
