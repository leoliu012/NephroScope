"""A coarse 3D volume of an image's GBM predictions, for the viewer's 3D mode.

Every slice of the stack becomes one layer, and each layer is what the viewer shows on that
slice: the saved prediction with people's corrections, and the decision about which GBM
counts. Layers are reduced so the longer side of the image is at most ``MAX_SIDE`` voxels,
and put in register with each other where the stack analysis measured the field moving.
Nothing is smoothed or filled in between slices here; a layer does carry the small holes
the Z analysis closed on its slice (``gbm_holes``).

The first and last two slices of a stack are predicted from the same five planes as their
neighbour (see ``docs/model-inference.md``), so those layers repeat it.

Three volumes follow a small JSON header, one byte per voxel each:

* how much of the voxel is GBM, 0-255;
* how much of it is GBM that counts as measurable, 0-255;
* why the rest does not: a reason code of ``gbm_cross_section``, or 0.
"""
from __future__ import annotations

from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
import gzip
import json
import math
import struct
import threading

import numpy as np
from PIL import Image

from .analysis_artifacts import read_mask
from .errors import BadRequest, Conflict
from .gbm_cross_section import DEFAULT_MAX_WINDOW, REASON_KEPT, REASON_NAMES, FilterSettings, to_shared
from .gbm_refinement import (
    SEGMENTATION_OPERATION,
    _digest,
    _saved_motion,
    label_file,
    refinement_frames,
    resolve_z_step,
    stack_state,
)

MAGIC = b"GBV1"
FORMAT_VERSION = 1
# "More than 10 Z slices."
MIN_PLANES = 11
MAX_SIDE = 512
# A moving field widens the volume; beyond this much of the image on each side it is cut.
MAX_MARGIN_FRACTION = 0.25
WORKERS = 4
CACHED_VOLUMES = 6

_cache: OrderedDict[str, bytes] = OrderedDict()
_cache_lock = threading.Lock()


def reduction_factor(height: int, width: int) -> int:
    return max(1, math.ceil(max(int(height), int(width)) / MAX_SIDE))


def _blocks(values: np.ndarray, factor: int) -> np.ndarray:
    """``values`` as (rows, factor, columns, factor), padded with zeros to whole blocks."""
    height, width = values.shape
    rows, columns = math.ceil(height / factor), math.ceil(width / factor)
    if rows * factor != height or columns * factor != width:
        padded = np.zeros((rows * factor, columns * factor), dtype=values.dtype)
        padded[:height, :width] = values
        values = padded
    return values.reshape(rows, factor, columns, factor)


