"""TIFF metadata and browser-display transcoding.

The viewer intentionally does not perform image analysis or scientific image
preprocessing. The PNG preview endpoint selects the first displayable source
plane. The raw-channel endpoint exposes one selected channel plane as immutable
little-endian bytes so the browser can apply reversible display-only controls.
"""
from collections import OrderedDict
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
import threading
import math
import re
from xml.etree import ElementTree

import numpy as np
import tifffile
from PIL import Image

from .errors import BadRequest, UnsupportedTiff

try:
    import nd2
except ImportError:  # pragma: no cover - exercised only without optional dependency
    nd2 = None


RAW_DISPLAY_POLICY = "first-plane-no-preprocessing"
RAW_CHANNEL_DISPLAY_POLICY = "selected-raw-channel-client-display-controls"
PREVIEW_DISPLAY_POLICY = "bounded-auto-window-display-preview"
DEFAULT_PIXEL_SIZE_UM = 0.106872
DEFAULT_PREVIEW_MAX_SIZE = 1400
MAX_PREVIEW_MAX_SIZE = 2400
PREVIEW_COLOR = (255, 255, 255)

@dataclass(frozen=True)
class RawChannelBundle:
    channels: tuple[bytes, ...]
    byte_count: int


class RawChannelCache:
    """Bounded in-process cache for decoded raw channel payloads."""

    def __init__(self, max_bytes: int = 512 * 1024 * 1024):
        self.max_bytes = max(0, int(max_bytes or 0))
        self._cache = OrderedDict()
        self._current_bytes = 0
        self._inflight = {}
        self._lock = threading.RLock()

    def channel_bytes(self, filepath: Path, channel_index: int, z_index: int = 0):
        if isinstance(channel_index, bool) or not isinstance(channel_index, int) or channel_index < 0:
            raise BadRequest("channel index must be a non-negative integer")
        z_index = _z_index(z_index)

        bundle = self._bundle(filepath, z_index)
        if channel_index >= len(bundle.channels):
            raise BadRequest(f"channel index must be between 0 and {len(bundle.channels) - 1}")
        return BytesIO(bundle.channels[channel_index])

    def _bundle(self, filepath: Path, z_index: int = 0):
        key = _raw_channel_cache_key(filepath, z_index)
        with self._lock:
            cached = self._cache.get(key)
            if cached is not None:
                self._cache.move_to_end(key)
                return cached

            state = self._inflight.get(key)
            if state is None:
                state = {
                    "event": threading.Event(),
                    "bundle": None,
                    "error": None,
                }
                self._inflight[key] = state
                builder = True
            else:
                builder = False

        if builder:
            try:
                bundle = _build_raw_channel_bundle(filepath, z_index)
                with self._lock:
                    state["bundle"] = bundle
                    self._store_locked(key, bundle)
            except Exception as exc:
                with self._lock:
                    state["error"] = exc
            finally:
                with self._lock:
                    state["event"].set()
                    self._inflight.pop(key, None)

        if not builder:
            state["event"].wait()

        if state["error"] is not None:
            raise state["error"]
        if state["bundle"] is None:
            raise RuntimeError("Raw channel cache did not produce a channel bundle")
        return state["bundle"]

    def _store_locked(self, key, bundle):
        if self.max_bytes <= 0 or bundle.byte_count > self.max_bytes:
            return

        previous = self._cache.pop(key, None)
        if previous is not None:
            self._current_bytes -= previous.byte_count

        self._cache[key] = bundle
        self._current_bytes += bundle.byte_count
        while self._current_bytes > self.max_bytes and self._cache:
            _, evicted = self._cache.popitem(last=False)
            self._current_bytes -= evicted.byte_count


def infer_axes(shape):
    ndim = len(shape)
    if ndim == 2:
        return "YX"
    if ndim == 3:
        if shape[-1] <= 4:
            return "YXC"
        if shape[0] <= 8:
            return "CYX"
        return "IYX"
    if ndim == 4:
        if shape[-1] <= 4:
            return "IYXC"
        if shape[0] <= 8:
            return "CIYX"
        if shape[1] <= 8:
            return "ICYX"
    return ""


