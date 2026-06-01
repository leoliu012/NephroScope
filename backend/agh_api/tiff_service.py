import hashlib
import json
import os
import uuid
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import tifffile
from PIL import Image

from .errors import BadRequest, UnsupportedTiff
from .file_lock import file_lock


@dataclass(frozen=True)
class CacheContext:
    key: str
    directory: Path
    rel_path: str
    size: int
    mtime_ns: int


def infer_axes(shape):
    ndim = len(shape)
    if ndim == 2:
        return "YX"
    if ndim == 3:
        if shape[-1] <= 4:
            return "YXC"
        if shape[0] <= 8:
            return "CYX"
        return "ZYX"
    if ndim == 4:
        if shape[0] <= 8:
            return "CZYX"
        if shape[1] <= 8:
            return "ZCYX"
        if shape[-1] <= 4:
            return "ZYXC"
        return "CZYX"
    if ndim == 5:
        if shape[0] == 1 and shape[1] <= 8:
            return "TCZYX"
        if shape[0] == 1 and shape[2] <= 8:
            return "TZCYX"
    return ""


def normalise_shape_to_czyx(shape, axes=""):
    dims = list(shape)
    axes = _prepare_axes(axes, dims)

    dims, axes = _drop_extra_singletons(dims, axes)
    if "Y" not in axes or "X" not in axes:
        axes = infer_axes(dims)
    dims, axes = _prepare_czyx_axes(dims, axes)

    order = [axes.index(axis) for axis in "CZYX"]
    return tuple(dims[i] for i in order)


def load_channels(filepath: Path):
    with tifffile.TiffFile(filepath) as tf:
        series = tf.series[0]
        axes = (series.axes or "").upper()
        data = series.asarray()
    return normalise_array_to_channels(data, axes)


def normalise_array_to_channels(data, axes=""):
    arr = np.asarray(data)
    axes = _prepare_axes(axes, list(arr.shape))
    arr, axes = _drop_array_extra_singletons(arr, axes)

    if "Y" not in axes or "X" not in axes:
        axes = infer_axes(arr.shape)

    arr, axes = _prepare_array_czyx_axes(arr, axes)
    order = [axes.index(axis) for axis in "CZYX"]
    czyx = np.transpose(arr, order)
    mip = czyx.max(axis=1)
    return [mip[c].astype(np.float32, copy=False) for c in range(mip.shape[0])]


def auto_scale(channel, lo_pct=0.0, hi_pct=99.5):
    lo = float(np.percentile(channel, lo_pct))
    hi = float(np.percentile(channel, hi_pct))
    if hi <= lo:
        return np.zeros(channel.shape, dtype=np.uint8)
    scaled = (channel - lo) / (hi - lo) * 255.0
    return np.clip(scaled, 0, 255).astype(np.uint8)


def _prepare_axes(axes, dims):
    axes = (axes or "").upper()
    if len(axes) != len(dims):
        axes = infer_axes(dims)
    if not axes or len(axes) != len(dims):
        raise UnsupportedTiff(f"Cannot infer TIFF axes for shape {tuple(dims)}")
    if "S" in axes and "C" not in axes:
        axes = axes.replace("S", "C")
    return axes


def _drop_extra_singletons(dims, axes):
    i = 0
    dims = list(dims)
    axes = list(axes)
    while i < len(dims):
        axis = axes[i]
        if axis not in "CZYX":
            if dims[i] == 1:
                del dims[i]
                del axes[i]
                continue
            raise UnsupportedTiff(f"Unsupported non-singleton TIFF axis {axis}")
        i += 1
    return dims, "".join(axes)


def _drop_array_extra_singletons(arr, axes):
    i = 0
    axes = list(axes)
    while i < arr.ndim:
        axis = axes[i]
        if axis not in "CZYX":
            if arr.shape[i] == 1:
                arr = np.take(arr, 0, axis=i)
                del axes[i]
                continue
            raise UnsupportedTiff(f"Unsupported non-singleton TIFF axis {axis}")
        i += 1
    return arr, "".join(axes)


def _prepare_czyx_axes(dims, axes):
    dims = list(dims)
    axes = list(axes)
    if "C" not in axes:
        dims.insert(0, 1)
        axes.insert(0, "C")
    if "Z" not in axes:
        insert_at = axes.index("C") + 1
        dims.insert(insert_at, 1)
        axes.insert(insert_at, "Z")
    unknown = [axis for axis in axes if axis not in "CZYX"]
    if unknown:
        raise UnsupportedTiff(f"Unsupported TIFF axes: {''.join(unknown)}")
    return dims, "".join(axes)


def _prepare_array_czyx_axes(arr, axes):
    axes = list(axes)
    if "C" not in axes:
        arr = np.expand_dims(arr, axis=0)
        axes.insert(0, "C")
    if "Z" not in axes:
        insert_at = axes.index("C") + 1
        arr = np.expand_dims(arr, axis=insert_at)
        axes.insert(insert_at, "Z")
    unknown = [axis for axis in axes if axis not in "CZYX"]
    if unknown:
        raise UnsupportedTiff(f"Unsupported TIFF axes: {''.join(unknown)}")
    return arr, "".join(axes)