def reduce_coverage(mask: np.ndarray, factor: int) -> np.ndarray:
    """Share of each block that is set, 0-255."""
    if factor == 1:
        return np.where(mask, 255, 0).astype(np.uint8)
    total = _blocks(np.asarray(mask, dtype=np.uint8), factor).sum(axis=(1, 3), dtype=np.uint32)
    area = factor * factor
    return ((total * 255 + area // 2) // area).astype(np.uint8)


def reduce_reason(reason: np.ndarray, factor: int) -> np.ndarray:
    """One reason per block. Blocks rarely hold two, and then the higher code is as good as any."""
    if factor == 1:
        return np.asarray(reason, dtype=np.uint8)
    return _blocks(np.asarray(reason, dtype=np.uint8), factor).max(axis=(1, 3))


def read_layer(label_path, reasons, mask_reader) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """GBM, measurable GBM and reason codes of one slice, at full resolution.

    With a label image and its decisions, pieces carry their reasons. Without, the slice is
    the plain prediction and all of it counts.
    """
    if label_path is None:
        gbm = np.asarray(mask_reader(), dtype=bool)
        return gbm, gbm, np.zeros(gbm.shape, dtype=np.uint8)
    with Image.open(label_path) as image:
        rgb = np.asarray(image.convert("RGB"))
    piece = rgb[..., 0].astype(np.uint16) | (rgb[..., 1].astype(np.uint16) << 8)
    table = np.zeros(max(int(piece.max()), len(reasons)) + 1, dtype=np.uint8)
    table[1:len(reasons) + 1] = np.asarray(reasons, dtype=np.uint8)
    reason = table[piece]
    gbm = piece > 0
    return gbm, gbm & (reason == REASON_KEPT), reason


def _sample(values: np.ndarray, y: np.ndarray, x: np.ndarray, *, codes: bool = False) -> np.ndarray:
    """``values`` at fractional positions, zero outside it.

    Amounts are interpolated. Codes cannot be: a position takes the highest code among the
    four values around it, so wherever some excluded GBM is interpolated in, its reason is too.
    """
    height, width = values.shape
    padded = np.zeros((height + 2, width + 2), dtype=np.uint8 if codes else np.float32)
    padded[1:-1, 1:-1] = values
    y = np.clip(y + 1.0, 0.0, height + 0.999)
    x = np.clip(x + 1.0, 0.0, width + 0.999)
    row, column = np.floor(y).astype(np.int64), np.floor(x).astype(np.int64)
    row_next, column_next = np.minimum(row + 1, height + 1), np.minimum(column + 1, width + 1)
    if codes:
        return np.maximum(
            np.maximum(padded[row, column], padded[row, column_next]),
            np.maximum(padded[row_next, column], padded[row_next, column_next]),
        )
    fy, fx = (y - row).astype(np.float32), (x - column).astype(np.float32)
    top = padded[row, column] * (1.0 - fx) + padded[row, column_next] * fx
    bottom = padded[row_next, column] * (1.0 - fx) + padded[row_next, column_next] * fx
    return np.rint(top * (1.0 - fy) + bottom * fy).astype(np.uint8)


class VolumeGrid:
    """Where the volume's voxels are in the frame shared by the stack."""

    def __init__(self, height: int, width: int, factor: int, registrations: dict[int, np.ndarray] | None):
        self.height, self.width, self.factor = int(height), int(width), int(factor)
        self.registrations = registrations
        low_y = low_x = 0.0
        high_y, high_x = float(height), float(width)
        if registrations:
            corner_y = np.asarray([0.0, 0.0, height, height])
            corner_x = np.asarray([0.0, width, 0.0, width])
            for registration in registrations.values():
                y, x = to_shared(registration, corner_y, corner_x)
                low_y, high_y = min(low_y, float(y.min())), max(high_y, float(y.max()))
                low_x, high_x = min(low_x, float(x.min())), max(high_x, float(x.max()))
            low_y, high_y = max(low_y, -MAX_MARGIN_FRACTION * height), min(high_y, (1 + MAX_MARGIN_FRACTION) * height)
            low_x, high_x = max(low_x, -MAX_MARGIN_FRACTION * width), min(high_x, (1 + MAX_MARGIN_FRACTION) * width)
        self.origin_y, self.origin_x = math.floor(low_y), math.floor(low_x)
        self.rows = max(1, math.ceil((high_y - self.origin_y) / factor))
        self.columns = max(1, math.ceil((high_x - self.origin_x) / factor))

    def plane_from_voxel(self, z_index: int) -> np.ndarray:
        """2 x 3 matrix taking a voxel's (row, column, 1) to (y, x) in this slice's image."""
        factor = self.factor
        offset_y = self.origin_y + 0.5 * factor - 0.5
        offset_x = self.origin_x + 0.5 * factor - 0.5
        m = self.registrations[z_index] if self.registrations else np.array([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]])
        return np.array([
            [m[0, 0] * factor, m[0, 1] * factor, m[0, 0] * offset_y + m[0, 1] * offset_x + m[0, 2]],
            [m[1, 0] * factor, m[1, 1] * factor, m[1, 0] * offset_y + m[1, 1] * offset_x + m[1, 2]],
        ])

    def place(self, z_index: int, coverage: np.ndarray, kept: np.ndarray, reason: np.ndarray):
        """A slice's reduced layers on the volume's grid."""
        if not self.registrations:
            return coverage, kept, reason
        m = self.plane_from_voxel(z_index)
        row, column = np.mgrid[:self.rows, :self.columns].astype(np.float64)
        factor = self.factor
        # Position in the slice's image, then in its reduced layers.
        y = ((m[0, 0] * row + m[0, 1] * column + m[0, 2]) + 0.5) / factor - 0.5
        x = ((m[1, 0] * row + m[1, 1] * column + m[1, 2]) + 0.5) / factor - 0.5
        return _sample(coverage, y, x), _sample(kept, y, x), _sample(reason, y, x, codes=True)


def _validated_runs(runs: dict[str, dict]) -> list[dict]:
    """The runs as one stack: one image and channel, a finished prediction on every slice."""
    members = sorted(runs.values(), key=lambda run: int(run["zIndex"]))
    if any(run.get("status") != "SUCCEEDED" or run.get("operation") != SEGMENTATION_OPERATION for run in members):
        raise Conflict("3D needs finished predictions")
    images = {(run["case"], run["filename"], int(run["channelIndex"])) for run in members}
    if len(images) != 1:
        raise BadRequest("3D is built from one image and channel")
    slices = [int(run["zIndex"]) for run in members]
    if len(set(slices)) != len(slices):
        raise BadRequest("3D takes one prediction per Z slice")
    source = (members[0].get("request") or {}).get("source") or {}
    z_count = int(source.get("zCount") or 0)
    if z_count < MIN_PLANES:
        raise Conflict(f"3D needs an image with more than {MIN_PLANES - 1} Z slices")
    if slices != list(range(z_count)):
        raise Conflict(f"3D needs a prediction on every Z slice; {len(slices)} of {z_count} have one")
    return members


def build_gbm_volume(config, store, runs: dict[str, dict], settings: FilterSettings, options: dict, calibration: dict) -> bytes:
    """The 3D volume of one image's predictions, gzip-compressed."""
    members = _validated_runs(runs)
    first = members[0]
    case, filename, channel = first["case"], first["filename"], int(first["channelIndex"])
    source = (first.get("request") or {}).get("source") or {}
    height, width = int(source["height"]), int(source["width"])
    window = int(options.get("window") or DEFAULT_MAX_WINDOW)

    frames = refinement_frames(config, store, {run["runId"]: run for run in members}, settings, options, calibration)["frames"]
    state = stack_state(config, store, case, filename, channel, window=window, ensure=False)
    motion = _saved_motion(state.get("usable"))
    registrations = None
    if motion is not None:
        registrations = {}
        for run in members:
            projected = (run.get("request") or {}).get("zWindow") or [run["zIndex"]]
            registrations[int(run["zIndex"])] = motion.at((min(projected) + max(projected)) / 2.0)
    z_step = resolve_z_step(config, first, options.get("zStepUm"))
    factor = reduction_factor(height, width)
    grid = VolumeGrid(height, width, factor, registrations)

    # Label files are looked up here; reading and reducing them is spread over threads.
    memo: dict = {}
    layers = []
    for run in members:
        frame = frames.get(run["runId"])
        label_path = None
        if frame:
            try:
                label_path = label_file(config, store, run, {**options, "memo": memo})
            except Conflict:
                frame = None
        layers.append((run, frame, label_path))

    key = _digest({
        "format": FORMAT_VERSION, "factor": factor, "zStep": z_step["um"],
        "pixel": [calibration["pixelSizeXUm"], calibration["pixelSizeYUm"]],
        "layers": [
            [run["runId"], (run.get("result") or {}).get("artifactAttempt"), (frame or {}).get("labelToken"), (frame or {}).get("reason")]
            for run, frame, _ in layers
        ],
        "registration": None if registrations is None else [np.round(registrations[int(run["zIndex"])], 6).tolist() for run in members],
    })
    with _cache_lock:
        cached = _cache.get(key)
        if cached is not None:
            _cache.move_to_end(key)
            return cached

    def build(layer):
        run, frame, label_path = layer
        attempt = (run.get("result") or {}).get("artifactAttempt")
        gbm, kept, reason = read_layer(
            label_path, (frame or {}).get("reason") or [],
            lambda: read_mask(config.analysis_root, run["runId"], attempt=attempt),
        )
        if gbm.shape != (height, width):
            raise Conflict("A prediction does not match the size of its image")
        return grid.place(int(run["zIndex"]), reduce_coverage(gbm, factor), reduce_coverage(kept, factor), reduce_reason(reason, factor))

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        built = list(pool.map(build, layers))
    coverage = np.stack([layer[0] for layer in built])
    kept = np.stack([layer[1] for layer in built])
    reason = np.stack([layer[2] for layer in built])

    header = {
        "format": FORMAT_VERSION,
        "size": [grid.columns, grid.rows, len(members)],
        "factor": factor,
        "source": {"width": width, "height": height},
        "zIndices": [int(run["zIndex"]) for run in members],
        "runIds": [run["runId"] for run in members],
        "planeFromVoxel": [np.round(grid.plane_from_voxel(int(run["zIndex"])), 6).reshape(-1).tolist() for run in members],
        "voxelUm": {
            "x": float(calibration["pixelSizeXUm"]) * factor,
            "y": float(calibration["pixelSizeYUm"]) * factor,
            "z": z_step["um"],
        },
        "zStep": z_step,
        "registered": registrations is not None,
        "decidedLayers": sum(1 for _, frame, _ in layers if frame),
        "reasonNames": {str(code): name for code, name in REASON_NAMES.items()},
        "gbmVoxels": int(np.count_nonzero(coverage >= 128)),
        "keptVoxels": int(np.count_nonzero(kept >= 128)),
    }
    encoded = json.dumps(header, separators=(",", ":")).encode("utf-8")
    payload = gzip.compress(
        b"".join([MAGIC, struct.pack("<I", len(encoded)), encoded, coverage.tobytes(), kept.tobytes(), reason.tobytes()]),
        compresslevel=4,
    )
    with _cache_lock:
        _cache[key] = payload
        while len(_cache) > CACHED_VOLUMES:
            _cache.popitem(last=False)
    return payload


def parse_volume(payload: bytes) -> tuple[dict, np.ndarray, np.ndarray, np.ndarray]:
    """Header and the three volumes, as (z, row, column) arrays. For tests and scripts."""
    raw = gzip.decompress(payload) if payload[:2] == b"\x1f\x8b" else payload
    if raw[:4] != MAGIC:
        raise ValueError("Not a GBM volume")
    length = struct.unpack("<I", raw[4:8])[0]
    header = json.loads(raw[8:8 + length].decode("utf-8"))
    columns, rows, planes = header["size"]
    count = columns * rows * planes
    body = np.frombuffer(raw, dtype=np.uint8, offset=8 + length)
    volumes = [body[index * count:(index + 1) * count].reshape(planes, rows, columns) for index in range(3)]
    return header, volumes[0], volumes[1], volumes[2]