def get_metadata(filepath: Path):
    path = Path(filepath)
    if _is_nd2(path):
        return _get_nd2_metadata(path)
    st = path.stat()
    with tifffile.TiffFile(path) as tf:
        series = _display_series(tf)
        axes = _axes_for_shape(series.shape, series.axes)
        axes = _z_display_axes(series.shape, axes)
        height, width = _image_dimensions(series.shape, axes)
        sample_dtype, bits_per_sample = _read_sample_info(series)
        channel_count = _channel_count(series.shape, axes)
        channel_value_min, channel_value_max = _channel_value_range(series.dtype)
        pixel_size = _read_pixel_size_um(tf, series)
    return {
        "sourceRelPath": path.name,
        "sourceFormat": "TIFF",
        "sourceSize": st.st_size,
        "sourceMtimeNs": st.st_mtime_ns,
        "axes": axes,
        "width": int(width),
        "height": int(height),
        "sampleDtype": sample_dtype,
        "bitsPerSample": bits_per_sample,
        "displayPolicy": RAW_DISPLAY_POLICY,
        "channelCount": int(channel_count),
        "channelAxis": "C" if "C" in axes else None,
        "channelDtype": sample_dtype,
        "channelBitsPerSample": bits_per_sample,
        "channelValueMin": channel_value_min,
        "channelValueMax": channel_value_max,
        "channelByteOrder": "little",
        "channelDisplayPolicy": RAW_CHANNEL_DISPLAY_POLICY,
        "zCount": int(_z_count(series.shape, axes)),
        "zAxis": "Z" if "Z" in axes else None,
        "zIndex": 0,
        "timeCount": int(_axis_count(series.shape, axes, "T")),
        "previewDisplayPolicy": PREVIEW_DISPLAY_POLICY,
        "pixelSizeUm": pixel_size["x"],
        "pixelSizeXUm": pixel_size["x"],
        "pixelSizeYUm": pixel_size["y"],
        "pixelSizeSource": pixel_size["source"],
        "pixelSizeIsDefault": pixel_size["isDefault"],
    }


def render_raw_image_png(filepath: Path):
    """Encode the first source plane as PNG without scientific preprocessing."""
    if _is_nd2(filepath):
        plane = _nd2_channel_plane(filepath, 0, 0)
        image = _raw_image_from_array(plane)
        buf = BytesIO()
        image.save(buf, format="PNG")
        buf.seek(0)
        return buf
    with tifffile.TiffFile(filepath) as tf:
        series = _display_series(tf)
        axes = _axes_for_shape(series.shape, series.axes)
        axes = _z_display_axes(series.shape, axes)
        data = series.asarray()

    plane = _first_displayable_plane(data, axes)
    image = _raw_image_from_array(plane)
    buf = BytesIO()
    image.save(buf, format="PNG")
    buf.seek(0)
    return buf


def render_raw_channel_bytes(filepath: Path, channel_index: int, z_index: int = 0):
    """Return one channel plane as immutable raw bytes for browser composition."""
    if _is_nd2(filepath):
        plane = _nd2_channel_plane(filepath, channel_index, _z_index(z_index))
        raw = _raw_channel_array(plane)
        buf = BytesIO(raw.tobytes(order="C"))
        buf.seek(0)
        return buf

    with tifffile.TiffFile(filepath) as tf:
        series = _display_series(tf)
        axes = _axes_for_shape(series.shape, series.axes)
        axes = _z_display_axes(series.shape, axes)
        plane = _read_raw_channel_plane(series, axes, channel_index, _z_index(z_index))

    raw = _raw_channel_array(plane)
    buf = BytesIO(raw.tobytes(order="C"))
    buf.seek(0)
    return buf

def render_preview_png(filepath: Path, max_size: int = DEFAULT_PREVIEW_MAX_SIZE, z_index: int = 0):
    """Render a bounded display preview for browsing over slower connections."""
    max_size = _preview_max_size(max_size)
    if _is_nd2(filepath):
        return _render_nd2_preview_png(filepath, max_size, _z_index(z_index))

    with tifffile.TiffFile(filepath) as tf:
        series = _display_series(tf)
        axes = _axes_for_shape(series.shape, series.axes)
        axes = _z_display_axes(series.shape, axes)
        data = series.asarray()

    arr = np.asarray(data)
    axes = _axes_for_shape(arr.shape, axes)
    height, width = _image_dimensions(arr.shape, axes)
    target_width, target_height = _preview_dimensions(width, height, max_size)
    channel_count = _channel_count(arr.shape, axes)
    output = np.zeros((target_height, target_width, 3), dtype=np.float32)

    for channel_index in _preview_visible_channels(channel_count):
        plane = _raw_channel_array(_raw_channel_plane(arr, axes, channel_index, _z_index(z_index)))
        thumbnail = _resize_preview_plane(plane, target_width, target_height)
        intensity = 1.0 - (_auto_window_uint8(thumbnail).astype(np.float32) / 255.0)
        color = _preview_color(channel_count, channel_index)
        output[..., 0] += intensity * color[0]
        output[..., 1] += intensity * color[1]
        output[..., 2] += intensity * color[2]

    image = Image.fromarray(np.clip(output, 0, 255).astype(np.uint8), mode="RGB")
    buf = BytesIO()
    image.save(buf, format="PNG", optimize=True)
    buf.seek(0)
    return buf



