"""Small holes in predicted GBM that the slices around it do not have.

A hole is background enclosed by the GBM of one slice. The model leaves them where its
probability dips just under the threshold in the middle of a membrane: on real stacks the
probability inside small holes was 0.44 to 0.55, against 0.55 to enter the mask. A hole
splits the centerline in two around it, each half as wide as the membrane, so it is worth
closing, but only where there is evidence that GBM is there.

The evidence used is the stack. Every slice is a projection of five planes that overlaps
its neighbours' projections, and a sheet that leans moves steadily across them, so GBM at
one place in a slice below and in a slice above is GBM at that place in between. A hole is
filled when it is small, enclosed, and GBM covers it both below and above within a few
planes. One that lasts longer through the slices, or is only covered on one side, is left:
that is what a space between two membranes that meet looks like. Every slice of a hole
that spans several gets the same answer, since each is judged by how long the hole lasts.

The saved prediction is not changed. ``execute_stack_analysis`` works out the fills and
keeps them with the Z analysis.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

import numpy as np

from .gbm_cross_section import IDENTITY_REGISTRATION, StackPlane, to_plane, to_shared

# A hole no larger than this, in thicknesses squared of the plane's typical GBM, and no
# wider than this share of the thickness at its widest point. Larger enclosed background
# is a lumen or a space between membranes.
HOLE_MAX_AREA = 1.0
HOLE_MAX_WIDTH = 0.7
# A slice covers a hole when GBM is on this share of it. The nearest covering slices below
# and above may leave at most this many planes uncovered between them. A projection of five
# planes shows a hole only where all five lack GBM, so a real opening seen in one slice is
# already five planes deep and shows in several; a dip of the probability comes and goes.
HOLE_COVERAGE = 0.9
HOLE_MAX_PLANES = 3.0

# Background is joined along edges only: GBM is joined along corners too, so a hole that
# touches the outside at a corner is still enclosed.
_EDGE_NEIGHBOURS = np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]], dtype=bool)


@dataclass
class HoleFill:
    """What to add to one plane's mask: the pixels, and how many holes they close."""

    pixels: np.ndarray
    holes: int


def small_holes(mask: np.ndarray, reference_px: float) -> list[tuple[np.ndarray, np.ndarray]]:
    """Rows and columns of each small enclosed hole of ``mask``."""
    from scipy.ndimage import distance_transform_edt, find_objects, label

    mask = np.asarray(mask, dtype=bool)
    if not mask.any() or reference_px <= 0:
        return []
    labels, count = label(~mask, structure=_EDGE_NEIGHBOURS)
    if count < 2:
        return []
    area = np.bincount(labels.ravel(), minlength=count + 1)
    outside = np.zeros(count + 1, dtype=bool)
    for edge in (labels[0], labels[-1], labels[:, 0], labels[:, -1]):
        outside[edge] = True
    limit = HOLE_MAX_AREA * reference_px * reference_px
    found = []
    boxes = find_objects(labels)
    for index in np.nonzero(~outside[1:] & (area[1:] <= limit))[0] + 1:
        box = boxes[index - 1]
        hole = labels[box] == index
        # Twice the largest distance to the hole's own edge: the widest it gets.
        widest = 2.0 * float(distance_transform_edt(np.pad(hole, 1)).max())
        if widest > HOLE_MAX_WIDTH * reference_px:
            continue
        rows, columns = np.nonzero(hole)
        found.append((rows + box[0].start, columns + box[1].start))
    return found


def _covered(rows: np.ndarray, columns: np.ndarray, own: StackPlane, other: StackPlane) -> float:
    """Share of a hole of ``own`` that is GBM at the same place of the sample in ``other``."""
    own_registration = IDENTITY_REGISTRATION if own.registration is None else own.registration
    other_registration = IDENTITY_REGISTRATION if other.registration is None else other.registration
    y, x = to_shared(own_registration, rows.astype(np.float64), columns.astype(np.float64))
    y, x = to_plane(other_registration, y, x)
    y, x = np.rint(y).astype(np.int64), np.rint(x).astype(np.int64)
    mask = np.asarray(other.mask, dtype=bool)
    inside = (y >= 0) & (y < mask.shape[0]) & (x >= 0) & (x < mask.shape[1])
    if not inside.any():
        return 0.0
    return float(mask[y[inside], x[inside]].sum()) / float(rows.size)


def _nearest_cover(rows: np.ndarray, columns: np.ndarray, plane: StackPlane, others: Sequence[StackPlane]) -> float:
    """How many planes away the nearest of ``others`` that covers the hole is, or infinity."""
    for other in sorted(others, key=lambda other: abs(other.center - plane.center)):
        if _covered(rows, columns, plane, other) >= HOLE_COVERAGE:
            return abs(float(other.center) - float(plane.center))
    return float("inf")


def holes_to_fill(planes: Sequence[StackPlane], *, max_planes: float = HOLE_MAX_PLANES) -> dict[int, HoleFill]:
    """Per ``z_index``, the holes of that plane that slices below and above both cover.

    Every plane is judged against the predictions as saved, never against another
    plane's fill, so one fill cannot justify the next.
    """
    ordered = sorted(planes, key=lambda plane: plane.center)
    fills: dict[int, HoleFill] = {}
    for position, plane in enumerate(ordered):
        thickness = np.asarray(plane.geometry.local_thickness_pixels, dtype=np.float64)
        if thickness.size == 0:
            continue
        # Slices at a stack's ends repeat a neighbour's projection; the same prediction
        # twice is not a second opinion, so only planes projected elsewhere count.
        below = [other for other in ordered[:position] if 0.0 < plane.center - other.center <= max_planes]
        above = [other for other in ordered[position + 1:] if 0.0 < other.center - plane.center <= max_planes]
        if not below or not above:
            continue
        pixels = None
        holes = 0
        for rows, columns in small_holes(plane.mask, float(np.median(thickness))):
            # Planes between the two nearest covering slices, this one included.
            uncovered = _nearest_cover(rows, columns, plane, below) + _nearest_cover(rows, columns, plane, above) - 1.0
            if uncovered > max_planes:
                continue
            if pixels is None:
                pixels = np.zeros(np.asarray(plane.mask).shape, dtype=bool)
            pixels[rows, columns] = True
            holes += 1
        if pixels is not None:
            fills[int(plane.z_index)] = HoleFill(pixels, holes)
    return fills


__all__ = ["HOLE_COVERAGE", "HOLE_MAX_AREA", "HOLE_MAX_PLANES", "HOLE_MAX_WIDTH", "HoleFill", "holes_to_fill", "small_holes"]
