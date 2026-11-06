"""Decide which predicted GBM is a true cross-section, using the whole Z stack.

The GBM is a thin sheet folded in 3D. A plane only shows its true thickness
where the sheet crosses the plane perpendicularly. Tilted by an angle ``θ`` from
vertical, a sheet of thickness ``t`` looks wider (``t / cos θ``), and the
5-plane Z projection used for inference widens it further by the distance the
sheet drifts across the projection (``4 dz tan θ``). Lying flat, it becomes a
wide en-face patch. Thickness statistics are biased by all of these.

Two independent measurements of ``θ`` come from the masks of neighbouring
planes. Both work per centerline sample and are calibration independent: they
are stored in pixels per plane, so changing the pixel size or Z step later
needs no recomputation (``tan θ = stored * pixel_size / z_step``).

Axial chord
    Follow the medial point along Z until it leaves the mask. A slab has
    lateral chord ``w`` and axial chord ``a`` with ``tan θ = w / a`` exactly,
    whatever the slab thickness, and Z projection or axial blur (which dilate
    the slab along Z) cancel out of the ratio. This also measures how long a
    structure persists through the stack.

Level-set drift
    With a signed distance function ``φ_z`` of each mask (``|∇φ| = 1``), the
    normal speed of a boundary through the stack is ``∂φ/∂z``, and the tilt of
    that boundary from vertical is ``atan |∂φ/∂z|``. Each boundary face is
    followed outwards through the planes only until it has moved by a fraction
    of the local thickness, because beyond that the distance field no longer
    reports the same surface. Steep surfaces therefore use nearby planes and
    near-vertical ones use a long lever arm: every sample measures its own
    usable Z window, up to the configured maximum.

Decisions are made on *pieces*: short lengths of centerline about two
thicknesses long with their share of the mask, so a wall that turns oblique
part-way along is only excluded where it does. Pieces are also what a person
clicks on when correcting the result.

SciPy is imported lazily, so importing this module stays cheap for the web API.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Sequence
import math

import numpy as np

from .gbm_thickness import ThicknessGeometry

ALGORITHM_VERSION = "gbm-cross-section-v1"
MIP_PLANES = 5
DEFAULT_MAX_WINDOW = 30
EN_FACE_TILT_DEG = 60.0
DEFAULT_MIN_THICKNESS_NM = 30.0
DEFAULT_MAX_THICKNESS_NM = 3400.0

# A boundary is followed until it has moved by this fraction of the thickness.
DRIFT_PASSAGE_FRACTION = 0.4
# The medial point counts as inside a neighbouring mask up to this fraction of
# the thickness away, and may miss this many planes, so jitter and small holes
# in a prediction do not end its axial chord.
CHORD_TOLERANCE_FRACTION = 0.15
CHORD_MAX_MISSES = 1

SAMPLE_OK = 0
SAMPLE_TAPER = 1
SAMPLE_SPUR = 2
SAMPLE_JUNCTION = 3


@dataclass
class StackPlane:
    """One saved prediction: its plane, Z projection centre, mask and geometry."""

    z_index: int
    center: float
    mask: np.ndarray
    geometry: ThicknessGeometry


@dataclass
class PlaneAnalysis:
    """Calibration-independent evidence for one plane."""

    z_index: int
    shape: tuple[int, int]
    sample_piece: np.ndarray
    sample_artifact: np.ndarray
    sample_tan_chord: np.ndarray
    sample_tan_drift: np.ndarray
    sample_chord_censored: np.ndarray
    sample_chord_planes: np.ndarray
    sample_window_planes: np.ndarray
    piece_samples: np.ndarray
    piece_center_x: np.ndarray
    piece_center_y: np.ndarray
    piece_width_px: np.ndarray
    piece_tan_chord: np.ndarray
    piece_tan_drift: np.ndarray
    piece_censored: np.ndarray
    piece_chord_planes: np.ndarray
    piece_artifact: np.ndarray
    piece_component_aspect: np.ndarray
    piece_cc_samples: np.ndarray
    piece_cc_span: np.ndarray
    piece_edges: np.ndarray
    neighbour_planes: int
    median_width_px: float
    extra: dict = field(default_factory=dict)

    def to_arrays(self) -> dict[str, np.ndarray]:
        return {
            "algorithm_version": np.asarray([ALGORITHM_VERSION]),
            "z_index": np.asarray([self.z_index], dtype=np.int32),
            "shape": np.asarray(self.shape, dtype=np.int32),
            "sample_piece": self.sample_piece.astype(np.int32),
            "sample_artifact": self.sample_artifact.astype(np.uint8),
            "sample_tan_chord": self.sample_tan_chord.astype(np.float32),
            "sample_tan_drift": self.sample_tan_drift.astype(np.float32),
            "sample_chord_censored": self.sample_chord_censored.astype(bool),
            "sample_chord_planes": self.sample_chord_planes.astype(np.float32),
            "sample_window_planes": self.sample_window_planes.astype(np.float32),
            "piece_samples": self.piece_samples.astype(np.int32),
            "piece_center_x": self.piece_center_x.astype(np.float32),
            "piece_center_y": self.piece_center_y.astype(np.float32),
            "piece_width_px": self.piece_width_px.astype(np.float32),
            "piece_tan_chord": self.piece_tan_chord.astype(np.float32),
            "piece_tan_drift": self.piece_tan_drift.astype(np.float32),
            "piece_censored": self.piece_censored.astype(np.float32),
            "piece_chord_planes": self.piece_chord_planes.astype(np.float32),
            "piece_artifact": self.piece_artifact.astype(np.float32),
            "piece_component_aspect": self.piece_component_aspect.astype(np.float32),
            "piece_cc_samples": self.piece_cc_samples.astype(np.int64),
            "piece_cc_span": self.piece_cc_span.astype(np.float32),
            "piece_edges": self.piece_edges.astype(np.int32).reshape(-1, 2),
            "neighbour_planes": np.asarray([self.neighbour_planes], dtype=np.int32),
            "median_width_px": np.asarray([self.median_width_px], dtype=np.float32),
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
            sample_chord_censored=np.asarray(values["sample_chord_censored"]),
            sample_chord_planes=np.asarray(values["sample_chord_planes"]),
            sample_window_planes=np.asarray(values["sample_window_planes"]),
            piece_samples=np.asarray(values["piece_samples"]),
            piece_center_x=np.asarray(values["piece_center_x"]),
            piece_center_y=np.asarray(values["piece_center_y"]),
            piece_width_px=np.asarray(values["piece_width_px"]),
            piece_tan_chord=np.asarray(values["piece_tan_chord"]),
            piece_tan_drift=np.asarray(values["piece_tan_drift"]),
            piece_censored=np.asarray(values["piece_censored"]),
            piece_chord_planes=np.asarray(values["piece_chord_planes"]),
            piece_artifact=np.asarray(values["piece_artifact"]),
            piece_component_aspect=np.asarray(values["piece_component_aspect"]),
            piece_cc_samples=np.asarray(values["piece_cc_samples"]),
            piece_cc_span=np.asarray(values["piece_cc_span"]),
            piece_edges=np.asarray(values["piece_edges"]).reshape(-1, 2),
            neighbour_planes=int(np.asarray(values["neighbour_planes"]).reshape(-1)[0]),
            median_width_px=float(np.asarray(values["median_width_px"]).reshape(-1)[0]),
        )


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
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Length of the mask along Z through each medial point, per direction."""
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
            inside = _probe(distance_fields[index], y, x, factor) <= tolerance
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