def _raw_channel_cache_key(filepath: Path, z_index: int = 0):
    path = Path(filepath)
    stat = path.stat()
    return (str(path.resolve()), stat.st_size, stat.st_mtime_ns, int(z_index or 0))


def _build_raw_channel_bundle(filepath: Path, z_index: int = 0):
    if _is_nd2(filepath):
        return _build_nd2_raw_channel_bundle(filepath, z_index)

    with tifffile.TiffFile(filepath) as tf:
        series = _display_series(tf)
        axes = _axes_for_shape(series.shape, series.axes)
        axes = _z_display_axes(series.shape, axes)
        channel_count = _channel_count(series.shape, axes)
        channels = []
        byte_count = 0
        for channel_index in range(channel_count):
            plane = _read_raw_channel_plane(series, axes, channel_index, _z_index(z_index))
            raw = _raw_channel_array(plane)
            payload = raw.tobytes(order="C")
            channels.append(payload)
            byte_count += len(payload)
    return RawChannelBundle(tuple(channels), byte_count)

def _axes_for_shape(shape, axes):
    axes = (axes or "").upper()
    if len(axes) != len(shape):
        axes = infer_axes(shape)
    if not axes or len(axes) != len(shape):
        raise UnsupportedTiff(f"Cannot infer TIFF axes for shape {tuple(shape)}")
    if "S" in axes and "C" not in axes:
        axes = axes.replace("S", "C")
    return axes


def _display_series(tf):
    series = getattr(tf, "series", None) or []
    if not series:
        raise UnsupportedTiff("TIFF does not contain an image series")
    return series[0]


def _z_display_axes(shape, axes):
    """Treat unlabelled multi-page image stacks as Z for viewer navigation."""
    if "Z" in axes or "I" not in axes:
        return axes
    if "Y" not in axes or "X" not in axes:
        return axes
    if "C" in axes and shape[axes.index("I")] <= 1:
        return axes
    return axes.replace("I", "Z", 1)


def _image_dimensions(shape, axes):
    if "Y" in axes and "X" in axes:
        return shape[axes.index("Y")], shape[axes.index("X")]
    if len(shape) >= 2:
        return shape[-2], shape[-1]
    raise UnsupportedTiff(f"Cannot infer image dimensions for shape {tuple(shape)}")


def _channel_count(shape, axes):
    if "C" not in axes:
        return 1
    return shape[axes.index("C")]


def _axis_count(shape, axes, axis):
    return int(shape[axes.index(axis)]) if axis in axes else 1


def _z_count(shape, axes):
    return _axis_count(shape, axes, "Z")


def _z_index(value):
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = 0
    if number < 0:
        raise BadRequest("z index must be a non-negative integer")
    return number


def _is_nd2(filepath: Path):
    return Path(filepath).suffix.lower() == ".nd2"


def _require_nd2():
    if nd2 is None:
        raise UnsupportedTiff("ND2 support is not installed on this server")