class ImageCacheService:
    def __init__(self, data_root: Path, cache_root: Path):
        self.data_root = Path(data_root).resolve()
        self.cache_root = Path(cache_root)

    def get_metadata(self, image_path: Path):
        ctx = self._context(image_path)
        metadata_path = ctx.directory / "metadata.json"
        if metadata_path.exists():
            with metadata_path.open("r", encoding="utf-8") as f:
                return json.load(f)

        with file_lock(self._lock_path(ctx)):
            if metadata_path.exists():
                with metadata_path.open("r", encoding="utf-8") as f:
                    return json.load(f)
            metadata = self._read_metadata_fast(image_path, ctx)
            ctx.directory.mkdir(parents=True, exist_ok=True)
            _atomic_write_json(metadata_path, metadata)
            return metadata

    def get_channel_path(self, image_path: Path, channel_index: int) -> Path:
        if channel_index < 0:
            raise BadRequest("Channel index must be non-negative")
        metadata = self.get_metadata(image_path)
        if channel_index >= metadata["numChannels"]:
            raise BadRequest("Channel index out of range")
        ctx = self._context(image_path)
        png_path = ctx.directory / f"channel_{channel_index}.png"
        if not png_path.exists():
            self._ensure_rendered(image_path, ctx)
        return png_path

    def get_thumbnail_path(self, image_path: Path) -> Path:
        ctx = self._context(image_path)
        thumbnail = ctx.directory / "thumbnail.png"
        if not thumbnail.exists():
            self._ensure_rendered(image_path, ctx)
        return thumbnail

    def _ensure_rendered(self, image_path: Path, ctx: CacheContext):
        if self._cache_complete(ctx):
            return
        with file_lock(self._lock_path(ctx)):
            if self._cache_complete(ctx):
                return
            self._render_cache(image_path, ctx)

    def _context(self, image_path: Path) -> CacheContext:
        path = Path(image_path).resolve()
        try:
            rel_path = path.relative_to(self.data_root).as_posix()
        except ValueError as exc:
            raise BadRequest("Image path escapes data root") from exc
        st = path.stat()
        raw_key = f"{rel_path}|{st.st_size}|{st.st_mtime_ns}"
        key = hashlib.sha256(raw_key.encode("utf-8")).hexdigest()
        return CacheContext(
            key=key,
            directory=self.cache_root / key[:2] / key,
            rel_path=rel_path,
            size=st.st_size,
            mtime_ns=st.st_mtime_ns,
        )

    def _read_metadata_fast(self, image_path: Path, ctx: CacheContext):
        with tifffile.TiffFile(image_path) as tf:
            series = tf.series[0]
            c, _z, y, x = normalise_shape_to_czyx(series.shape, series.axes)
        return {
            "cacheKey": ctx.key,
            "sourceRelPath": ctx.rel_path,
            "sourceSize": ctx.size,
            "sourceMtimeNs": ctx.mtime_ns,
            "numChannels": int(c),
            "width": int(x),
            "height": int(y),
        }

    def _cache_complete(self, ctx: CacheContext):
        metadata_path = ctx.directory / "metadata.json"
        thumbnail_path = ctx.directory / "thumbnail.png"
        if not metadata_path.exists() or not thumbnail_path.exists():
            return False
        try:
            with metadata_path.open("r", encoding="utf-8") as f:
                metadata = json.load(f)
            num_channels = int(metadata["numChannels"])
        except Exception:
            return False
        return all((ctx.directory / f"channel_{index}.png").exists() for index in range(num_channels))

    def _lock_path(self, ctx: CacheContext):
        return self.cache_root / ".locks" / f"{ctx.key}.lock"

    def _render_cache(self, image_path: Path, ctx: CacheContext):
        ctx.directory.mkdir(parents=True, exist_ok=True)
        channels = load_channels(image_path)
        if not channels:
            raise UnsupportedTiff("TIFF did not contain any renderable channels")

        height, width = channels[0].shape[:2]
        metadata = {
            "cacheKey": ctx.key,
            "sourceRelPath": ctx.rel_path,
            "sourceSize": ctx.size,
            "sourceMtimeNs": ctx.mtime_ns,
            "numChannels": len(channels),
            "width": int(width),
            "height": int(height),
        }

        for index, channel in enumerate(channels):
            _atomic_write_png(ctx.directory / f"channel_{index}.png", auto_scale(channel))

        thumb = Image.fromarray(auto_scale(channels[0]), mode="L")
        thumb.thumbnail((512, 512))
        _atomic_save_image(ctx.directory / "thumbnail.png", thumb)
        _atomic_write_json(ctx.directory / "metadata.json", metadata)


def _atomic_write_png(path: Path, arr):
    image = Image.fromarray(arr, mode="L")
    _atomic_save_image(path, image)


def _atomic_save_image(path: Path, image: Image.Image):
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    image.save(tmp, format="PNG")
    os.replace(tmp, path)


def _atomic_write_json(path: Path, payload):
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, sort_keys=True)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
