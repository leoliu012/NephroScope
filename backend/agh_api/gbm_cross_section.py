"""Decide which predicted GBM is a true cross-section, using the whole Z stack.

The GBM is a thin sheet folded in 3D. A plane only shows its true thickness
where the sheet crosses the plane perpendicularly. Tilted by an angle ``θ`` from
vertical, a sheet of thickness ``t`` looks wider (``t / cos θ``), and the
5-plane Z projection used for inference widens it further by the distance the
sheet drifts across the projection (``4 dz tan θ``). Lying flat, it becomes a
wide en-face patch. Thickness statistics are biased by all of these.

What matters is the tilt *at this plane*. A loop that is vertical here and curves
away further up or down is a true cross-section here, so tilt is the local slope
of the sheet's medial surface through Z. Each piece of centerline is followed into
neighbouring planes by finding the nearest centerline there, and its sideways
displacement along its own normal is recorded per plane:

* Displacement is signed. A tilted sheet moves steadily one way, whereas mask
  jitter between planes averages out. (Taking magnitudes would turn jitter into
  apparent tilt.)
* The slope is a local quadratic fit centred on this plane. Curvature goes into the
  quadratic term, so the equator of a sphere reads as vertical.
* Each piece is followed only while it stays the same sheet and has not moved more
  than its own thickness, so every piece measures its own usable Z window.
* The fit reports its standard error, so uncertain slopes carry less weight.

The whole field can also move between planes for reasons that have nothing to do with
the sheet. The stage or sample can slide during acquisition, and focusing can change the
magnification, which moves everything radially from the optical axis. Either would read
as tilt, because a piece's displacement along its normal gains that movement projected on
the normal. So it is measured first, from the raw planes (``estimate_field_motion``), and
planes are compared in register. The 5-plane projection each mask was predicted from is
still smeared by this movement; correcting that would mean predicting again from
registered planes.

Everything is stored in pixels per plane, so changing the pixel size or Z step
later needs no recomputation (``tan θ = stored * pixel_size / z_step``).

GBM is continuous, along its centerline and through Z, and decisions respect both. Each
piece of centerline gets a score from its tilt (weighted by how certain the slope is),
its width where the tilt is near the limit, and how line-like its part of the
prediction is. Then every piece of the stack is decided at once: the decisions chosen
are the ones that go against the least evidence, counting a fixed cost for each place
they change along a centerline and for each piece that differs from the same stretch of
sheet in a neighbouring plane. So a short noisy stretch of a long wall stays with the
wall, a stretch that is clearly tilted is excluded as a whole, and a reading that
appears in one plane only does not flicker in and out. Pieces are lengths of centerline
about two thicknesses long, starting at endpoints and junctions, and they are also what
a person clicks on.

SciPy is imported lazily, so importing this module stays cheap for the web API.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Sequence
import math

import numpy as np

from .gbm_thickness import ThicknessGeometry

ALGORITHM_VERSION = "gbm-cross-section-v4"
MIP_PLANES = 5
DEFAULT_MAX_WINDOW = 30
EN_FACE_TILT_DEG = 60.0
DEFAULT_MIN_THICKNESS_NM = 30.0
DEFAULT_MAX_THICKNESS_NM = 3400.0

# A piece is followed through Z until it has moved by this multiple of its own
# thickness, or is missing from two sampled planes in a row.
TRACK_MAX_MOVE = 1.0
TRACK_MAX_MISSES = 1
TRACK_MIN_HIT_FRACTION = 0.5
# Half-width of the local slope fit, in planes, as a fraction of thickness in pixels.
SLOPE_WINDOW_FRACTION = 0.5
SLOPE_MIN_WINDOW_PLANES = 4.0
# The medial point counts as inside a neighbouring mask up to this fraction of
# the thickness away, and may miss this many planes, so jitter and small holes
# in a prediction do not end its axial chord.
CHORD_TOLERANCE_FRACTION = 0.15
CHORD_MAX_MISSES = 1

# Field motion is measured between raw planes this far apart, in tiles of the field. Its
# shape is the same at any Z step, so this is in planes rather than micrometres.
MOTION_BASELINE_PLANES = 2
MOTION_DOWNSAMPLE = 2
MOTION_UPSAMPLE = 8
MOTION_TILES_PER_SIDE = 4
MOTION_FIT_ITERATIONS = 6
MOTION_MIN_TILES = 8
# How far tiles may scatter around the fit, over one baseline: below the first, scatter is
# only the registration's own resolution, and past the second there is no shared movement.
MOTION_MIN_SPREAD_PX = 0.25
MOTION_MAX_SPREAD_PX = 2.0
MOTION_SMOOTH_STEPS = 5
# Below this anywhere in the field, motion is not told apart from registration noise (about
# 2 degrees at a 0.1 µm pixel and 0.3 µm Z step), so a stack that does not move stays as it is.
MOTION_MIN_PX_PER_PLANE = 0.1

SAMPLE_OK = 0
SAMPLE_TAPER = 1
SAMPLE_SPUR = 2
SAMPLE_JUNCTION = 3


@dataclass
class StackPlane:
    """One saved prediction: its plane, Z projection centre, mask and geometry.

    ``registration`` is a 2 x 3 matrix taking ``(y, x, 1)`` in a frame shared by the
    whole stack to ``(y, x)`` in this plane. ``None`` means the two are the same.
    """

    z_index: int
    center: float
    mask: np.ndarray
    geometry: ThicknessGeometry
    registration: np.ndarray | None = None


@dataclass
class PlaneAnalysis:
    """Calibration-independent evidence for one plane."""

    z_index: int
    shape: tuple[int, int]
    sample_piece: np.ndarray
    sample_artifact: np.ndarray
    sample_tan_chord: np.ndarray
    sample_tan_drift: np.ndarray
    sample_tan_error: np.ndarray
    sample_chord_censored: np.ndarray
    sample_chord_planes: np.ndarray
    sample_window_planes: np.ndarray
    piece_samples: np.ndarray
    piece_center_x: np.ndarray
    piece_center_y: np.ndarray
    piece_width_px: np.ndarray
    piece_tan_chord: np.ndarray
    piece_tan_drift: np.ndarray
    piece_tan_error: np.ndarray
    piece_track_planes: np.ndarray
    piece_censored: np.ndarray
    piece_chord_planes: np.ndarray
    piece_artifact: np.ndarray
    piece_component_aspect: np.ndarray
    piece_cc_samples: np.ndarray
    piece_cc_span: np.ndarray
    piece_edges: np.ndarray
    neighbour_planes: int
    median_width_px: float
    # The same stretch of sheet in nearby analysed planes: ``piece_links[piece, column]`` is
    # a piece of plane ``link_z[column]``, or -1. Filled in by ``analyze_stack``.
    link_z: np.ndarray | None = None
    piece_links: np.ndarray | None = None
    # The piece of the stack's own analysis each piece came from, or -1. Pieces are only
    # cut differently where someone has corrected the plane.
    piece_origin: np.ndarray | None = None
    extra: dict = field(default_factory=dict)

    def __post_init__(self) -> None:
        count = int(np.asarray(self.piece_samples).size)
        if self.link_z is None:
            self.link_z = np.empty(0, dtype=np.int32)
        if self.piece_links is None:
            self.piece_links = np.full((count, int(np.asarray(self.link_z).size)), -1, dtype=np.int32)
        if self.piece_origin is None:
            self.piece_origin = np.arange(count, dtype=np.int32)

    def to_arrays(self) -> dict[str, np.ndarray]:
        return {
            "algorithm_version": np.asarray([ALGORITHM_VERSION]),
            "z_index": np.asarray([self.z_index], dtype=np.int32),
            "shape": np.asarray(self.shape, dtype=np.int32),
            "sample_piece": self.sample_piece.astype(np.int32),
            "sample_artifact": self.sample_artifact.astype(np.uint8),
            "sample_tan_chord": self.sample_tan_chord.astype(np.float32),
            "sample_tan_drift": self.sample_tan_drift.astype(np.float32),
            "sample_tan_error": self.sample_tan_error.astype(np.float32),
            "sample_chord_censored": self.sample_chord_censored.astype(bool),
            "sample_chord_planes": self.sample_chord_planes.astype(np.float32),
            "sample_window_planes": self.sample_window_planes.astype(np.float32),
            "piece_samples": self.piece_samples.astype(np.int32),
            "piece_center_x": self.piece_center_x.astype(np.float32),
            "piece_center_y": self.piece_center_y.astype(np.float32),
            "piece_width_px": self.piece_width_px.astype(np.float32),
            "piece_tan_chord": self.piece_tan_chord.astype(np.float32),
            "piece_tan_drift": self.piece_tan_drift.astype(np.float32),
            "piece_tan_error": self.piece_tan_error.astype(np.float32),
            "piece_track_planes": self.piece_track_planes.astype(np.float32),
            "piece_censored": self.piece_censored.astype(np.float32),
            "piece_chord_planes": self.piece_chord_planes.astype(np.float32),
            "piece_artifact": self.piece_artifact.astype(np.float32),
            "piece_component_aspect": self.piece_component_aspect.astype(np.float32),
            "piece_cc_samples": self.piece_cc_samples.astype(np.int64),
            "piece_cc_span": self.piece_cc_span.astype(np.float32),
            "piece_edges": self.piece_edges.astype(np.int32).reshape(-1, 2),
            "neighbour_planes": np.asarray([self.neighbour_planes], dtype=np.int32),
            "median_width_px": np.asarray([self.median_width_px], dtype=np.float32),
            "link_z": np.asarray(self.link_z, dtype=np.int32).reshape(-1),
            "piece_links": np.asarray(self.piece_links, dtype=np.int32).reshape(
                int(np.asarray(self.piece_samples).size), int(np.asarray(self.link_z).size),
            ),
            "piece_origin": np.asarray(self.piece_origin, dtype=np.int32).reshape(-1),
        }

    @classmethod
    def from_arrays(cls, values) -> "PlaneAnalysis":
        version = str(np.asarray(values["algorithm_version"]).reshape(-1)[0])
        if version != ALGORITHM_VERSION:
            raise ValueError(f"Unsupported cross-section artifact version: {version}")
        shape = np.asarray(values["shape"]).reshape(-1)
        return cls(
            z_index=int(np.asarray(values["z_index"]).reshape(-1)[0]),
            shape=(int(shape[0]), int(shape[1])),
            sample_piece=np.asarray(values["sample_piece"]),
            sample_artifact=np.asarray(values["sample_artifact"]),
            sample_tan_chord=np.asarray(values["sample_tan_chord"]),
            sample_tan_drift=np.asarray(values["sample_tan_drift"]),
            sample_tan_error=np.asarray(values["sample_tan_error"]),
            sample_chord_censored=np.asarray(values["sample_chord_censored"]),
            sample_chord_planes=np.asarray(values["sample_chord_planes"]),
            sample_window_planes=np.asarray(values["sample_window_planes"]),
            piece_samples=np.asarray(values["piece_samples"]),
            piece_center_x=np.asarray(values["piece_center_x"]),
            piece_center_y=np.asarray(values["piece_center_y"]),
            piece_width_px=np.asarray(values["piece_width_px"]),
            piece_tan_chord=np.asarray(values["piece_tan_chord"]),
            piece_tan_drift=np.asarray(values["piece_tan_drift"]),
            piece_tan_error=np.asarray(values["piece_tan_error"]),
            piece_track_planes=np.asarray(values["piece_track_planes"]),
            piece_censored=np.asarray(values["piece_censored"]),
            piece_chord_planes=np.asarray(values["piece_chord_planes"]),
            piece_artifact=np.asarray(values["piece_artifact"]),
            piece_component_aspect=np.asarray(values["piece_component_aspect"]),
            piece_cc_samples=np.asarray(values["piece_cc_samples"]),
            piece_cc_span=np.asarray(values["piece_cc_span"]),
            piece_edges=np.asarray(values["piece_edges"]).reshape(-1, 2),
            neighbour_planes=int(np.asarray(values["neighbour_planes"]).reshape(-1)[0]),
            median_width_px=float(np.asarray(values["median_width_px"]).reshape(-1)[0]),
            link_z=np.asarray(values["link_z"]).reshape(-1),
            piece_links=np.asarray(values["piece_links"]).reshape(
                int(np.asarray(values["piece_samples"]).size), int(np.asarray(values["link_z"]).size),
            ),
            piece_origin=np.asarray(values["piece_origin"]).reshape(-1),
        )


IDENTITY_REGISTRATION = np.array([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]])


def to_plane(registration: np.ndarray, y, x) -> tuple[np.ndarray, np.ndarray]:
    """Shared-frame coordinates in the plane with this registration."""
    m = registration
    return m[0, 0] * y + m[0, 1] * x + m[0, 2], m[1, 0] * y + m[1, 1] * x + m[1, 2]


def to_shared(registration: np.ndarray, y, x) -> tuple[np.ndarray, np.ndarray]:
    """Coordinates in the plane with this registration, in the shared frame."""
    m = registration
    dy, dx = y - m[0, 2], x - m[1, 2]
    determinant = m[0, 0] * m[1, 1] - m[0, 1] * m[1, 0]
    return (m[1, 1] * dy - m[0, 1] * dx) / determinant, (m[0, 0] * dx - m[1, 0] * dy) / determinant


@dataclass
class FieldMotion:
    """How the whole field moved through a stack.

    ``registration[i]`` takes the shared frame, which is the first plane sampled, to
    plane ``z[i]``. ``shape`` is the size of the field it was measured on.
    """

    z: np.ndarray
    registration: np.ndarray
    shape: tuple[int, int]

    def at(self, center: float) -> np.ndarray:
        """Registration of a plane at this Z, which need not have been sampled."""
        steps = self.registration.reshape(self.z.size, -1)
        values = [np.interp(center, self.z, steps[:, column]) for column in range(steps.shape[1])]
        return np.asarray(values, dtype=np.float64).reshape(2, 3)

    def px_per_plane(self) -> np.ndarray:
        """Largest movement anywhere in the field between each pair of sampled planes."""
        if self.z.size < 2:
            return np.empty(0)
        height, width = self.shape
        corners_y = np.asarray([0.0, 0.0, height, height])
        corners_x = np.asarray([0.0, width, 0.0, width])
        rates = []
        for index in range(self.z.size - 1):
            # The corners, as they appear in the earlier plane, moved to the later one.
            y0, x0 = to_shared(self.registration[index], corners_y, corners_x)
            y1, x1 = to_plane(self.registration[index + 1], y0, x0)
            rates.append(np.hypot(y1 - corners_y, x1 - corners_x).max() / (self.z[index + 1] - self.z[index]))
        return np.asarray(rates)


def _motion_plane(plane: np.ndarray) -> np.ndarray | None:
    """A plane ready to register, or ``None`` if there is nothing in it to register."""
    low_resolution = np.asarray(plane, dtype=np.float32)[::MOTION_DOWNSAMPLE, ::MOTION_DOWNSAMPLE]
    low, high = np.percentile(low_resolution, (1.0, 99.7))
    if not high > low:
        return None
    return np.clip((low_resolution - low) / (high - low), 0.0, 1.0)


def _tile_shifts(reference: np.ndarray, moving: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Tile centres, and where each tile of ``reference`` appears in ``moving``, in full-resolution pixels.

    Phase correlation weighs fine structure, which sits still unless the field moves, over
    large bright bodies, which change shape through Z and pull a plain correlation with them.
    """
    from skimage.registration import phase_cross_correlation

    height, width = reference.shape
    tiles = MOTION_TILES_PER_SIDE
    centers, shifts = [], []
    window = None
    for row in range(tiles):
        for column in range(tiles):
            area = (
                slice(row * height // tiles, (row + 1) * height // tiles),
                slice(column * width // tiles, (column + 1) * width // tiles),
            )
            first, second = reference[area], moving[area]
            if first.std() < 1e-3 or second.std() < 1e-3:
                continue
            if window is None or window.shape != first.shape:
                window = np.outer(np.hanning(first.shape[0]), np.hanning(first.shape[1])).astype(np.float32)
            shift, _, _ = phase_cross_correlation(
                (first - first.mean()) * window, (second - second.mean()) * window,
                upsample_factor=MOTION_UPSAMPLE, normalization="phase",
            )
            # phase_cross_correlation says how to move ``moving`` back onto ``reference``.
            shifts.append(-np.asarray(shift, dtype=np.float64) * MOTION_DOWNSAMPLE)
            centers.append(((area[0].start + area[0].stop) * 0.5 * MOTION_DOWNSAMPLE, (area[1].start + area[1].stop) * 0.5 * MOTION_DOWNSAMPLE))
    return np.asarray(centers, dtype=np.float64).reshape(-1, 2), np.asarray(shifts, dtype=np.float64).reshape(-1, 2)


def _fit_field_motion(centers: np.ndarray, shifts: np.ndarray, middle: tuple[float, float]) -> np.ndarray | None:
    """Fit ``shift = (ty, tx) + scale * r + rotation * r_perp``, robustly, with r from mid-field.

    Returned as ``(ty, tx, scale, rotation)``, or ``None`` when the tiles do not agree on any
    such movement, as happens where the tissue ends. A rigid slide and a change of
    magnification are all this allows, because a freer fit would start to absorb real
    tissue geometry. A tile that disagrees, as one showing a large oblique sheet does,
    loses its weight entirely.
    """
    count = centers.shape[0]
    if count < MOTION_MIN_TILES:
        return None
    ry, rx = centers[:, 0] - middle[0], centers[:, 1] - middle[1]
    reach = max(float(np.abs(ry).max()), float(np.abs(rx).max()), 1.0)
    design = np.zeros((2 * count, 4))
    design[:count, 0] = 1.0
    design[count:, 1] = 1.0
    # In units of the field's size, so the four parameters are of similar size to the solver.
    design[:count, 2], design[count:, 2] = ry / reach, rx / reach
    design[:count, 3], design[count:, 3] = -rx / reach, ry / reach
    target = np.concatenate([shifts[:, 0], shifts[:, 1]])
    solution = np.array([np.median(shifts[:, 0]), np.median(shifts[:, 1]), 0.0, 0.0])
    spread = 0.0
    for _ in range(MOTION_FIT_ITERATIONS):
        residual = target - design @ solution
        spread = max(1.4826 * float(np.median(np.abs(residual))), MOTION_MIN_SPREAD_PX)
        scaled = residual / (4.685 * spread)
        weights = np.where(np.abs(scaled) < 1.0, (1.0 - scaled ** 2) ** 2, 0.0)
        if np.count_nonzero(weights) < 2 * MOTION_MIN_TILES:
            return None
        root = np.sqrt(weights)
        solution = np.linalg.lstsq(design * root[:, None], target * root, rcond=None)[0]
    if spread > MOTION_MAX_SPREAD_PX:
        return None
    return solution / np.array([1.0, 1.0, reach, reach])


def estimate_field_motion(read_plane, z_low: int, z_high: int, *, progress=None) -> FieldMotion | None:
    """Measure how the whole field moves between ``z_low`` and ``z_high``.

    ``read_plane(z)`` returns one raw plane. Single planes are used rather than Z
    projections, because neighbouring projections share planes and those shared planes
    pull the registration towards no movement at all. Returns ``None`` if the stack has
    too little in it to measure.
    """
    z_low, z_high = int(z_low), int(z_high)
    if z_high <= z_low:
        return None
    positions = list(range(z_low, z_high, MOTION_BASELINE_PLANES)) + [z_high]
    rates = np.full((len(positions) - 1, 4), np.nan)
    previous = None
    shape = None
    for index, z in enumerate(positions):
        plane = read_plane(z)
        shape = tuple(int(size) for size in np.shape(plane)[:2])
        current = _motion_plane(plane)
        if previous is not None and current is not None:
            centers, shifts = _tile_shifts(previous, current)
            fitted = _fit_field_motion(centers, shifts, (shape[0] * 0.5, shape[1] * 0.5))
            if fitted is not None:
                rates[index - 1] = fitted / float(z - positions[index - 1])
        previous = current
        if progress:
            progress((index + 1) / len(positions), "Measuring field motion")
    measured = np.isfinite(rates[:, 0])
    if not measured.any():
        return None
    # A step with no agreement between its tiles carries on from the steps around it.
    steps = np.arange(rates.shape[0])
    for column in range(rates.shape[1]):
        rates[:, column] = np.interp(steps, steps[measured], rates[measured, column])
    # Movement is steady over a few planes, so a lone reading follows its neighbours.
    smooth = np.zeros_like(rates)
    reach = MOTION_SMOOTH_STEPS // 2
    for step in steps:
        smooth[step] = np.median(rates[max(0, step - reach):step + reach + 1], axis=0)
    corner = math.hypot(shape[0] * 0.5, shape[1] * 0.5)
    largest = np.hypot(smooth[:, 0], smooth[:, 1]) + np.hypot(smooth[:, 2], smooth[:, 3]) * corner
    smooth[largest < MOTION_MIN_PX_PER_PLANE] = 0.0

    middle_y, middle_x = shape[0] * 0.5, shape[1] * 0.5
    registration = np.empty((len(positions), 2, 3))
    registration[0] = IDENTITY_REGISTRATION
    for step in range(rates.shape[0]):
        ty, tx, scale, rotation = smooth[step] * float(positions[step + 1] - positions[step])
        # p' = p + t + [scale, -rotation; rotation, scale] applied to p from mid-field.
        linear = np.array([[1.0 + scale, -rotation], [rotation, 1.0 + scale]])
        moved = np.array([middle_y + ty, middle_x + tx]) - linear @ np.array([middle_y, middle_x])
        before = registration[step]
        registration[step + 1, :, :2] = linear @ before[:, :2]
        registration[step + 1, :, 2] = linear @ before[:, 2] + moved
    return FieldMotion(np.asarray(positions, dtype=np.float64), registration, shape)


def signed_distance(mask: np.ndarray, factor: int) -> np.ndarray:
    """Signed distance in full-resolution pixels: negative inside, positive outside."""
    from scipy.ndimage import distance_transform_edt

    low = np.asarray(mask, dtype=bool)[::factor, ::factor]
    if not low.any():
        return np.full(low.shape, 1e4, np.float32)
    outside = distance_transform_edt(~low)
    inside = distance_transform_edt(low)
    return ((outside - inside) * factor).astype(np.float32)


def working_factor(median_width_px: float) -> int:
    """Downsample so the thickness keeps about a dozen pixels."""
    return int(np.clip(round(float(median_width_px) / 12.0), 1, 4))


def _probe(field_: np.ndarray, y: np.ndarray, x: np.ndarray, factor: int) -> np.ndarray:
    iy = np.clip(np.round(y / factor).astype(np.int64), 0, field_.shape[0] - 1)
    ix = np.clip(np.round(x / factor).astype(np.int64), 0, field_.shape[1] - 1)
    return field_[iy, ix].astype(np.float64)


def _axial_chord(
    y: np.ndarray,
    x: np.ndarray,
    width: np.ndarray,
    distance_fields: Sequence[np.ndarray],
    relative: np.ndarray,
    usable: np.ndarray,
    factor: int,
    typical_width: float,
    registrations: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Length of the mask along Z through each medial point, per direction.

    ``y`` and ``x`` are in the stack's shared frame, and ``registrations`` puts them in each plane.
    """
    count = y.size
    # Bounded by the typical thickness: a wide patch must not gain a tolerance
    # large enough to reach a neighbouring wall.
    tolerance = CHORD_TOLERANCE_FRACTION * np.minimum(width, typical_width)

    def follow(planes: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        length = np.zeros(count)
        open_ended = np.ones(count, dtype=bool)
        alive = np.ones(count, dtype=bool)
        misses = np.zeros(count, dtype=np.int32)
        for index in planes:
            plane_y, plane_x = to_plane(registrations[index], y, x)
            inside = _probe(distance_fields[index], plane_y, plane_x, factor) <= tolerance
            misses = np.where(inside, 0, misses + 1)
            ended = alive & (misses > CHORD_MAX_MISSES)
            open_ended[ended] = False
            alive &= ~ended
            length = np.where(alive & inside, abs(relative[index]), length)
        return length, open_ended

    above = usable[relative[usable] > 0]
    above = above[np.argsort(relative[above])]
    below = usable[relative[usable] < 0]
    below = below[np.argsort(-relative[below])]
    up, open_up = follow(above)
    down, open_down = follow(below)
    return up, down, open_up, open_down


def _chord_planes(up: np.ndarray, down: np.ndarray, open_up: np.ndarray, open_down: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Planes the medial point stays inside the mask, and whether that ran off the stack."""
    return up + down + 1.0, open_up | open_down


def _group_median(values: np.ndarray, groups: np.ndarray, count: int) -> tuple[np.ndarray, np.ndarray]:
    """Median per group, with the number of values in each."""
    medians = np.full(count, np.nan)
    sizes = np.bincount(groups, minlength=count)
    if values.size == 0:
        return medians, sizes
    order = np.lexsort((values, groups))
    ordered = values[order]
    starts = np.concatenate([[0], np.cumsum(sizes)])
    present = np.nonzero(sizes)[0]
    low = starts[present] + (sizes[present] - 1) // 2
    high = starts[present] + sizes[present] // 2
    medians[present] = 0.5 * (ordered[low] + ordered[high])
    return medians, sizes


def _piece_normals(x: np.ndarray, y: np.ndarray, piece: np.ndarray, count: int) -> tuple[np.ndarray, np.ndarray]:
    """Unit normal of each piece, from the principal axis of its centerline."""
    size = np.maximum(np.bincount(piece, minlength=count), 1).astype(np.float64)
    mean_x = np.bincount(piece, x, minlength=count) / size
    mean_y = np.bincount(piece, y, minlength=count) / size
    dx, dy = x - mean_x[piece], y - mean_y[piece]
    sxx = np.bincount(piece, dx * dx, minlength=count)
    syy = np.bincount(piece, dy * dy, minlength=count)
    sxy = np.bincount(piece, dx * dy, minlength=count)
    angle = 0.5 * np.arctan2(2.0 * sxy, sxx - syy)
    return -np.sin(angle), np.cos(angle)


def _probe_samples(piece: np.ndarray, count: int, per_piece: int = 12) -> np.ndarray:
    """A spread of up to ``per_piece`` centerline samples from every piece."""
    size = np.bincount(piece, minlength=count)
    order = np.argsort(piece, kind="stable")
    starts = np.concatenate([[0], np.cumsum(size)[:-1]])
    rank = np.empty(piece.size, dtype=np.int64)
    rank[order] = np.arange(piece.size) - starts[piece[order]]
    stride = np.maximum(size // per_piece, 1)
    return np.nonzero(rank % stride[piece] == 0)[0]


def _track_pieces(
    x: np.ndarray,
    y: np.ndarray,
    piece: np.ndarray,
    piece_count: int,
    width: np.ndarray,
    trees: Sequence[Any],
    positions: Sequence[np.ndarray],
    relative: np.ndarray,
    usable: np.ndarray,
) -> np.ndarray:
    """Signed sideways displacement of each piece in each usable plane (NaN if lost)."""
    normal_x, normal_y = _piece_normals(x, y, piece, piece_count)
    displacement = np.full((piece_count, usable.size), np.nan)
    radius = np.maximum(TRACK_MAX_MOVE * width, 6.0)
    probes = _probe_samples(piece, piece_count)
    probe_piece = piece[probes]
    probe_x = x[probes].astype(np.float64)
    probe_y = y[probes].astype(np.float64)
    column_of = {int(plane): column for column, plane in enumerate(usable)}
    above = usable[relative[usable] > 0]
    below = usable[relative[usable] < 0]
    for direction in (above[np.argsort(relative[above])], below[np.argsort(-relative[below])]):
        current = np.zeros(piece_count)
        misses = np.zeros(piece_count, dtype=np.int32)
        alive = np.ones(piece_count, dtype=bool)
        for plane in direction:
            active = alive[probe_piece]
            if not active.any():
                break
            ok = np.zeros(piece_count, dtype=bool)
            if trees[plane] is not None:
                groups = probe_piece[active]
                shift = current[groups]
                sx, sy = normal_x[groups], normal_y[groups]
                query = np.column_stack([probe_x[active] + sx * shift, probe_y[active] + sy * shift])
                distance, nearest = trees[plane].query(query, distance_upper_bound=float(radius.max()))
                found = distance <= radius[groups]
                if found.any():
                    target = positions[plane][nearest[found]]
                    moved = (target[:, 0] - probe_x[active][found]) * sx[found] + (target[:, 1] - probe_y[active][found]) * sy[found]
                    median, hits = _group_median(moved, groups[found], piece_count)
                    wanted = np.bincount(groups, minlength=piece_count)
                    ok = alive & (hits >= TRACK_MIN_HIT_FRACTION * np.maximum(wanted, 1)) & (hits > 0)
                    displacement[ok, column_of[int(plane)]] = median[ok]
                    current[ok] = median[ok]
            misses = np.where(ok, 0, misses + 1)
            alive &= (misses <= TRACK_MAX_MISSES) & (np.abs(current) <= TRACK_MAX_MOVE * width)
    return displacement


def _local_slope(
    displacement: np.ndarray,
    steps: np.ndarray,
    half_window: np.ndarray,
    correlated_planes: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Slope at this plane with its standard error, the Z reach used, and its sign, per piece.

    A robust local fit ``d = a + b k + c k²``, weighted towards this plane. The piece
    itself counts as one point at ``k = 0``. Without enough support on both sides
    the curvature term cannot be told from the slope, so the fit is linear there.
    The last value is the slope with its sign, along the piece's own normal.
    """
    count = displacement.shape[0]
    slope = np.full(count, np.nan)
    error = np.full(count, np.nan)
    reach = np.zeros(count)
    signed = np.full(count, np.nan)
    if displacement.shape[1] == 0 or count == 0:
        return slope, error, reach, signed
    k = np.broadcast_to(steps, displacement.shape)
    scaled = k / half_window[:, None]
    weights = np.where(np.abs(scaled) < 1.0, (1.0 - scaled ** 2) ** 2, 0.0)
    weights = np.where(np.isfinite(displacement), weights, 0.0)
    values = np.nan_to_num(displacement)
    # The piece's own position, as a point at k = 0.
    k = np.column_stack([k, np.zeros(count)])
    values = np.column_stack([values, np.zeros(count)])
    weights = np.column_stack([weights, np.ones(count)])
    sampled = weights[:, :-1] > 0
    above = (sampled & (k[:, :-1] > 0)).sum(axis=1)
    below = (sampled & (k[:, :-1] < 0)).sum(axis=1)
    quadratic = (above >= 2) & (below >= 2)
    linear = ~quadratic & (above + below >= 2)
    for mask, terms in ((quadratic, 3), (linear, 2)):
        rows = np.nonzero(mask)[0]
        if rows.size == 0:
            continue
        design = np.stack([k[rows] ** power for power in range(terms)], axis=-1)
        y = values[rows]
        robust = weights[rows].copy()
        for _ in range(3):
            xtw = design * robust[..., None]
            normal = np.einsum("nki,nkj->nij", xtw, design) + 1e-9 * np.eye(terms)
            beta = np.linalg.solve(normal, np.einsum("nki,nk->ni", xtw, y)[..., None])[..., 0]
            residual = y - np.einsum("nki,ni->nk", design, beta)
            used = weights[rows] > 0
            spread = np.where(used, np.abs(residual), np.nan)
            scale = np.maximum(1.4826 * np.nanmedian(spread, axis=1), 0.5)
            robust = weights[rows] * np.minimum(1.0, 2.0 * scale[:, None] / np.maximum(np.abs(residual), 1e-9))
        slope[rows] = np.abs(beta[:, 1])
        signed[rows] = beta[:, 1]
        total = robust.sum(axis=1)
        degrees = np.maximum(total - terms, 1.0)
        variance = np.maximum((robust * residual ** 2).sum(axis=1) / degrees, 0.25)
        inverse = np.linalg.inv(np.einsum("nki,nkj->nij", design * robust[..., None], design) + 1e-9 * np.eye(terms))
        # The Z projection shares planes between slices, so nearby slices repeat
        # each other's noise and count for less than independent points would.
        error[rows] = np.sqrt(variance * inverse[:, 1, 1] * correlated_planes)
        reach[rows] = np.max(np.abs(k[rows]) * (weights[rows] > 0), axis=1)
    return slope, error, reach, signed


def _skeleton_graph(y: np.ndarray, x: np.ndarray, shape: tuple[int, int]):
    from scipy.sparse import coo_matrix

    index = np.full(shape, -1, dtype=np.int32)
    index[y, x] = np.arange(y.size, dtype=np.int32)
    rows, cols, weights = [], [], []
    for dy, dx in ((0, 1), (1, 0), (1, 1), (1, -1)):
        ny, nx = y + dy, x + dx
        valid = (ny >= 0) & (ny < shape[0]) & (nx >= 0) & (nx < shape[1])
        source = np.nonzero(valid)[0]
        target = index[ny[valid], nx[valid]]
        linked = target >= 0
        rows.append(source[linked])
        cols.append(target[linked])
        weights.append(np.full(int(linked.sum()), math.hypot(dy, dx)))
    row = np.concatenate(rows) if rows else np.empty(0, dtype=np.int32)
    col = np.concatenate(cols) if cols else np.empty(0, dtype=np.int32)
    weight = np.concatenate(weights) if weights else np.empty(0)
    graph = coo_matrix(
        (np.concatenate([weight, weight]), (np.concatenate([row, col]), np.concatenate([col, row]))),
        shape=(y.size, y.size),
    ).tocsr()
    return graph, index


def build_pieces(geometry: ThicknessGeometry) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Cut the centerline into pieces and flag samples that are medial-axis artefacts.

    Returns per-sample piece ids, per-sample artefact codes, and adjacent piece
    pairs. Pieces start at endpoints and junctions and run about two local
    thicknesses, so they follow the sheet instead of a grid.
    """
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components, dijkstra

    y = geometry.skeleton_y.astype(np.int64)
    x = geometry.skeleton_x.astype(np.int64)
    count = y.size
    artifact = np.zeros(count, dtype=np.uint8)
    if count == 0:
        return np.empty(0, dtype=np.int32), artifact, np.empty((0, 2), dtype=np.int32)
    width = geometry.local_thickness_pixels.astype(np.float64)
    degree = geometry.skeleton_degree.astype(np.int32)
    graph, _ = _skeleton_graph(y, x, tuple(geometry.shape))
    endpoints = degree <= 1
    junctions = degree >= 3

    # Cut at junctions, then measure along each remaining branch.
    keep = ~junctions
    coo = graph.tocoo()
    selected = keep[coo.row] & keep[coo.col]
    cut = coo_matrix((coo.data[selected], (coo.row[selected], coo.col[selected])), shape=graph.shape).tocsr()
    branch_count, branch = connected_components(cut, directed=False)

    branch_size = np.bincount(branch, minlength=branch_count)
    order = np.argsort(branch, kind="stable")
    boundaries = np.searchsorted(branch[order], np.arange(branch_count + 1))
    branch_width = np.zeros(branch_count)
    for label in range(branch_count):
        members = order[boundaries[label]:boundaries[label + 1]]
        branch_width[label] = np.median(width[members])
    median_width = float(np.median(width))
    chunk = float(np.clip(2.0 * median_width, 24.0, 160.0))

    # Terminals of each branch: its endpoints, or samples touching a junction.
    touches_junction = np.zeros(count, dtype=bool)
    if junctions.any():
        coo_all = graph.tocoo()
        touches_junction[coo_all.row[junctions[coo_all.col]]] = True
    terminal = (endpoints | touches_junction) & keep
    seen_branch = np.zeros(branch_count, dtype=bool)
    seen_branch[branch[terminal]] = True
    extra_terminals = []
    for label in np.nonzero(~seen_branch)[0]:
        members = order[boundaries[label]:boundaries[label + 1]]
        if members.size and keep[members[0]]:
            extra_terminals.append(int(members[0]))
    sources = np.concatenate([np.nonzero(terminal)[0], np.asarray(extra_terminals, dtype=np.int64)])
    distance = np.zeros(count)
    source_of = np.arange(count)
    if sources.size:
        distance, _, source_of = dijkstra(cut, directed=False, indices=sources, min_only=True, return_predecessors=True)
    finite = np.isfinite(distance)
    distance = np.where(finite, distance, 0.0)
    source_of = np.where(finite & (source_of >= 0), source_of, np.arange(count))

    # Medial-axis artefacts.
    if endpoints.any():
        tip_distance = np.full(count, np.inf)
        endpoint_terminals = np.nonzero(endpoints & keep)[0]
        if endpoint_terminals.size:
            tip_distance = dijkstra(cut, directed=False, indices=endpoint_terminals, min_only=True)
        local = branch_width[branch]
        taper = (tip_distance <= local) & (width < 0.85 * local)
        artifact[taper] = SAMPLE_TAPER
    for label in range(branch_count):
        members = order[boundaries[label]:boundaries[label + 1]]
        if members.size == 0:
            continue
        has_tip = bool(endpoints[members].any())
        has_junction = bool(touches_junction[members].any())
        if has_tip and has_junction and branch_size[label] < 1.2 * float(np.max(width[members])):
            artifact[members] = SAMPLE_SPUR
    if junctions.any():
        near = dijkstra(graph, directed=False, indices=np.nonzero(junctions)[0], min_only=True)
        local = np.where(keep, branch_width[branch], median_width)
        artifact[(near <= 0.5 * width) & (width > 1.15 * local) & (artifact == 0)] = SAMPLE_JUNCTION
        artifact[junctions & (artifact == 0)] = SAMPLE_JUNCTION

    # Pieces: one branch-end source and a whole number of chunks along it.
    keys = np.stack([source_of, (distance // chunk).astype(np.int64)], axis=1)
    _, piece = np.unique(keys, axis=0, return_inverse=True)
    piece = piece.reshape(-1).astype(np.int32)
    if junctions.any():
        # A junction sample joins the piece of its nearest non-junction neighbour.
        coo_all = graph.tocoo()
        joined = piece.copy()
        from_keep = keep[coo_all.col] & junctions[coo_all.row]
        joined[coo_all.row[from_keep]] = piece[coo_all.col[from_keep]]
        piece = joined
    _, piece = np.unique(piece, return_inverse=True)
    piece = piece.astype(np.int32).reshape(-1)

    coo_all = graph.tocoo()
    different = piece[coo_all.row] != piece[coo_all.col]
    if different.any():
        pairs = np.stack([piece[coo_all.row[different]], piece[coo_all.col[different]]], axis=1)
        pairs = np.unique(np.sort(pairs, axis=1), axis=0).astype(np.int32)
    else:
        pairs = np.empty((0, 2), dtype=np.int32)
    return piece, artifact, pairs


def _aggregate(piece: np.ndarray, count: int, values: np.ndarray, usable: np.ndarray) -> np.ndarray:
    """Median of ``values`` per piece, using usable samples where there are any."""
    output = np.full(count, np.nan)
    order = np.lexsort((values, piece))
    sorted_piece = piece[order]
    sorted_values = values[order]
    sorted_use = usable[order]
    starts = np.searchsorted(sorted_piece, np.arange(count + 1))
    for label in range(count):
        chunk_values = sorted_values[starts[label]:starts[label + 1]]
        chunk_use = sorted_use[starts[label]:starts[label + 1]]
        selection = chunk_values[chunk_use & np.isfinite(chunk_values)]
        if selection.size == 0:
            selection = chunk_values[np.isfinite(chunk_values)]
        if selection.size:
            output[label] = float(np.median(selection))
    return output


def _component_aspect(geometry: ThicknessGeometry, median_width: float) -> np.ndarray:
    """Centerline length over thickness of each sample's connected mask component."""
    component = geometry.skeleton_component.astype(np.int64)
    if component.size == 0:
        return np.empty(0)
    width = geometry.local_thickness_pixels.astype(np.float64)
    size = np.bincount(component)
    total_width = np.bincount(component, weights=width)
    mean_width = total_width / np.maximum(size, 1)
    return (size / np.maximum(mean_width, 1.0))[component]


def _registration_of(plane: StackPlane) -> np.ndarray:
    return IDENTITY_REGISTRATION if plane.registration is None else np.asarray(plane.registration, dtype=np.float64)


def _connected_3d(planes: Sequence[StackPlane]) -> tuple[list[np.ndarray], np.ndarray, np.ndarray]:
    """3D components of the stack, with their centerline sample count and Z span."""
    from scipy.ndimage import label as component_label

    from scipy.ndimage import affine_transform

    factor = 4
    lowered = [np.asarray(plane.mask, dtype=bool)[::factor, ::factor] for plane in planes]
    height, width = lowered[0].shape
    registrations = np.asarray([_registration_of(plane) for plane in planes])
    # In register, on a canvas large enough for every plane, at the masks' low resolution.
    corners_y = np.asarray([0.0, 0.0, height * factor, height * factor])
    corners_x = np.asarray([0.0, width * factor, 0.0, width * factor])
    reached = [to_shared(registration, corners_y, corners_x) for registration in registrations]
    origin_y = min(float(y.min()) for y, _ in reached)
    origin_x = min(float(x.min()) for _, x in reached)
    canvas = (
        int(math.ceil((max(float(y.max()) for y, _ in reached) - origin_y) / factor)) + 1,
        int(math.ceil((max(float(x.max()) for _, x in reached) - origin_x) / factor)) + 1,
    )
    volume = np.zeros((len(planes), *canvas), dtype=bool)
    for index, mask in enumerate(lowered):
        matrix = registrations[index]
        if np.array_equal(matrix, IDENTITY_REGISTRATION) and origin_y == 0.0 and origin_x == 0.0:
            volume[index, :height, :width] = mask
            continue
        # Canvas pixel -> shared frame -> plane -> low-resolution plane pixel.
        linear = matrix[:, :2]
        offset = (linear @ np.array([origin_y, origin_x]) + matrix[:, 2]) / factor
        volume[index] = affine_transform(mask, linear, offset=offset, output_shape=canvas, order=0, mode="constant", cval=False, output=bool)
    labels, count = component_label(volume, structure=np.ones((3, 3, 3), dtype=np.uint8))
    samples = np.zeros(count + 1, dtype=np.int64)
    low = np.full(count + 1, np.inf)
    high = np.full(count + 1, -np.inf)
    per_plane = []
    for index, plane in enumerate(planes):
        shared_y, shared_x = to_shared(registrations[index], plane.geometry.skeleton_y.astype(np.float64), plane.geometry.skeleton_x.astype(np.float64))
        y = np.clip(((shared_y - origin_y) / factor).astype(np.int64), 0, canvas[0] - 1)
        x = np.clip(((shared_x - origin_x) / factor).astype(np.int64), 0, canvas[1] - 1)
        ids = labels[index, y, x].astype(np.int64)
        per_plane.append(ids)
        if ids.size:
            samples += np.bincount(ids, minlength=count + 1)
            present = np.unique(ids)
            low[present] = np.minimum(low[present], plane.center)
            high[present] = np.maximum(high[present], plane.center)
    span = np.where(np.isfinite(low), high - low + 1.0, 0.0)
    return per_plane, samples, span


def analyze_stack(
    planes: Sequence[StackPlane],
    *,
    max_window: int = DEFAULT_MAX_WINDOW,
    progress=None,
) -> dict[int, PlaneAnalysis]:
    """Measure orientation evidence for every plane from every other plane."""
    planes = sorted(planes, key=lambda plane: (plane.center, plane.z_index))
    if not planes:
        return {}
    centers = np.asarray([plane.center for plane in planes], dtype=np.float64)
    registrations = np.asarray([_registration_of(plane) for plane in planes])
    widths = [plane.geometry.local_thickness_pixels for plane in planes if plane.geometry.skeleton_y.size]
    median_width = float(np.median(np.concatenate(widths))) if widths else 0.0
    factor = working_factor(median_width) if median_width else 1
    fields = []
    built = []
    trees: list[Any] = []
    positions: list[np.ndarray] = []
    from scipy.spatial import cKDTree

    for index, plane in enumerate(planes):
        fields.append(signed_distance(plane.mask, factor))
        piece, artifact, edges = build_pieces(plane.geometry)
        built.append((piece, artifact, edges))
        clean = artifact == SAMPLE_OK
        # Centerlines are compared across planes in the stack's shared frame.
        shared_y, shared_x = to_shared(
            registrations[index], plane.geometry.skeleton_y[clean].astype(np.float64), plane.geometry.skeleton_x[clean].astype(np.float64),
        )
        where = np.column_stack([shared_x, shared_y])
        positions.append(where)
        trees.append(cKDTree(where) if where.size else None)
        if progress:
            progress(0.4 * (index + 1) / len(planes), "Reading neighbouring Z predictions")
    cc_ids, cc_samples, cc_span = _connected_3d(planes)
    spacing = float(np.median(np.diff(centers))) if centers.size > 1 else 1.0

    results: dict[int, PlaneAnalysis] = {}
    positions_of: list[dict[str, Any]] = []
    for index, plane in enumerate(planes):
        geometry = plane.geometry
        y = geometry.skeleton_y.astype(np.int64)
        x = geometry.skeleton_x.astype(np.int64)
        count = y.size
        width = geometry.local_thickness_pixels.astype(np.float64)
        relative = centers - centers[index]
        usable = np.nonzero((np.abs(relative) <= max_window) & (np.abs(relative) > 1e-6))[0]
        piece, artifact, edges = built[index]
        piece_count = int(piece.max()) + 1 if count else 0
        clean = artifact == SAMPLE_OK
        piece_width = _aggregate(piece, piece_count, width, clean)
        slope = np.full(piece_count, np.nan)
        error = np.full(piece_count, np.nan)
        reach = np.zeros(piece_count)
        signed = np.full(piece_count, np.nan)
        track_planes = np.ones(piece_count)
        shared_y, shared_x = to_shared(registrations[index], y.astype(np.float64), x.astype(np.float64))
        if usable.size and count:
            up, down, open_up, open_down = _axial_chord(
                shared_y, shared_x, width, fields, relative, usable, factor, median_width, registrations,
            )
            chord_planes, censored = _chord_planes(up, down, open_up, open_down)
            tan_chord = width / np.maximum(chord_planes, 1.0)
            track_width = np.where(np.isfinite(piece_width), piece_width, median_width)
            displacement = _track_pieces(shared_x, shared_y, piece, piece_count, track_width, trees, positions, relative, usable)
            half_window = np.clip(
                np.maximum(SLOPE_WINDOW_FRACTION * track_width, max(SLOPE_MIN_WINDOW_PLANES, 2.0 * spacing) + 1.0),
                1.0, float(max_window) + 1.0,
            )
            slope, error, reach, signed = _local_slope(
                displacement, relative[usable], half_window, max(1.0, MIP_PLANES / max(spacing, 1.0)),
            )
            tracked = np.isfinite(displacement)
            up_steps = np.where(tracked & (relative[usable] > 0), relative[usable], 0.0).max(axis=1)
            down_steps = np.where(tracked & (relative[usable] < 0), -relative[usable], 0.0).max(axis=1)
            track_planes = up_steps + down_steps + 1.0
        else:
            tan_chord = np.full(count, np.nan)
            censored = np.ones(count, dtype=bool)
            chord_planes = np.full(count, np.nan)

        results[plane.z_index] = PlaneAnalysis(
            z_index=plane.z_index,
            shape=tuple(geometry.shape),
            sample_piece=piece,
            sample_artifact=artifact,
            sample_tan_chord=tan_chord,
            sample_tan_drift=slope[piece] if count else np.empty(0),
            sample_tan_error=error[piece] if count else np.empty(0),
            sample_chord_censored=censored,
            sample_chord_planes=chord_planes,
            sample_window_planes=reach[piece] if count else np.empty(0),
            piece_samples=np.bincount(piece, minlength=piece_count) if count else np.empty(0, dtype=np.int64),
            piece_center_x=_aggregate(piece, piece_count, x.astype(np.float64), clean),
            piece_center_y=_aggregate(piece, piece_count, y.astype(np.float64), clean),
            piece_width_px=piece_width,
            piece_tan_chord=_aggregate(piece, piece_count, tan_chord, clean),
            piece_tan_drift=slope,
            piece_tan_error=error,
            piece_track_planes=track_planes,
            piece_censored=_aggregate(piece, piece_count, censored.astype(np.float64), clean),
            piece_chord_planes=_aggregate(piece, piece_count, chord_planes, clean),
            piece_artifact=_aggregate(piece, piece_count, (~clean).astype(np.float64), np.ones(count, dtype=bool)),
            piece_component_aspect=_aggregate(piece, piece_count, _component_aspect(geometry, median_width), clean),
            piece_cc_samples=_aggregate(piece, piece_count, cc_samples[cc_ids[index]].astype(np.float64), clean),
            piece_cc_span=_aggregate(piece, piece_count, cc_span[cc_ids[index]].astype(np.float64), clean),
            piece_edges=edges,
            neighbour_planes=int(usable.size),
            median_width_px=median_width,
        )
        # Where each piece is and which way it drifts, in the stack's shared frame.
        normal_x, normal_y = _piece_normals(shared_x, shared_y, piece, piece_count) if count else (np.empty(0), np.empty(0))
        positions_of.append({
            "analysis": results[plane.z_index],
            "center": float(plane.center),
            "x": _aggregate(piece, piece_count, shared_x, clean),
            "y": _aggregate(piece, piece_count, shared_y, clean),
            "drift_x": signed * normal_x,
            "drift_y": signed * normal_y,
        })
        if progress:
            progress(0.4 + 0.55 * (index + 1) / len(planes), "Measuring GBM orientation")
    _link_through_z(positions_of, median_width, progress)
    return results


def z_coupling_reach(centers: Sequence[float]) -> float:
    """How far apart, in planes, two analysed planes may be for their pieces to be linked."""
    ordered = np.unique(np.asarray(centers, dtype=np.float64))
    if ordered.size < 2:
        return 0.0
    spacing = float(np.median(np.diff(ordered)))
    if spacing > Z_COUPLING_MAX_SPACING:
        return 0.0
    return max(Z_COUPLING_MIN_PLANES, Z_COUPLING_SPACINGS * spacing) + 1e-6


def match_pieces(
    x: np.ndarray, y: np.ndarray, drift_x: np.ndarray, drift_y: np.ndarray, planes: float,
    other_x: np.ndarray, other_y: np.ndarray, reference_px: float,
) -> np.ndarray:
    """For each piece, the piece of another plane on the same stretch of sheet, or -1.

    Positions are in the stack's shared frame. A piece is looked for where its own drift
    puts it ``planes`` away, within a gate that is tighter across the sheet than along it.
    """
    count = x.size
    matched = np.full(count, -1, dtype=np.int32)
    if count == 0 or other_x.size == 0:
        return matched
    drift_x, drift_y = np.nan_to_num(drift_x), np.nan_to_num(drift_y)
    size = np.hypot(drift_x, drift_y)
    # Across the sheet is along its drift; a piece that does not drift has no such direction.
    known = size > 1e-6
    normal_x = np.where(known, drift_x / np.maximum(size, 1e-6), 0.0)
    normal_y = np.where(known, drift_y / np.maximum(size, 1e-6), 0.0)
    across_gate = Z_MATCH_ACROSS * max(float(reference_px), 1.0)
    along_gate = Z_MATCH_ALONG * max(float(reference_px), 1.0)
    usable = np.isfinite(other_x) & np.isfinite(other_y)
    for start in range(0, count, 512):
        rows = slice(start, min(start + 512, count))
        dx = other_x[None, :] - (x[rows] + drift_x[rows] * planes)[:, None]
        dy = other_y[None, :] - (y[rows] + drift_y[rows] * planes)[:, None]
        across = dx * normal_x[rows, None] + dy * normal_y[rows, None]
        along_squared = np.maximum(dx * dx + dy * dy - across * across, 0.0)
        gate = np.where(
            known[rows, None],
            (across / across_gate) ** 2 + along_squared / along_gate ** 2,
            (dx * dx + dy * dy) / across_gate ** 2,
        )
        gate = np.where(usable[None, :] & np.isfinite(gate), gate, np.inf)
        best = np.argmin(gate, axis=1)
        found = gate[np.arange(best.size), best] <= 1.0
        matched[rows] = np.where(found, best, -1)
    return matched


def _link_through_z(positions_of: Sequence[dict[str, Any]], reference_px: float, progress=None) -> None:
    """Record, for every piece, the same stretch of sheet in the analysed planes around it."""
    reach = z_coupling_reach([entry["center"] for entry in positions_of])
    for index, entry in enumerate(positions_of):
        analysis: PlaneAnalysis = entry["analysis"]
        count = analysis.piece_samples.size
        linked_z, columns = [], []
        for other_index, other in enumerate(positions_of):
            distance = other["center"] - entry["center"]
            if other_index == index or reach <= 0.0 or abs(distance) > reach or abs(distance) < 1e-9:
                continue
            linked_z.append(other["analysis"].z_index)
            columns.append(match_pieces(
                entry["x"], entry["y"], entry["drift_x"], entry["drift_y"], distance, other["x"], other["y"], reference_px,
            ))
        analysis.link_z = np.asarray(linked_z, dtype=np.int32)
        analysis.piece_links = (
            np.column_stack(columns).astype(np.int32) if columns else np.full((count, 0), -1, dtype=np.int32)
        )
        if progress:
            progress(0.95 + 0.05 * (index + 1) / len(positions_of), "Linking planes through Z")


# ---- Decisions (used by the web API at query time) ---------------------------

REASON_KEPT = 0
REASON_OBLIQUE = 1
REASON_EN_FACE = 2
REASON_TRANSIENT = 3
REASON_SPECK = 4
REASON_COMPACT = 5
REASON_ARTIFACT = 6
REASON_WIDE_PATCH = 7
REASON_TOO_THIN = 8
REASON_TOO_THICK = 9
REASON_MANUAL = 10
REASON_NAMES = {
    REASON_KEPT: "kept",
    REASON_OBLIQUE: "oblique",
    REASON_EN_FACE: "en-face",
    REASON_TRANSIENT: "transient",
    REASON_SPECK: "speck",
    REASON_COMPACT: "compact",
    REASON_ARTIFACT: "artifact",
    REASON_WIDE_PATCH: "wide-patch",
    REASON_TOO_THIN: "too-thin",
    REASON_TOO_THICK: "too-thick",
    REASON_MANUAL: "manual",
}
CROSS_SECTION_REASONS = (
    REASON_OBLIQUE, REASON_EN_FACE, REASON_TRANSIENT, REASON_SPECK, REASON_COMPACT, REASON_ARTIFACT, REASON_WIDE_PATCH,
)

AUTO_TILT_INFLATION = 1.35
AUTO_TILT_RANGE_DEG = (20.0, 40.0)
# With no Z step on record: a sheet smeared sideways by this multiple of its own
# thickness cannot be measured as a cross-section at all.
EN_FACE_SMEAR = 1.0
# Also then, only to turn planes into a rough lateral distance for area and for
# choosing which pieces to take the reference thickness from.
ASSUMED_AXIAL_PX_PER_PLANE = 4.0
SPECK_AREA_THICKNESSES = 4.0
# A piece's score is positive when evidence says to exclude it. A piece this many
# degrees past the limit, with a certain slope, scores 1.
TILT_SCORE_DEGREES = 8.0
# The same with no Z step, in fractions of the thickness smeared sideways.
SMEAR_SCORE_FRACTION = 0.15
TILT_SCORE_RANGE = (-2.0, 3.0)
# Width above this multiple of the best-oriented GBM counts towards tilt.
WIDTH_CONFIRMS_TILT = 1.2
WIDTH_SCORE_SPAN = 0.3
WIDTH_SCORE_RANGE = (-0.5, 1.5)
# A connected part this long, in thicknesses, is neutral; longer is more line-like.
LINE_NEUTRAL_ASPECT = 6.0
LINE_SCORE_WEIGHT = 0.25
NOT_SHEET_SCORE = 1.0
WIDE_PATCH_SCORE = 1.5
# A piece's evidence is its length in thicknesses times its score, within this limit.
RUN_SCORE_LIMIT = 2.0
# What it costs, against that evidence, for the decision to change between two pieces that
# join along the centerline, and for a piece to differ from the same stretch of sheet in a
# nearby plane. The second is per thickness of centerline the two share, as evidence is:
# charged per piece, it outweighed the evidence of the short pieces that fragmented masks
# are cut into, and nothing was excluded there. Both were set on real masks with a known
# tilt added, so that decisions break no more often along the centerline than a plane judged
# on its own while being wrong less often.
BREAK_COST = 1.75
Z_LINK_COST = 0.3
# Without SciPy each plane is decided on its own, by flipping runs of pieces. There a break
# costs this per break: more for a gap in kept GBM than for a kept stretch on its own, since
# kept GBM that is removed cannot be measured.
GAP_BREAK_COST = 1.5
ISLAND_BREAK_COST = 1.0
# The slope's uncertainty widens the tilt score's scale by this share of itself. On real
# masks the tracker reads steep tilt accurately while reporting it as less certain, so in
# full it let clearly tilted pieces be overruled.
TILT_UNCERTAINTY_WEIGHT = 0.5
# Width only confirms tilt that is near or past the limit: its weight falls to nothing over
# this much tilt score below the limit. A sheet measured well short of the limit is wide
# because it is thick, and excluding it would trim the thick end of what is being measured.
WIDTH_GATE_SCORE = 1.0
# Pieces are linked through Z with the analysed planes around them, as far as this many
# planes away, or this many times the spacing of analysed planes if that is further.
Z_COUPLING_MIN_PLANES = 3.0
Z_COUPLING_SPACINGS = 1.5
# Planes analysed further apart than this show different parts of a curving sheet.
Z_COUPLING_MAX_SPACING = 6.0
# How far, in typical thicknesses, the same stretch may sit from where its drift puts it:
# across the sheet, and along it (pieces are about two thicknesses long).
Z_MATCH_ACROSS = 0.6
Z_MATCH_ALONG = 1.2
# Costs are rounded to this many units each for the minimum cut.
CUT_UNITS = 200
COMPACT_ASPECT = 1.5
# Sheets persist through Z; only something this brief can be called not a sheet.
BRIEF_MARGIN_PLANES = 2.0
# Far wider than the best-oriented GBM, with no sign of being vertical.
WIDE_PATCH_FACTOR = 2.5


def apparent_inflation(tilt_deg: float, z_step_um: float, thickness_um: float, mip_planes: int) -> float:
    """How much wider a sheet of this tilt looks than it is, in the Z projection."""
    theta = math.radians(tilt_deg)
    sweep = max(0, int(mip_planes) - 1) * float(z_step_um) / max(float(thickness_um), 1e-6)
    return 1.0 / math.cos(theta) + sweep * math.tan(theta)


def auto_max_tilt_deg(z_step_um: float, thickness_um: float, mip_planes: int = MIP_PLANES) -> float:
    """Largest tilt whose apparent thickening stays within the tolerated inflation.

    A coarser Z step smears a tilted sheet further across the projection, so it
    earns a stricter limit. Bounded because tilt cannot be resolved much below
    15°, and allowing more than 35° would keep visibly inflated sections.
    """
    low, high = AUTO_TILT_RANGE_DEG
    if apparent_inflation(low, z_step_um, thickness_um, mip_planes) >= AUTO_TILT_INFLATION:
        return low
    if apparent_inflation(high, z_step_um, thickness_um, mip_planes) <= AUTO_TILT_INFLATION:
        return high
    for _ in range(30):
        middle = 0.5 * (low + high)
        if apparent_inflation(middle, z_step_um, thickness_um, mip_planes) > AUTO_TILT_INFLATION:
            high = middle
        else:
            low = middle
    return round(0.5 * (low + high), 1)


def piece_tilt_deg(analysis: PlaneAnalysis, pixel_size_um: float, z_step_um: float) -> np.ndarray:
    """Measured tilt of each piece from vertical, in degrees; NaN where unmeasured."""
    return np.degrees(np.arctan(np.asarray(analysis.piece_tan_drift, dtype=np.float64) * float(pixel_size_um) / float(z_step_um)))


def decide_along_centerline(
    excluded: np.ndarray,
    score: np.ndarray,
    length: np.ndarray,
    edges: np.ndarray,
    *,
    gap_cost: float = GAP_BREAK_COST,
    island_cost: float = ISLAND_BREAK_COST,
) -> np.ndarray:
    """Decisions for one plane on its own, given that GBM runs on along its centerline.

    Used where SciPy is missing; otherwise ``decide_jointly`` decides the whole stack.
    A run of equally judged pieces keeps its decision only if the evidence for it
    (length in thicknesses times score) outweighs the breaks it makes. Weakest runs
    flip first, which can merge neighbours into a run that then holds. A run with no
    neighbours has nothing to be continuous with, so its evidence stands alone.
    """
    decided = np.asarray(excluded, dtype=bool).copy()
    count = decided.size
    pairs = np.asarray(edges, dtype=np.int64).reshape(-1, 2)
    if count == 0 or pairs.size == 0:
        return decided
    neighbours: list[list[int]] = [[] for _ in range(count)]
    for first, second in pairs:
        if first != second:
            neighbours[first].append(int(second))
            neighbours[second].append(int(first))
    worth = np.asarray(length, dtype=np.float64) * np.clip(np.nan_to_num(score), -RUN_SCORE_LIMIT, RUN_SCORE_LIMIT)
    for _ in range(12):
        run_of = np.full(count, -1, dtype=np.int64)
        members: list[list[int]] = []
        for start in range(count):
            if run_of[start] >= 0 or not neighbours[start]:
                continue
            label = len(members)
            run_of[start] = label
            stack = [start]
            run = [start]
            while stack:
                for other in neighbours[stack.pop()]:
                    if run_of[other] < 0 and decided[other] == decided[start]:
                        run_of[other] = label
                        stack.append(other)
                        run.append(other)
            members.append(run)
        candidates = []
        for label, run in enumerate(members):
            breaks = sum(1 for piece in run for other in neighbours[piece] if run_of[other] != label)
            if breaks == 0:
                continue
            evidence = float(worth[run].sum()) * (1.0 if decided[run[0]] else -1.0)
            margin = evidence - breaks * (gap_cost if decided[run[0]] else island_cost)
            if margin < 0.0:
                candidates.append((margin, label))
        if not candidates:
            break
        candidates.sort()
        flipped: set[int] = set()
        for _, label in candidates:
            run = members[label]
            # A neighbouring run that flipped this pass changes what this one borders.
            if any(run_of[other] in flipped for piece in run for other in neighbours[piece] if run_of[other] != label):
                continue
            decided[run] = ~decided[run]
            flipped.add(label)
    return decided


def reference_width_px(analysis: PlaneAnalysis, tilt_deg: np.ndarray | None = None) -> float:
    """Thickness of the best-oriented pieces, as the sheet's apparent true thickness."""
    width = np.asarray(analysis.piece_width_px, dtype=np.float64)
    weights = np.asarray(analysis.piece_samples, dtype=np.float64)
    valid = np.isfinite(width) & (weights > 0) & (np.asarray(analysis.piece_artifact) < 0.5)
    if tilt_deg is not None:
        steep = valid & np.isfinite(tilt_deg) & (tilt_deg <= 15.0)
        if weights[steep].sum() >= 50:
            valid = steep
    if not valid.any():
        return float(analysis.median_width_px)
    order = np.argsort(width[valid])
    cumulative = np.cumsum(weights[valid][order])
    return float(width[valid][order][np.searchsorted(cumulative, 0.5 * cumulative[-1])])


@dataclass
class FilterSettings:
    cross_section: bool = True
    max_tilt_deg: float | None = None  # None: automatic
    thickness_limits: bool = True
    min_nm: float = DEFAULT_MIN_THICKNESS_NM
    max_nm: float = DEFAULT_MAX_THICKNESS_NM
    mip_planes: int = MIP_PLANES
    plane_step: float = 1.0


def piece_evidence(
    analysis: PlaneAnalysis,
    settings: FilterSettings,
    *,
    pixel_size_um: float,
    z_step_um: float | None,
    tilt_limit_field: np.ndarray | None = None,
) -> dict[str, Any]:
    """Score every piece of one plane, positive when its own evidence says to exclude it.

    ``tilt_limit_field`` replaces the tilt limit per piece (local corrections). ``score``
    is ``None`` when the cross-section filter is off or the plane has no pieces.
    """
    count = analysis.piece_samples.size
    width = np.asarray(analysis.piece_width_px, dtype=np.float64)
    has_neighbours = analysis.neighbour_planes > 0
    has_tilt = bool(z_step_um) and has_neighbours
    slope = np.asarray(analysis.piece_tan_drift, dtype=np.float64)
    if has_tilt:
        tilt = piece_tilt_deg(analysis, pixel_size_um, z_step_um)
        reference_px = reference_width_px(analysis, tilt)
    else:
        tilt = np.full(count, np.nan)
        reference_px = (
            reference_width_px(analysis, np.degrees(np.arctan(slope / ASSUMED_AXIAL_PX_PER_PLANE)))
            if has_neighbours and count else reference_width_px(analysis)
        )
    reference_um = reference_px * float(pixel_size_um)
    if not has_tilt:
        limit = None
    elif settings.max_tilt_deg is not None:
        limit = float(settings.max_tilt_deg)
    else:
        limit = auto_max_tilt_deg(float(z_step_um), reference_um, settings.mip_planes)
    field_ = np.full(count, np.nan if limit is None else limit) if tilt_limit_field is None else np.asarray(tilt_limit_field, dtype=np.float64)
    evidence: dict[str, Any] = {"tilt_deg": tilt, "limit_deg": limit, "reference_px": reference_px, "width": width, "score": None}
    if not (settings.cross_section and count):
        return evidence

    # Tapers, spurs and junctions are not measured, sample by sample, but they are
    # still part of the GBM. Having no opinion, they take after what they join.
    artifact = np.asarray(analysis.piece_artifact) >= 0.5
    length = np.asarray(analysis.piece_samples, dtype=np.float64) / max(reference_px, 1.0)
    aspect = np.maximum(np.nan_to_num(np.asarray(analysis.piece_component_aspect, dtype=np.float64), nan=LINE_NEUTRAL_ASPECT), 0.5)
    ratio = np.nan_to_num(width / max(reference_px, 1.0), nan=1.0)
    if has_neighbours:
        chord = np.asarray(analysis.piece_chord_planes, dtype=np.float64)
        tracked = np.asarray(analysis.piece_track_planes, dtype=np.float64)
        open_ended = np.asarray(analysis.piece_censored) >= 0.5
        uncertainty = TILT_UNCERTAINTY_WEIGHT * np.nan_to_num(np.asarray(analysis.piece_tan_error, dtype=np.float64))
        with np.errstate(invalid="ignore"):
            if has_tilt:
                scale = float(pixel_size_um) / float(z_step_um)
                angle = np.degrees(np.arctan(slope * scale))
                spread = np.degrees(np.arctan((slope + uncertainty) * scale)) - angle
                tilt_score = (angle - field_) / (TILT_SCORE_DEGREES + spread)
                en_face = angle > np.maximum(field_, EN_FACE_TILT_DEG)
                axial_scale = float(z_step_um) / float(pixel_size_um)
            else:
                # Without a Z step the angle is unknown, but what it does to the
                # measurement is not: the projection smears a sheet sideways by
                # its drift per plane, in pixels, whatever the Z step is.
                sweep = max(0, settings.mip_planes - 1) / max(reference_px, 1.0)
                smear = sweep * slope
                tilt_score = (smear - (AUTO_TILT_INFLATION - 1.0)) / (SMEAR_SCORE_FRACTION + sweep * uncertainty)
                en_face = smear > EN_FACE_SMEAR
                axial_scale = ASSUMED_AXIAL_PX_PER_PLANE
            # A structure no longer than the Z projection itself, neither under
            # its medial point nor followed sideways, is not a sheet. Sparse
            # sampling cannot show that, so it is only judged on close planes.
            brief_limit = settings.mip_planes + BRIEF_MARGIN_PLANES
            judged = float(settings.plane_step) <= 0.5 * brief_limit
            transient = judged & (chord <= brief_limit) & (tracked <= brief_limit) & ~open_ended
            # Lying flat, a sheet is far too wide and cannot be followed as a line.
            unsure = ~np.isfinite(slope) | (np.nan_to_num(tilt_score) > 0.0)
            patch = (ratio > WIDE_PATCH_FACTOR) & unsure
            unmeasured = ~np.isfinite(slope)
            # Blobs and specks only when nothing says they run through the stack.
            persistent = (tracked > 2.0 * brief_limit) | (chord > 2.0 * brief_limit)
        area = np.asarray(analysis.piece_cc_samples, dtype=np.float64) * axial_scale * float(settings.plane_step)
        speck = (area < SPECK_AREA_THICKNESSES * max(reference_px, 1.0) ** 2) & ~persistent
        compact = (aspect < COMPACT_ASPECT) & ~persistent
        # Width counts towards tilt only as far as the measured tilt is near or past the
        # limit. An unmeasured slope has no tilt score, so there width counts in full.
        width_score = np.clip((ratio - WIDTH_CONFIRMS_TILT) / WIDTH_SCORE_SPAN, *WIDTH_SCORE_RANGE)
        gate = np.clip(1.0 + np.nan_to_num(tilt_score) / WIDTH_GATE_SCORE, 0.0, 1.0)
        width_score = np.where(width_score > 0.0, width_score * gate, width_score)
        score = (
            np.clip(np.nan_to_num(tilt_score), *TILT_SCORE_RANGE)
            + width_score
            - LINE_SCORE_WEIGHT * np.clip(np.log2(aspect / LINE_NEUTRAL_ASPECT), -1.0, 1.0)
        )
        not_sheet = speck | transient | compact
        score = np.where(not_sheet, np.maximum(score, NOT_SHEET_SCORE), score)
        score = np.where(patch, np.maximum(score, WIDE_PATCH_SCORE), score)
        # Anything excluded for continuity alone is a stretch of oblique GBM.
        evidence.update(default_reason=REASON_OBLIQUE, labels=(
            (compact & ~patch, REASON_COMPACT), (patch & unmeasured, REASON_WIDE_PATCH), (en_face, REASON_EN_FACE),
            (transient, REASON_TRANSIENT), (speck, REASON_SPECK),
        ))
    else:
        # One plane only: shape is all there is. Wide, short patches are
        # what en-face sheet looks like; compact islands are not sheets.
        wide = ratio > WIDE_PATCH_FACTOR
        compact = aspect < COMPACT_ASPECT
        score = np.where(wide | compact, 1.0, -0.5)
        evidence.update(default_reason=REASON_COMPACT, labels=((wide, REASON_WIDE_PATCH),))
    evidence.update(score=np.where(artifact, 0.0, score), artifact=artifact, length=length)
    return evidence


def _minimum_cut(
    keep_cost: np.ndarray, exclude_cost: np.ndarray, first: np.ndarray, second: np.ndarray, weight: np.ndarray,
) -> np.ndarray | None:
    """Which nodes to exclude so that the total cost is least; ``None`` without SciPy.

    The cost is ``keep_cost`` of every kept node, ``exclude_cost`` of every excluded one,
    and ``weight`` for every joined pair that ends up on different sides.
    """
    try:
        from scipy.sparse import coo_matrix
        from scipy.sparse.csgraph import breadth_first_order, maximum_flow
    except ImportError:
        return None
    count = int(keep_cost.size)
    source, sink = count, count + 1
    nodes = np.arange(count)
    keep = np.round(np.asarray(keep_cost) * CUT_UNITS).astype(np.int64)
    # One unit towards keeping, so a piece with no evidence either way stays kept.
    exclude = np.round(np.asarray(exclude_cost) * CUT_UNITS).astype(np.int64) + 1
    joined = np.round(np.asarray(weight) * CUT_UNITS).astype(np.int64)
    # Kept nodes stay on the source's side. Excluding a node cuts its arc from the source,
    # keeping it cuts its arc to the sink, and a joined pair that differs cuts their arc.
    rows = np.concatenate([np.full(count, source), nodes, first, second])
    columns = np.concatenate([nodes, np.full(count, sink), second, first])
    capacity = np.concatenate([exclude, keep, joined, joined])
    graph = coo_matrix((capacity, (rows, columns)), shape=(count + 2, count + 2)).tocsr().astype(np.int32)
    flow = maximum_flow(graph, source, sink).flow
    residual = (graph - flow).tocsr()
    residual.data = (residual.data > 0).astype(np.int8)
    residual.eliminate_zeros()
    reached = breadth_first_order(residual, source, directed=True, return_predecessors=False)
    kept = np.zeros(count + 2, dtype=bool)
    kept[reached] = True
    return ~kept[:count]


def decide_jointly(analyses: Sequence[PlaneAnalysis], evidence: Sequence[dict[str, Any]]) -> list[np.ndarray | None]:
    """Which pieces to exclude, for several planes of one stack at once.

    GBM runs on along its centerline and through Z, so a decision is not made piece by
    piece. The decisions returned go against the least evidence (each piece's length in
    thicknesses times its score), counting ``BREAK_COST`` wherever they change between
    pieces that join along a centerline and ``Z_LINK_COST`` per thickness of centerline
    wherever a piece differs from the same stretch of sheet in a linked plane. That
    minimum is exact (a minimum cut).
    Planes are linked only to others passed in with them. ``None`` is returned for a
    plane with no cross-section evidence.
    """
    scored = [index for index, entry in enumerate(evidence) if entry.get("score") is not None]
    output: list[np.ndarray | None] = [None] * len(analyses)
    if not scored:
        return output
    sizes = {index: int(evidence[index]["score"].size) for index in scored}
    offsets, total = {}, 0
    for index in scored:
        offsets[index] = total
        total += sizes[index]
    worth = np.concatenate([
        evidence[index]["length"] * np.clip(np.nan_to_num(evidence[index]["score"]), -RUN_SCORE_LIMIT, RUN_SCORE_LIMIT)
        for index in scored
    ])
    position_of = {int(analyses[index].z_index): index for index in scored}
    first, second, weight = [], [], []
    for index in scored:
        analysis = analyses[index]
        pairs = np.asarray(analysis.piece_edges, dtype=np.int64).reshape(-1, 2)
        pairs = pairs[pairs[:, 0] != pairs[:, 1]]
        first.append(pairs[:, 0] + offsets[index])
        second.append(pairs[:, 1] + offsets[index])
        weight.append(np.full(pairs.shape[0], BREAK_COST))
        links = np.asarray(analysis.piece_links, dtype=np.int64)
        for column, z_index in enumerate(np.asarray(analysis.link_z).reshape(-1)):
            other = position_of.get(int(z_index))
            if other is None or other == index or links.shape[0] != sizes[index]:
                continue
            match = links[:, column]
            found = np.nonzero((match >= 0) & (match < sizes[other]))[0]
            first.append(found + offsets[index])
            second.append(match[found] + offsets[other])
            weight.append(Z_LINK_COST * np.minimum(evidence[index]["length"][found], evidence[other]["length"][match[found]]))
    excluded = _minimum_cut(
        np.maximum(worth, 0.0), np.maximum(-worth, 0.0),
        np.concatenate(first), np.concatenate(second), np.concatenate(weight),
    )
    for index in scored:
        if excluded is None:
            entry = evidence[index]
            output[index] = decide_along_centerline(
                (entry["score"] > 0.0) & ~entry["artifact"], entry["score"], entry["length"], analyses[index].piece_edges,
            )
        else:
            output[index] = excluded[offsets[index]:offsets[index] + sizes[index]]
    return output


def decide_from_evidence(
    analysis: PlaneAnalysis,
    evidence: dict[str, Any],
    settings: FilterSettings,
    *,
    pixel_size_um: float,
    expansion_factor: float = 1.0,
    trusted_reasons: np.ndarray | None = None,
    excluded: np.ndarray | None = None,
) -> dict[str, Any]:
    """Reason codes for one plane from its evidence.

    ``excluded`` is what ``decide_jointly`` decided for this plane together with the
    planes around it. Without it the plane is decided on its own.
    """
    count = analysis.piece_samples.size
    reasons = np.zeros(count, dtype=np.int32)
    if evidence["score"] is not None:
        if excluded is None:
            excluded = decide_jointly([analysis], [evidence])[0]
        final = np.asarray(excluded, dtype=bool)
        reasons[final] = evidence["default_reason"]
        for mask, code in evidence["labels"]:
            reasons[mask & final] = code
        if trusted_reasons is not None:
            trusted = (np.asarray(trusted_reasons) == reasons) & (reasons != REASON_KEPT)
            reasons[trusted] = REASON_KEPT
    if settings.thickness_limits and count:
        thickness_nm = evidence["width"] * float(pixel_size_um) / float(expansion_factor) * 1000.0
        with np.errstate(invalid="ignore"):
            reasons[(thickness_nm < settings.min_nm) & (reasons == 0)] = REASON_TOO_THIN
            reasons[(thickness_nm > settings.max_nm) & (reasons == 0)] = REASON_TOO_THICK
    return {"reasons": reasons, "tilt_deg": evidence["tilt_deg"], "limit_deg": evidence["limit_deg"], "reference_px": evidence["reference_px"]}


def classify_pieces(
    analysis: PlaneAnalysis,
    settings: FilterSettings,
    *,
    pixel_size_um: float,
    z_step_um: float | None,
    expansion_factor: float = 1.0,
    tilt_limit_field: np.ndarray | None = None,
    trusted_reasons: np.ndarray | None = None,
    excluded: np.ndarray | None = None,
) -> dict[str, Any]:
    """Assign every piece of one plane a reason code; ``REASON_KEPT`` pieces count in measurements.

    ``tilt_limit_field`` replaces the tilt limit per piece (local corrections).
    ``trusted_reasons`` holds, per piece, a reason code a nearby correction has
    vouched for (or -1), so it no longer excludes that piece. ``excluded`` is this
    plane's part of a decision made for the whole stack (``classify_stack``); without
    it the plane is decided on its own, which leaves out continuity through Z.
    """
    evidence = piece_evidence(analysis, settings, pixel_size_um=pixel_size_um, z_step_um=z_step_um, tilt_limit_field=tilt_limit_field)
    return decide_from_evidence(
        analysis, evidence, settings, pixel_size_um=pixel_size_um, expansion_factor=expansion_factor,
        trusted_reasons=trusted_reasons, excluded=excluded,
    )


def classify_stack(
    analyses: Sequence[PlaneAnalysis],
    settings: FilterSettings,
    *,
    pixel_size_um: float,
    z_step_um: float | None,
    expansion_factor: float = 1.0,
) -> dict[int, dict[str, Any]]:
    """Reason codes for every plane of a stack, decided together. Keyed by ``z_index``."""
    evidence = [piece_evidence(analysis, settings, pixel_size_um=pixel_size_um, z_step_um=z_step_um) for analysis in analyses]
    decided = decide_jointly(analyses, evidence)
    return {
        int(analysis.z_index): decide_from_evidence(
            analysis, entry, settings, pixel_size_um=pixel_size_um, expansion_factor=expansion_factor, excluded=excluded,
        )
        for analysis, entry, excluded in zip(analyses, evidence, decided)
    }


__all__ = [name for name in globals() if name.isupper()] + [
    "PlaneAnalysis",
    "FieldMotion",
    "StackPlane",
    "analyze_stack",
    "build_pieces",
    "classify_pieces",
    "classify_stack",
    "decide_along_centerline",
    "decide_from_evidence",
    "decide_jointly",
    "match_pieces",
    "piece_evidence",
    "z_coupling_reach",
    "estimate_field_motion",
    "signed_distance",
    "to_plane",
    "to_shared",
]