def _get_nd2_metadata(path: Path):
    _require_nd2()
    st = path.stat()
    with nd2.ND2File(path) as ndfile:
        sizes = dict(ndfile.sizes)
        dtype = np.dtype(ndfile.dtype)
        width = int(sizes.get("X") or getattr(ndfile.attributes, "widthPx", 0) or 0)
        height = int(sizes.get("Y") or getattr(ndfile.attributes, "heightPx", 0) or 0)
        channel_count = int(sizes.get("C") or 1)
        z_count = int(sizes.get("Z") or 1)
        time_count = int(sizes.get("T") or 1)
        pixel_size = _read_nd2_pixel_size_um(ndfile)
        channel_value_min, channel_value_max = _channel_value_range(dtype)
        axes = "".join(sizes.keys()) or "YX"

    if width <= 0 or height <= 0:
        raise UnsupportedTiff("Cannot infer ND2 image dimensions")

    return {
        "sourceRelPath": path.name,
        "sourceFormat": "ND2",
        "sourceSize": st.st_size,
        "sourceMtimeNs": st.st_mtime_ns,
        "axes": axes,
        "width": width,
        "height": height,
        "sampleDtype": str(dtype),
        "bitsPerSample": int(dtype.itemsize * 8),
        "displayPolicy": RAW_DISPLAY_POLICY,
        "channelCount": channel_count,
        "channelAxis": "C" if channel_count > 1 else None,
        "channelDtype": str(dtype),
        "channelBitsPerSample": int(dtype.itemsize * 8),
        "channelValueMin": channel_value_min,
        "channelValueMax": channel_value_max,
        "channelByteOrder": "little",
        "channelDisplayPolicy": RAW_CHANNEL_DISPLAY_POLICY,
        "zCount": z_count,
        "zAxis": "Z" if z_count > 1 else None,
        "zIndex": 0,
        "timeCount": time_count,
        "previewDisplayPolicy": PREVIEW_DISPLAY_POLICY,
        "pixelSizeUm": pixel_size["x"],
        "pixelSizeXUm": pixel_size["x"],
        "pixelSizeYUm": pixel_size["y"],
        "pixelSizeSource": pixel_size["source"],
        "pixelSizeIsDefault": pixel_size["isDefault"],
    }


def _read_nd2_pixel_size_um(ndfile):
    try:
        voxel = ndfile.voxel_size()
        x = _positive_number(getattr(voxel, "x", None))
        y = _positive_number(getattr(voxel, "y", None))
    except Exception:
        x = y = None
    completed = _complete_pixel_size(x, y, "ND2 voxel size")
    if completed:
        x_value, y_value, source = completed
        return {"x": x_value, "y": y_value, "source": source, "isDefault": False}
    return {
        "x": DEFAULT_PIXEL_SIZE_UM,
        "y": DEFAULT_PIXEL_SIZE_UM,
        "source": "default",
        "isDefault": True,
    }


def _build_nd2_raw_channel_bundle(filepath: Path, z_index: int = 0):
    _require_nd2()
    z_index = _z_index(z_index)

    # Open the ND2 once and read each underlying frame once, rather than
    # re-opening the file (and re-reading frames) for every channel. Opening an
    # ND2 is expensive, so this is the dominant cost when scrubbing Z on a
    # multi-channel stack.
    with nd2.ND2File(filepath) as ndfile:
        sizes = dict(ndfile.sizes)
        channel_count = int(sizes.get("C") or 1)
        z_count = int(sizes.get("Z") or 1)
        if z_index >= z_count:
            raise BadRequest(f"z index must be between 0 and {z_count - 1}")

        channel_looped = _nd2_channel_is_looped(ndfile)
        frame_cache: dict[int, np.ndarray] = {}
        channels = []
        byte_count = 0
        for channel_index in range(channel_count):
            frame_index = _nd2_frame_index(ndfile, channel_index, z_index)
            frame = frame_cache.get(frame_index)
            if frame is None:
                frame = np.asarray(ndfile.read_frame(frame_index))
                frame_cache[frame_index] = frame
            plane = _nd2_plane_from_frame(frame, sizes, channel_index, channel_looped)
            raw = _raw_channel_array(np.array(plane, copy=True))
            payload = raw.tobytes(order="C")
            channels.append(payload)
            byte_count += len(payload)
    return RawChannelBundle(tuple(channels), byte_count)


def _nd2_channel_plane(filepath: Path, channel_index: int, z_index: int = 0):
    _require_nd2()
    if isinstance(channel_index, bool) or not isinstance(channel_index, int) or channel_index < 0:
        raise BadRequest("channel index must be a non-negative integer")
    z_index = _z_index(z_index)

    with nd2.ND2File(filepath) as ndfile:
        sizes = dict(ndfile.sizes)
        channel_count = int(sizes.get("C") or 1)
        z_count = int(sizes.get("Z") or 1)
        if channel_index >= channel_count:
            raise BadRequest(f"channel index must be between 0 and {channel_count - 1}")
        if z_index >= z_count:
            raise BadRequest(f"z index must be between 0 and {z_count - 1}")

        frame_index = _nd2_frame_index(ndfile, channel_index, z_index)
        frame = np.asarray(ndfile.read_frame(frame_index))
        plane = _nd2_plane_from_frame(frame, sizes, channel_index, _nd2_channel_is_looped(ndfile))
        return np.array(plane, copy=True)