def _chord_tangent(
    width: np.ndarray,
    up: np.ndarray,
    down: np.ndarray,
    open_up: np.ndarray,
    open_down: np.ndarray,
    typical_width: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """``tan θ`` in pixels per plane from lateral and axial chords.

    The closer end of the chord is the local measure: a wall that continues far
    in one direction but ends just above this plane is curving away here. A
    chord that runs off the available planes in both directions is only an
    upper bound on the tilt, reported through ``censored``.
    """
    effective_width = width + 2.0 * CHORD_TOLERANCE_FRACTION * np.minimum(width, typical_width)
    closed = np.minimum(np.where(open_up, np.inf, up), np.where(open_down, np.inf, down))
    both_open = open_up & open_down
    planes = np.where(both_open, up + down + 1.0, 2.0 * closed + 1.0)
    return effective_width / np.maximum(planes, 1.0), both_open, up + down + 1.0


def _boundary_drift(
    y: np.ndarray,
    x: np.ndarray,
    vy: np.ndarray,
    vx: np.ndarray,
    width: np.ndarray,
    distance_fields: Sequence[np.ndarray],
    target: int,
    relative: np.ndarray,
    usable: np.ndarray,
    factor: int,
    typical_width: float,
) -> tuple[np.ndarray, np.ndarray]:
    """``|∂φ/∂z|`` of the two boundary faces, per sample, in pixels per plane."""
    count = y.size
    # A floor keeps boundary jitter from ending the walk on thin necks.
    passage = np.maximum(DRIFT_PASSAGE_FRACTION * width, max(0.25 * typical_width, 2.0 * factor))
    order = usable[np.argsort(np.abs(relative[usable]))]
    faces = []
    reach = np.zeros(count)
    for sign in (-1.0, 1.0):
        py, px = y + sign * vy, x + sign * vx
        base = _probe(distance_fields[target], py, px, factor)
        sum_xy = np.zeros(count)
        sum_xx = np.zeros(count)
        alive_up = np.ones(count, dtype=bool)
        alive_down = np.ones(count, dtype=bool)
        reached = np.zeros(count)
        for index in order:
            step = relative[index]
            moved = base - _probe(distance_fields[index], py, px, factor)
            alive = alive_up if step > 0 else alive_down
            sum_xy[alive] += step * moved[alive]
            sum_xx[alive] += step * step
            reached[alive] = np.maximum(reached[alive], abs(step))
            alive &= np.abs(moved) < passage
        slope = np.divide(sum_xy, sum_xx, out=np.full(count, np.nan), where=sum_xx > 0)
        faces.append(np.abs(slope))
        reach = np.maximum(reach, reached)
    return np.fmax(faces[0], faces[1]), reach


def fuse_tangent(tan_chord: Any, tan_drift: Any, censored: Any) -> np.ndarray:
    """One tilt tangent from both estimators (same units in, same units out).

    The chord over-reads when a prediction has holes and the drift under-reads
    when planes are sparse, so they are averaged. A chord running off the
    available planes is only an upper bound, so there the drift decides.
    """
    chord = np.asarray(tan_chord, dtype=np.float64)
    drift = np.asarray(tan_drift, dtype=np.float64)
    both = 0.5 * (chord + drift)
    fused = np.where(np.asarray(censored, dtype=bool), drift, both)
    fused = np.where(np.isfinite(drift), fused, chord)
    return np.where(np.isfinite(chord), fused, drift)


def smooth_over_pieces(values: np.ndarray, edges: np.ndarray) -> np.ndarray:
    """Median of each piece and its centerline neighbours, ignoring missing values.

    One noisy piece inside a consistent wall follows its neighbours; a real
    change of orientation spans several pieces and survives.
    """
    values = np.asarray(values, dtype=np.float64)
    count = values.size
    if count == 0 or len(edges) == 0:
        return values.copy()
    neighbours: list[list[int]] = [[] for _ in range(count)]
    for first, second in np.asarray(edges, dtype=np.int64):
        neighbours[first].append(int(second))
        neighbours[second].append(int(first))
    output = values.copy()
    for index in range(count):
        if not neighbours[index]:
            continue
        window = values[[index, *neighbours[index]]]
        window = window[np.isfinite(window)]
        if window.size:
            output[index] = float(np.median(window))
    return output


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


def _connected_3d(planes: Sequence[StackPlane]) -> tuple[list[np.ndarray], np.ndarray, np.ndarray]:
    """3D components of the stack, with their centerline sample count and Z span."""
    from scipy.ndimage import label as component_label

    factor = 4
    volume = np.stack([np.asarray(plane.mask, dtype=bool)[::factor, ::factor] for plane in planes])
    labels, count = component_label(volume, structure=np.ones((3, 3, 3), dtype=np.uint8))
    samples = np.zeros(count + 1, dtype=np.int64)
    low = np.full(count + 1, np.inf)
    high = np.full(count + 1, -np.inf)
    per_plane = []
    for index, plane in enumerate(planes):
        y = np.clip(plane.geometry.skeleton_y // factor, 0, volume.shape[1] - 1)
        x = np.clip(plane.geometry.skeleton_x // factor, 0, volume.shape[2] - 1)
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
    widths = [plane.geometry.local_thickness_pixels for plane in planes if plane.geometry.skeleton_y.size]
    median_width = float(np.median(np.concatenate(widths))) if widths else 0.0
    factor = working_factor(median_width) if median_width else 1
    fields = []
    for index, plane in enumerate(planes):
        fields.append(signed_distance(plane.mask, factor))
        if progress:
            progress(0.5 * (index + 1) / len(planes), "Reading neighbouring Z predictions")
    cc_ids, cc_samples, cc_span = _connected_3d(planes)

    results: dict[int, PlaneAnalysis] = {}
    for index, plane in enumerate(planes):
        geometry = plane.geometry
        y = geometry.skeleton_y.astype(np.int64)
        x = geometry.skeleton_x.astype(np.int64)
        count = y.size
        width = geometry.local_thickness_pixels.astype(np.float64)
        relative = centers - centers[index]
        usable = np.nonzero((np.abs(relative) <= max_window) & (np.abs(relative) > 1e-6))[0]
        piece, artifact, edges = build_pieces(geometry)
        piece_count = int(piece.max()) + 1 if count else 0
        if usable.size and count:
            vy = geometry.nearest_background_dy_pixels.astype(np.float64)
            vx = geometry.nearest_background_dx_pixels.astype(np.float64)
            up, down, open_up, open_down = _axial_chord(y, x, width, fields, relative, usable, factor, median_width)
            tan_chord, censored, chord_planes = _chord_tangent(width, up, down, open_up, open_down, median_width)
            tan_drift, reach = _boundary_drift(y, x, vy, vx, width, fields, index, relative, usable, factor, median_width)
        else:
            tan_chord = np.full(count, np.nan)
            tan_drift = np.full(count, np.nan)
            censored = np.ones(count, dtype=bool)
            chord_planes = np.full(count, np.nan)
            reach = np.zeros(count)

        clean = artifact == SAMPLE_OK
        results[plane.z_index] = PlaneAnalysis(
            z_index=plane.z_index,
            shape=tuple(geometry.shape),
            sample_piece=piece,
            sample_artifact=artifact,
            sample_tan_chord=tan_chord,
            sample_tan_drift=tan_drift,
            sample_chord_censored=censored,
            sample_chord_planes=chord_planes,
            sample_window_planes=reach,
            piece_samples=np.bincount(piece, minlength=piece_count) if count else np.empty(0, dtype=np.int64),
            piece_center_x=_aggregate(piece, piece_count, x.astype(np.float64), clean),
            piece_center_y=_aggregate(piece, piece_count, y.astype(np.float64), clean),
            piece_width_px=_aggregate(piece, piece_count, width, clean),
            piece_tan_chord=_aggregate(piece, piece_count, tan_chord, clean),
            piece_tan_drift=_aggregate(piece, piece_count, tan_drift, clean),
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
        if progress:
            progress(0.5 + 0.5 * (index + 1) / len(planes), "Measuring GBM orientation")
    return results


# ---- Decisions (NumPy only; used by the web API at query time) ---------------

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

AUTO_TILT_INFLATION = 1.25
AUTO_TILT_RANGE_DEG = (15.0, 35.0)
# With no Z step on record: a sheet smeared sideways by this multiple of its own
# thickness cannot be measured as a cross-section at all.
EN_FACE_SMEAR = 1.0
# Also then, only to turn planes into a rough lateral distance for area and for
# choosing which pieces to take the reference thickness from.
ASSUMED_AXIAL_PX_PER_PLANE = 4.0
SPECK_AREA_THICKNESSES = 6.0
COMPACT_ASPECT = 2.0


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
    """Tilt of each piece from vertical, in degrees; NaN where no neighbours exist."""
    scale = float(pixel_size_um) / float(z_step_um)
    fused = fuse_tangent(analysis.piece_tan_chord, analysis.piece_tan_drift, analysis.piece_censored > 0.5)
    smoothed = smooth_over_pieces(fused, analysis.piece_edges)
    return np.degrees(np.arctan(smoothed * scale))


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


def classify_pieces(
    analysis: PlaneAnalysis,
    settings: FilterSettings,
    *,
    pixel_size_um: float,
    z_step_um: float | None,
    expansion_factor: float = 1.0,
    tilt_limit_field: np.ndarray | None = None,
    trusted_reasons: np.ndarray | None = None,
) -> dict[str, Any]:
    """Assign every piece a reason code; ``REASON_KEPT`` pieces count in measurements.

    ``tilt_limit_field`` replaces the tilt limit per piece (local corrections).
    ``trusted_reasons`` holds, per piece, a reason code a nearby correction has
    vouched for (or -1), so it no longer excludes that piece.
    """
    count = analysis.piece_samples.size
    reasons = np.zeros(count, dtype=np.int32)
    width = np.asarray(analysis.piece_width_px, dtype=np.float64)
    has_neighbours = analysis.neighbour_planes > 0
    has_tilt = bool(z_step_um) and has_neighbours
    drift = None
    if has_tilt:
        tilt = piece_tilt_deg(analysis, pixel_size_um, z_step_um)
        reference_px = reference_width_px(analysis, tilt)
    else:
        tilt = np.full(count, np.nan)
        if has_neighbours:
            drift = smooth_over_pieces(
                fuse_tangent(analysis.piece_tan_chord, analysis.piece_tan_drift, analysis.piece_censored > 0.5),
                analysis.piece_edges,
            )
            reference_px = reference_width_px(analysis, np.degrees(np.arctan(drift / ASSUMED_AXIAL_PX_PER_PLANE)))
        else:
            reference_px = reference_width_px(analysis)
    reference_um = reference_px * float(pixel_size_um)
    if not has_tilt:
        limit = None
    elif settings.max_tilt_deg is not None:
        limit = float(settings.max_tilt_deg)
    else:
        limit = auto_max_tilt_deg(float(z_step_um), reference_um, settings.mip_planes)
    field_ = np.full(count, np.nan if limit is None else limit) if tilt_limit_field is None else np.asarray(tilt_limit_field, dtype=np.float64)

    if settings.cross_section and count:
        artifact = np.asarray(analysis.piece_artifact) >= 0.5
        reasons[artifact] = REASON_ARTIFACT
        planes = np.asarray(analysis.piece_chord_planes, dtype=np.float64)
        open_ended = np.asarray(analysis.piece_censored) >= 0.5
        if has_neighbours:
            with np.errstate(invalid="ignore"):
                if has_tilt:
                    en_face = tilt > np.maximum(field_, EN_FACE_TILT_DEG)
                    oblique = (tilt > field_) & ~en_face
                    scale = float(z_step_um) / float(pixel_size_um)
                else:
                    # Without a Z step the angle is unknown, but what it does to the
                    # measurement is not: the projection smears a sheet sideways by
                    # its drift per plane, in pixels, whatever the Z step is.
                    smear = max(0, settings.mip_planes - 1) * drift / max(reference_px, 1.0)
                    en_face = smear > EN_FACE_SMEAR
                    oblique = (smear > AUTO_TILT_INFLATION - 1.0) & ~en_face
                    scale = ASSUMED_AXIAL_PX_PER_PLANE
                # A structure no longer than the Z projection itself is not a
                # sheet running through the stack.
                transient = (planes <= settings.mip_planes + 2.0) & ~open_ended
            area = np.asarray(analysis.piece_cc_samples, dtype=np.float64) * scale * float(settings.plane_step)
            speck = area < SPECK_AREA_THICKNESSES * max(reference_px, 1.0) ** 2
            for mask, code in (
                (speck, REASON_SPECK), (transient, REASON_TRANSIENT),
                (oblique, REASON_OBLIQUE), (en_face, REASON_EN_FACE),
            ):
                reasons[mask & (reasons == 0)] = code
            compact = np.asarray(analysis.piece_component_aspect) < COMPACT_ASPECT
            reasons[compact & (reasons == 0)] = REASON_COMPACT
        else:
            # One plane only: shape is all there is. Wide, short patches are
            # what en-face sheet looks like; compact islands are not sheets.
            aspect = np.asarray(analysis.piece_component_aspect)
            wide = width > 2.0 * max(reference_px, 1.0)
            reasons[wide & (reasons == 0)] = REASON_WIDE_PATCH
            reasons[(aspect < COMPACT_ASPECT) & (reasons == 0)] = REASON_COMPACT
        if trusted_reasons is not None:
            trusted = (np.asarray(trusted_reasons) == reasons) & (reasons != REASON_KEPT)
            reasons[trusted] = REASON_KEPT

    if settings.thickness_limits and count:
        thickness_nm = width * float(pixel_size_um) / float(expansion_factor) * 1000.0
        with np.errstate(invalid="ignore"):
            reasons[(thickness_nm < settings.min_nm) & (reasons == 0)] = REASON_TOO_THIN
            reasons[(thickness_nm > settings.max_nm) & (reasons == 0)] = REASON_TOO_THICK
    return {"reasons": reasons, "tilt_deg": tilt, "limit_deg": limit, "reference_px": reference_px}


__all__ = [name for name in globals() if name.isupper()] + [
    "PlaneAnalysis",
    "StackPlane",
    "analyze_stack",
    "build_pieces",
    "fuse_tangent",
    "signed_distance",
]