def _nd2_channel_is_looped(ndfile):
    try:
        return any("C" in item for item in ndfile.loop_indices)
    except Exception:
        return False


def _nd2_frame_index(ndfile, channel_index: int, z_index: int):
    try:
        loop_indices = tuple(ndfile.loop_indices)
    except Exception:
        loop_indices = ()
    if not loop_indices:
        return 0

    channel_looped = any("C" in item for item in loop_indices)
    for index, coords in enumerate(loop_indices):
        for axis, value in coords.items():
            target = 0
            if axis == "Z":
                target = z_index
            elif axis == "C" and channel_looped:
                target = channel_index
            if int(value) != int(target):
                break
        else:
            return index
    raise BadRequest("Requested ND2 z/channel plane is not available")


def _nd2_plane_from_frame(frame, sizes, channel_index: int, channel_looped: bool):
    arr = np.asarray(frame)
    if arr.ndim == 2:
        return arr
    if arr.ndim == 3 and not channel_looped:
        channel_count = int(sizes.get("C") or 1)
        if channel_count > 1 and arr.shape[0] == channel_count:
            return arr[channel_index]
        if channel_count > 1 and arr.shape[-1] == channel_count:
            return arr[..., channel_index]
    while arr.ndim > 2:
        arr = arr[0]
    return arr


def _render_nd2_preview_png(filepath: Path, max_size: int, z_index: int = 0):
    max_size = _preview_max_size(max_size)
    metadata = _get_nd2_metadata(filepath)
    z_count = int(metadata["zCount"])
    if z_index >= z_count:
        raise BadRequest(f"z index must be between 0 and {z_count - 1}")

    width = int(metadata["width"])
    height = int(metadata["height"])
    target_width, target_height = _preview_dimensions(width, height, max_size)
    channel_count = int(metadata["channelCount"])
    output = np.zeros((target_height, target_width, 3), dtype=np.float32)

    for channel_index in _preview_visible_channels(channel_count):
        plane = _raw_channel_array(_nd2_channel_plane(filepath, channel_index, z_index))
        thumbnail = _resize_preview_plane(plane, target_width, target_height)
        intensity = 1.0 - (_auto_window_uint8(thumbnail).astype(np.float32) / 255.0)
        color = _preview_color(channel_count, channel_index)
        output[..., 0] += intensity * color[0]
        output[..., 1] += intensity * color[1]
        output[..., 2] += intensity * color[2]

    image = Image.fromarray(np.clip(output, 0, 255).astype(np.uint8), mode="RGB")
    buf = BytesIO()
    image.save(buf, format="PNG", optimize=True)
    buf.seek(0)
    return buf

def _preview_max_size(value):
    try:
        requested = int(value)
    except (TypeError, ValueError):
        requested = DEFAULT_PREVIEW_MAX_SIZE
    return max(256, min(MAX_PREVIEW_MAX_SIZE, requested))


def _preview_dimensions(width, height, max_size):
    width = max(1, int(width))
    height = max(1, int(height))
    scale = min(1.0, float(max_size) / max(width, height))
    return max(1, int(round(width * scale))), max(1, int(round(height * scale)))

def _preview_visible_channels(channel_count):
    if channel_count <= 1:
        return (0,)
    return (1 if channel_count > 1 else 0,)


def _preview_color(channel_count, channel_index):
    return PREVIEW_COLOR


def _resize_preview_plane(plane, target_width, target_height):
    if plane.shape == (target_height, target_width):
        return plane

    resampling = getattr(Image, "Resampling", Image).BILINEAR
    image = Image.fromarray(plane)
    resized = image.resize((target_width, target_height), resampling)
    return np.asarray(resized)


def _auto_window_uint8(arr):
    arr = np.asarray(arr)
    if arr.size == 0:
        return np.zeros(arr.shape, dtype=np.uint8)

    observed_min = float(np.min(arr))
    observed_max = float(np.max(arr))
    if observed_max <= observed_min:
        return np.zeros(arr.shape, dtype=np.uint8)

    bins, edges = np.histogram(arr, bins=256, range=(observed_min, observed_max))
    pixel_count = max(1, int(arr.size))
    dominant_bin_limit = pixel_count / 10
    threshold = pixel_count / 5000

    low = 0
    while low < len(bins) - 1:
        count = int(bins[low])
        if count <= dominant_bin_limit and count > threshold:
            break
        low += 1

    high = len(bins) - 1
    while high > 0:
        count = int(bins[high])
        if count <= dominant_bin_limit and count > threshold:
            break
        high -= 1

    window_min = observed_min
    window_max = observed_max
    if high >= low:
        window_min = float(edges[low])
        window_max = float(edges[min(high + 1, len(edges) - 1)])
    if not math.isfinite(window_min) or not math.isfinite(window_max) or window_max <= window_min:
        window_min = observed_min
        window_max = observed_max

    normalized = (arr.astype(np.float32) - window_min) / max(1e-6, window_max - window_min)
    return (np.clip(normalized, 0.0, 1.0) * 255).astype(np.uint8)


def _first_displayable_plane(data, axes):
    arr = np.asarray(data)
    axes = _axes_for_shape(arr.shape, axes)

    if arr.ndim == 2:
        return arr
    if arr.ndim == 3 and axes.endswith("C") and arr.shape[-1] in (3, 4):
        return arr

    slices = []
    kept_axes = []
    for axis in axes:
        if axis in ("Y", "X"):
            slices.append(slice(None))
            kept_axes.append(axis)
        else:
            slices.append(0)

    plane = arr[tuple(slices)]
    if kept_axes == ["X", "Y"]:
        plane = plane.T
    while plane.ndim > 2:
        plane = plane[0]
    return plane


def _raw_channel_plane(data, axes, channel_index, z_index=0):
    arr = np.asarray(data)
    axes = _axes_for_shape(arr.shape, axes)
    if isinstance(channel_index, bool) or not isinstance(channel_index, int) or channel_index < 0:
        raise BadRequest("channel index must be a non-negative integer")

    channel_count = _channel_count(arr.shape, axes)
    if channel_index >= channel_count:
        raise BadRequest(f"channel index must be between 0 and {channel_count - 1}")
    z_index = _z_index(z_index)
    z_count = _z_count(arr.shape, axes)
    if z_index >= z_count:
        raise BadRequest(f"z index must be between 0 and {z_count - 1}")

    if "C" not in axes:
        slices = []
        kept_axes = []
        for axis in axes:
            if axis in ("Y", "X"):
                slices.append(slice(None))
                kept_axes.append(axis)
            elif axis == "Z":
                slices.append(z_index)
            else:
                slices.append(0)
        plane = arr[tuple(slices)]
        if kept_axes == ["X", "Y"]:
            plane = plane.T
        while plane.ndim > 2:
            plane = plane[0]
        if plane.ndim != 2:
            raise UnsupportedTiff("Raw channel display requires a grayscale source plane")
        return plane

    slices = []
    kept_axes = []
    for axis in axes:
        if axis in ("Y", "X"):
            slices.append(slice(None))
            kept_axes.append(axis)
        elif axis == "C":
            slices.append(channel_index)
        elif axis == "Z":
            slices.append(z_index)
        else:
            slices.append(0)

    plane = arr[tuple(slices)]
    if kept_axes == ["X", "Y"]:
        plane = plane.T
    while plane.ndim > 2:
        plane = plane[0]
    if plane.ndim != 2:
        raise UnsupportedTiff("Cannot extract a two-dimensional raw channel plane")
    return plane


def _read_raw_channel_plane(series, axes, channel_index, z_index=0):
    shape = tuple(series.shape)
    axes = _axes_for_shape(shape, axes)
    axes = _z_display_axes(shape, axes)
    if isinstance(channel_index, bool) or not isinstance(channel_index, int) or channel_index < 0:
        raise BadRequest("channel index must be a non-negative integer")

    channel_count = _channel_count(shape, axes)
    if channel_index >= channel_count:
        raise BadRequest(f"channel index must be between 0 and {channel_count - 1}")
    z_index = _z_index(z_index)
    z_count = _z_count(shape, axes)
    if z_index >= z_count:
        raise BadRequest(f"z index must be between 0 and {z_count - 1}")

    page_plane = _raw_channel_plane_from_pages(series, axes, channel_index, z_index)
    if page_plane is not None:
        return page_plane

    key = []
    kept_axes = []
    for axis in axes:
        if axis in ("Y", "X"):
            key.append(slice(None))
            kept_axes.append(axis)
        elif axis == "C":
            key.append(channel_index)
        elif axis == "Z":
            key.append(z_index)
        else:
            key.append(0)

    try:
        plane = series.asarray(key=tuple(key))
    except TypeError:
        plane = _raw_channel_plane(series.asarray(), axes, channel_index, z_index)
    except Exception:
        plane = _raw_channel_plane(series.asarray(), axes, channel_index, z_index)

    plane = np.asarray(plane)
    if kept_axes == ["X", "Y"]:
        plane = plane.T
    while plane.ndim > 2:
        plane = plane[0]
    if plane.ndim != 2:
        raise UnsupportedTiff("Cannot extract a two-dimensional raw channel plane")
    return plane


def _raw_channel_plane_from_pages(series, axes, channel_index, z_index):
    pages = getattr(series, "pages", None)
    if pages is None:
        return None

    shape = tuple(series.shape)
    non_spatial_axes = [axis for axis in axes if axis not in ("Y", "X")]
    if not non_spatial_axes:
        return None

    page_count = 1
    for axis in non_spatial_axes:
        page_count *= int(shape[axes.index(axis)])

    try:
        if len(pages) != page_count:
            return None
    except TypeError:
        return None

    coords = []
    for axis in non_spatial_axes:
        if axis == "C":
            coords.append(channel_index)
        elif axis == "Z":
            coords.append(z_index)
        else:
            coords.append(0)

    page_index = 0
    for axis, coord in zip(non_spatial_axes, coords):
        page_index = (page_index * int(shape[axes.index(axis)])) + int(coord)

    try:
        plane = np.asarray(pages[page_index].asarray())
    except Exception:
        return None

    if plane.ndim == 3 and "C" in axes:
        c_size = int(shape[axes.index("C")])
        if plane.shape[0] == c_size:
            plane = plane[channel_index]
        elif plane.shape[-1] == c_size:
            plane = plane[..., channel_index]
    while plane.ndim > 2:
        plane = plane[0]
    if plane.ndim != 2:
        return None
    return plane


def _raw_image_from_array(arr):
    """Create an image only when PNG can preserve source intensity values."""
    arr = np.asarray(arr)
    if arr.ndim == 2 and arr.dtype in (np.dtype("uint8"), np.dtype("uint16")):
        return Image.fromarray(arr)

    if arr.ndim == 3 and arr.shape[-1] in (3, 4) and arr.dtype == np.dtype("uint8"):
        return Image.fromarray(arr)

    raise UnsupportedTiff(
        "Raw display supports 8-bit or 16-bit grayscale TIFF planes and "
        "8-bit RGB/RGBA TIFF planes. This file would require intensity conversion, "
        "so the viewer refuses to preprocess it silently."
    )


def _raw_channel_array(arr):
    """Return a contiguous little-endian grayscale plane without scaling values."""
    arr = np.asarray(arr)
    if arr.ndim != 2:
        raise UnsupportedTiff("Raw channel display requires a two-dimensional grayscale plane")
    if arr.dtype == np.dtype("uint8"):
        return np.ascontiguousarray(arr)
    if arr.dtype == np.dtype("uint16") or arr.dtype == np.dtype(">u2"):
        return np.ascontiguousarray(arr.astype("<u2", copy=False))
    raise UnsupportedTiff(
        "Raw channel display supports only 8-bit or 16-bit unsigned TIFF planes. "
        "This file would require intensity conversion, so the viewer refuses to preprocess it silently."
    )


def _channel_value_range(dtype):
    try:
        sample_dtype = np.dtype(dtype)
    except Exception:
        return None, None
    if sample_dtype.kind != "u" or sample_dtype.itemsize not in (1, 2):
        return None, None
    info = np.iinfo(sample_dtype)
    return int(info.min), int(info.max)


def _read_sample_info(series):
    try:
        dtype = np.dtype(series.dtype)
        return str(dtype), int(dtype.itemsize * 8)
    except Exception:
        pass

    try:
        page = series.pages[0]
        bits_tag = page.tags.get("BitsPerSample")
        if not bits_tag:
            return None, None
        value = bits_tag.value
        if isinstance(value, (tuple, list)):
            value = max(int(v) for v in value)
        return None, int(value)
    except Exception:
        return None, None

def _read_pixel_size_um(tf, series):
    """Read physical X/Y calibration in micrometers per pixel, with a safe fallback."""
    for reader in (
        _pixel_size_from_ome,
        _pixel_size_from_imagej_metadata,
        _pixel_size_from_resolution_tags,
    ):
        try:
            value = reader(tf, series)
        except Exception:
            value = None
        if value:
            x, y, source = value
            return {
                "x": float(x),
                "y": float(y),
                "source": source,
                "isDefault": False,
            }

    return {
        "x": DEFAULT_PIXEL_SIZE_UM,
        "y": DEFAULT_PIXEL_SIZE_UM,
        "source": "default",
        "isDefault": True,
    }


def _pixel_size_from_ome(tf, series):
    ome = getattr(tf, "ome_metadata", None)
    if not ome:
        return None
    root = ElementTree.fromstring(ome)
    pixels = root.find(".//{*}Pixels")
    if pixels is None:
        return None
    x = _length_um(pixels.attrib.get("PhysicalSizeX"), pixels.attrib.get("PhysicalSizeXUnit", "µm"))
    y = _length_um(pixels.attrib.get("PhysicalSizeY"), pixels.attrib.get("PhysicalSizeYUnit", "µm"))
    return _complete_pixel_size(x, y, "OME-XML PhysicalSize")


def _pixel_size_from_imagej_metadata(tf, series):
    metadata = dict(getattr(tf, "imagej_metadata", None) or {})
    try:
        description = series.pages[0].description or ""
    except Exception:
        description = ""

    for line in description.splitlines():
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        metadata.setdefault(key.strip(), value.strip())

    unit = metadata.get("unit") or metadata.get("Unit")
    x_value = (
        metadata.get("pixel_width")
        or metadata.get("pixelWidth")
        or metadata.get("PixelWidth")
    )
    y_value = (
        metadata.get("pixel_height")
        or metadata.get("pixelHeight")
        or metadata.get("PixelHeight")
    )
    if x_value is None and y_value is None:
        return None

    x = _length_um(x_value, unit)
    y = _length_um(y_value, unit)
    return _complete_pixel_size(x, y, "ImageJ metadata")


def _pixel_size_from_resolution_tags(tf, series):
    try:
        page = series.pages[0]
    except Exception:
        return None

    x_resolution = _resolution_value(page.tags.get("XResolution"))
    y_resolution = _resolution_value(page.tags.get("YResolution"))
    resolution_unit = page.tags.get("ResolutionUnit")
    if resolution_unit is None:
        return None

    unit = resolution_unit.value
    if _resolution_unit_is(unit, 2, "inch"):
        scale_um = 25400.0
    elif _resolution_unit_is(unit, 3, "centimeter", "centimetre", "cm"):
        scale_um = 10000.0
    else:
        return None

    x = scale_um / x_resolution if _positive_number(x_resolution) else None
    y = scale_um / y_resolution if _positive_number(y_resolution) else None
    return _complete_pixel_size(x, y, "TIFF resolution tags")


def _resolution_value(tag):
    if tag is None:
        return None
    value = tag.value
    if isinstance(value, (tuple, list)) and len(value) == 2:
        denominator = float(value[1])
        return float(value[0]) / denominator if denominator else None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _resolution_unit_is(value, numeric, *names):
    try:
        if int(value) == numeric:
            return True
    except (TypeError, ValueError):
        pass
    text = str(value).strip().lower()
    return any(name in text for name in names)


def _length_um(value, unit):
    number = _positive_number(value)
    if number is None:
        return None
    unit_text = str(unit or "").strip().lower().replace("μ", "µ")
    unit_text = re.sub(r"[\s._-]+", "", unit_text)
    scales = {
        "µm": 1.0,
        "um": 1.0,
        "micron": 1.0,
        "microns": 1.0,
        "micrometer": 1.0,
        "micrometers": 1.0,
        "micrometre": 1.0,
        "micrometres": 1.0,
        "nm": 0.001,
        "nanometer": 0.001,
        "nanometers": 0.001,
        "nanometre": 0.001,
        "nanometres": 0.001,
        "mm": 1000.0,
        "millimeter": 1000.0,
        "millimeters": 1000.0,
        "millimetre": 1000.0,
        "millimetres": 1000.0,
        "cm": 10000.0,
        "centimeter": 10000.0,
        "centimeters": 10000.0,
        "centimetre": 10000.0,
        "centimetres": 10000.0,
        "m": 1000000.0,
        "meter": 1000000.0,
        "meters": 1000000.0,
        "metre": 1000000.0,
        "metres": 1000000.0,
    }
    scale = scales.get(unit_text)
    if scale is None:
        return None
    result = number * scale
    return result if _positive_number(result) is not None else None


def _positive_number(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number) or number <= 0 or number > 1_000_000:
        return None
    return number


def _complete_pixel_size(x, y, source):
    if _positive_number(x) is None and _positive_number(y) is None:
        return None
    if _positive_number(x) is None:
        x = y
    if _positive_number(y) is None:
        y = x
    return float(x), float(y), source
