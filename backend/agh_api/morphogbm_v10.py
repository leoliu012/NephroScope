"""MorphoGBM v10 preprocessing and v13-selected whole-plane inference.

The public entry point, :func:`segment_plane`, is intentionally filesystem
free apart from reading the immutable checkpoint.  Callers provide one raw
two-dimensional microscopy plane (normally a five-Z MIP) and receive arrays
that remain on the source pixel grid.

The implementation follows the supplied notebooks' deployed contract:

* per-plane 1st/99.7th-percentile contrast enhancement to uint8;
* v10 raw/log1p/sqrt input channels and stored channel statistics;
* the exact ConvNeXt-Pico residual U-Net checkpoint architecture;
* v13's 640-pixel halo input around overlapping 576-pixel output cores;
* D4 probability averaging and Gaussian first/second-moment stitching; and
* v13's selected 0.55/0.70 eight-connected hysteresis rule.

No source image, probability, or mask is written by this module.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace
from typing import Any
import hashlib
import math
import threading

import numpy as np

_TORCH_IMPORT_ERROR: Exception | None = None
_TIMM_IMPORT_ERROR: Exception | None = None

try:  # Keep non-model helpers importable in the base viewer environment.
    import torch
    import torch.nn as nn
    import torch.nn.functional as F
except Exception as exc:  # pragma: no cover - exercised by split/broken runtimes
    _TORCH_IMPORT_ERROR = exc
    torch = None
    nn = None
    F = None

try:
    import timm
except Exception as exc:  # pragma: no cover - e.g. an incompatible torchvision
    _TIMM_IMPORT_ERROR = exc
    timm = None

try:
    from scipy.ndimage import label as scipy_component_label
except ImportError:  # pragma: no cover - a small pure-Python fallback is tested
    scipy_component_label = None


MODEL_NAME = "morphogbm_v10_topology_source_robust"
EXPECTED_CHECKPOINT_SHA256 = (
    "a729ecc0036ddb6a52819dc92e93be43bd18d2ce8d472179a9fb92f0a76aec7f"
)
EXPECTED_MANIFEST_SHA256 = (
    "101a22b90aea3a3acea67cc5fe9d86497c1e84d5c450f808ba117444876ddc30"
)
EXPECTED_FORMAT_VERSION = 1

CORE_SIZE = 576
CONTEXT_HALO = 32
MODEL_INPUT_SIZE = CORE_SIZE + 2 * CONTEXT_HALO
TILE_STRIDE = 288
TILE_BATCH_SIZE = 2
GAUSSIAN_SIGMA_FRACTION = 0.25
GAUSSIAN_WEIGHT_FLOOR = 0.05
HYSTERESIS_LOW_THRESHOLD = 0.55
HYSTERESIS_HIGH_THRESHOLD = 0.70
HYSTERESIS_MINIMUM_SIZE = 0
D4_TRANSFORMS = tuple((k, flip) for k in range(4) for flip in (False, True))

EXPECTED_CHANNEL_MEAN = np.asarray(
    [0.276315838098526, 0.4881574511528015, 0.48866409063339233],
    dtype=np.float32,
)
EXPECTED_CHANNEL_STD = np.asarray(
    [0.19046537578105927, 0.22312936186790466, 0.19370914995670319],
    dtype=np.float32,
)
EXPECTED_CONFIG = {
    "experiment_name": MODEL_NAME,
    "image_size": CORE_SIZE,
    "input_value_scale": 255.0,
    "encoder_name": "convnext_pico.d1_in1k",
    "encoder_drop_path": 0.10,
    "bridge_channels": 256,
    "decoder_channels": (192, 96, 48, 32, 24),
    "decoder_dropout": 0.08,
}


ProgressCallback = Callable[[float, str], None]


def _runtime_error() -> RuntimeError:
    missing = []
    if torch is None:
        missing.append("torch")
    if timm is None:
        missing.append("timm==1.0.28")
    detail = ", ".join(missing) or "the model runtime"
    import_errors = [
        f"{type(error).__name__}: {error}"
        for error in (_TORCH_IMPORT_ERROR, _TIMM_IMPORT_ERROR)
        if error is not None
    ]
    suffix = f" Import error: {'; '.join(import_errors)}" if import_errors else ""
    return RuntimeError(
        f"MorphoGBM inference requires {detail}. "
        f"Install backend/requirements-inference.txt.{suffix}"
    )


def model_runtime_available() -> bool:
    """Return whether architecture reconstruction can run in this process."""
    return torch is not None and timm is not None


def _group_count(channels: int, maximum: int = 16) -> int:
    for groups in (maximum, 8, 4, 2, 1):
        if groups <= channels and channels % groups == 0:
            return groups
    return 1


if nn is not None:

    class ConvGNAct(nn.Sequential):
        def __init__(
            self,
            in_channels: int,
            out_channels: int,
            kernel_size: int = 3,
            dropout: float = 0.0,
        ) -> None:
            padding = kernel_size // 2
            layers: list[nn.Module] = [
                nn.Conv2d(
                    in_channels,
                    out_channels,
                    kernel_size,
                    padding=padding,
                    bias=False,
                ),
                nn.GroupNorm(_group_count(out_channels), out_channels),
                nn.GELU(),
            ]
            if dropout > 0:
                layers.append(nn.Dropout2d(float(dropout)))
            super().__init__(*layers)


    class ResidualRefine(nn.Module):
        def __init__(self, in_channels: int, out_channels: int, dropout: float = 0.0):
            super().__init__()
            self.conv1 = ConvGNAct(in_channels, out_channels, 3, dropout=dropout)
            self.conv2 = nn.Sequential(
                nn.Conv2d(out_channels, out_channels, 3, padding=1, bias=False),
                nn.GroupNorm(_group_count(out_channels), out_channels),
            )
            self.skip = (
                nn.Identity()
                if in_channels == out_channels
                else nn.Conv2d(in_channels, out_channels, 1, bias=False)
            )
            self.activation = nn.GELU()

        def forward(self, value):
            return self.activation(self.conv2(self.conv1(value)) + self.skip(value))


    class DecoderBlock(nn.Module):
        def __init__(
            self,
            in_channels: int,
            skip_channels: int,
            out_channels: int,
            dropout: float = 0.0,
        ) -> None:
            super().__init__()
            self.pre = ConvGNAct(in_channels + skip_channels, out_channels, 1)
            self.refine = ResidualRefine(out_channels, out_channels, dropout=dropout)

        def forward(self, value, skip=None, output_size=None):
            target_size = skip.shape[-2:] if skip is not None else output_size
            if target_size is None:
                target_size = (value.shape[-2] * 2, value.shape[-1] * 2)
            value = F.interpolate(
                value,
                size=target_size,
                mode="bilinear",
                align_corners=False,
            )
            if skip is not None:
                value = torch.cat([value, skip], dim=1)
            return self.refine(self.pre(value))


    class MorphoGBMv10(nn.Module):
        """Exact inference-time reconstruction of the selected v10 model."""

        def __init__(self, config: SimpleNamespace):
            super().__init__()
            self.config = config
            self.encoder = timm.create_model(
                config.encoder_name,
                pretrained=False,
                in_chans=3,
                features_only=True,
                out_indices=(0, 1, 2, 3),
                drop_path_rate=float(config.encoder_drop_path),
            )
            encoder_channels = list(self.encoder.feature_info.channels())
            reductions = list(self.encoder.feature_info.reduction())
            if encoder_channels != [64, 128, 256, 512]:
                raise ValueError(
                    "Unexpected ConvNeXt-Pico feature channels: "
                    f"{encoder_channels!r}"
                )
            if reductions != [4, 8, 16, 32]:
                raise ValueError(
                    f"Expected encoder reductions [4, 8, 16, 32], got {reductions!r}"
                )

            decoder_channels = tuple(config.decoder_channels)
            if decoder_channels != (192, 96, 48, 32, 24):
                raise ValueError(f"Unexpected decoder widths: {decoder_channels!r}")
            d3, d2, d1, d0, final_channels = decoder_channels
            self.bridge = ResidualRefine(
                encoder_channels[-1],
                int(config.bridge_channels),
                dropout=float(config.decoder_dropout),
            )
            self.decode3 = DecoderBlock(
                int(config.bridge_channels),
                encoder_channels[-2],
                d3,
                config.decoder_dropout,
            )
            self.decode2 = DecoderBlock(
                d3, encoder_channels[-3], d2, config.decoder_dropout
            )
            self.decode1 = DecoderBlock(
                d2, encoder_channels[-4], d1, config.decoder_dropout
            )
            self.decode0 = DecoderBlock(d1, 0, d0, config.decoder_dropout)
            self.decode_final = DecoderBlock(
                d0, 0, final_channels, config.decoder_dropout
            )
            self.mask_head = nn.Conv2d(final_channels, 1, 1)
            self.boundary_head = nn.Sequential(
                ConvGNAct(final_channels, final_channels, 3),
                nn.Conv2d(final_channels, 1, 1),
            )
            self.aux_heads = nn.ModuleList(
                [nn.Conv2d(d2, 1, 1), nn.Conv2d(d1, 1, 1), nn.Conv2d(d0, 1, 1)]
            )

        def forward(self, value):
            input_size = value.shape[-2:]
            f1, f2, f3, f4 = self.encoder(value)
            bridge = self.bridge(f4)
            d3 = self.decode3(bridge, f3)
            d2 = self.decode2(d3, f2)
            d1 = self.decode1(d2, f1)
            d0 = self.decode0(
                d1,
                output_size=(input_size[0] // 2, input_size[1] // 2),
            )
            final = self.decode_final(d0, output_size=input_size)
            return {
                "mask_logits": self.mask_head(final),
                "boundary_logits": self.boundary_head(final),
                "aux_logits": [
                    self.aux_heads[0](d2),
                    self.aux_heads[1](d1),
                    self.aux_heads[2](d0),
                ],
            }

else:

    class MorphoGBMv10:  # pragma: no cover - used only to produce a clear error
        def __init__(self, _config):
            raise _runtime_error()


@dataclass
class InferenceBundle:
    model: Any
    config: SimpleNamespace
    config_dict: dict[str, Any]
    channel_mean: np.ndarray
    channel_std: np.ndarray
    calibration: dict[str, Any]
    checkpoint_path: Path
    checkpoint_sha256: str
    manifest_sha256: str
    format_version: int
    device: Any
    inference_lock: threading.RLock = field(default_factory=threading.RLock, repr=False)


_BUNDLE_CACHE: dict[tuple[str, int, int, str], InferenceBundle] = {}
_BUNDLE_CACHE_LOCK = threading.RLock()


def clear_bundle_cache() -> None:
    """Clear loaded models, primarily for tests and controlled process teardown."""
    with _BUNDLE_CACHE_LOCK:
        _BUNDLE_CACHE.clear()


def _sha256(path: Path, chunk_size: int = 2**20) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(chunk_size), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _torch_load(path: Path):
    try:
        # The shipped artifact contains only tensors and primitive containers, so
        # use PyTorch's restricted unpickler after the exact SHA-256 check.
        return torch.load(path, map_location="cpu", weights_only=True)
    except TypeError:  # PyTorch releases before weights_only was added.
        return torch.load(path, map_location="cpu")


def _config_namespace(config: Mapping[str, Any]) -> SimpleNamespace:
    values = dict(config)
    for key in (
        "mask_positive_values",
        "decoder_channels",
        "threshold_candidates",
        "min_component_candidates",
    ):
        if key in values:
            values[key] = tuple(values[key])
    values["encoder_pretrained"] = False
    values["allow_random_encoder_fallback"] = False
    return SimpleNamespace(**values)


def _validate_tta_calibration(calibration: Mapping[str, Any]) -> None:
    transforms = calibration.get("tta_transforms")
    if not isinstance(transforms, (list, tuple)):
        raise ValueError("Checkpoint calibration does not record D4 transforms")
    parsed = []
    for transform in transforms:
        if not isinstance(transform, Mapping):
            raise ValueError("Checkpoint contains a malformed TTA transform")
        rotation = transform.get("rotation_k", transform.get("rot90_k"))
        flip = transform.get("horizontal_flip_after_rotation")
        if rotation is None or flip is None:
            raise ValueError("Checkpoint contains an incomplete TTA transform")
        parsed.append((int(rotation), bool(flip)))
    if tuple(parsed) != D4_TRANSFORMS:
        raise ValueError(
            "Checkpoint calibration is not the expected eight-view D4 contract"
        )


def _validate_checkpoint_payload(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, Mapping):
        raise ValueError("MorphoGBM checkpoint payload must be a mapping")
    required = {
        "format_version",
        "model_state",
        "config",
        "channel_mean",
        "channel_std",
        "manifest_sha256",
        "calibration",
    }
    missing = sorted(required.difference(payload))
    if missing:
        raise ValueError(f"MorphoGBM checkpoint is missing fields: {missing}")
    if int(payload["format_version"]) != EXPECTED_FORMAT_VERSION:
        raise ValueError(
            f"Unsupported checkpoint format_version={payload['format_version']!r}"
        )
    if str(payload["manifest_sha256"]) != EXPECTED_MANIFEST_SHA256:
        raise ValueError("Checkpoint training-data manifest does not match v10")

    config = dict(payload["config"])
    for key, expected in EXPECTED_CONFIG.items():
        if key not in config:
            raise ValueError(f"Checkpoint config is missing {key!r}")
        actual = config[key]
        if isinstance(expected, tuple):
            matched = tuple(actual) == expected
        elif isinstance(expected, float):
            matched = math.isclose(float(actual), expected, rel_tol=0, abs_tol=1e-9)
        else:
            matched = actual == expected
        if not matched:
            raise ValueError(
                f"Checkpoint config {key!r} is {actual!r}; expected {expected!r}"
            )

    channel_mean = np.asarray(payload["channel_mean"], dtype=np.float32)
    channel_std = np.asarray(payload["channel_std"], dtype=np.float32)
    if channel_mean.shape != (3,) or channel_std.shape != (3,):
        raise ValueError("Checkpoint must contain exactly three channel statistics")
    if not np.isfinite(channel_mean).all() or not np.isfinite(channel_std).all():
        raise ValueError("Checkpoint channel statistics contain NaN or Inf")
    if np.any(channel_std <= 0):
        raise ValueError("Checkpoint channel standard deviations must be positive")
    if not np.allclose(channel_mean, EXPECTED_CHANNEL_MEAN, rtol=0, atol=1e-7):
        raise ValueError("Checkpoint channel mean does not match selected v10")
    if not np.allclose(channel_std, EXPECTED_CHANNEL_STD, rtol=0, atol=1e-7):
        raise ValueError("Checkpoint channel standard deviation does not match v10")

    calibration = dict(payload["calibration"])
    if not math.isclose(
        float(calibration.get("threshold", math.nan)), 0.775, rel_tol=0, abs_tol=1e-9
    ):
        raise ValueError("Checkpoint does not contain the selected v10 threshold")
    if int(calibration.get("minimum_component_size", -1)) != 64:
        raise ValueError("Checkpoint does not contain the selected v10 component rule")
    _validate_tta_calibration(calibration)
    if not isinstance(payload["model_state"], Mapping):
        raise ValueError("Checkpoint model_state must be a state-dict mapping")

    return {
        "config": config,
        "channel_mean": channel_mean,
        "channel_std": channel_std,
        "calibration": calibration,
    }


def _resolve_device(requested: str | Any):
    if not model_runtime_available():
        raise _runtime_error()
    if requested is None or str(requested).lower() == "auto":
        return torch.device("cuda" if torch.cuda.is_available() else "cpu")
    device = torch.device(requested)
    if device.type == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA was requested for MorphoGBM but is not available")
    return device


def load_inference_bundle(
    checkpoint_path: str | Path,
    device: str | Any = "auto",
) -> InferenceBundle:
    """Hash-check, strictly reconstruct, and process-cache the v10 checkpoint."""
    if not model_runtime_available():
        raise _runtime_error()
    path = Path(checkpoint_path).expanduser().resolve()
    if not path.is_file():
        raise FileNotFoundError(f"MorphoGBM checkpoint does not exist: {path}")
    stat = path.stat()
    resolved_device = _resolve_device(device)
    key = (str(path), int(stat.st_mtime_ns), int(stat.st_size), str(resolved_device))
    with _BUNDLE_CACHE_LOCK:
        cached = _BUNDLE_CACHE.get(key)
        if cached is not None:
            return cached

        checkpoint_sha256 = _sha256(path)
        if checkpoint_sha256 != EXPECTED_CHECKPOINT_SHA256:
            raise ValueError(
                "MorphoGBM checkpoint SHA-256 mismatch: "
                f"expected {EXPECTED_CHECKPOINT_SHA256}, got {checkpoint_sha256}"
            )
        payload = _torch_load(path)
        validated = _validate_checkpoint_payload(payload)
        config = _config_namespace(validated["config"])
        model = MorphoGBMv10(config)
        model.load_state_dict(payload["model_state"], strict=True)
        model.to(resolved_device).eval()

        with torch.inference_mode():
            smoke = model(
                torch.zeros(1, 3, 64, 64, device=resolved_device)
            )["mask_logits"]
        if tuple(smoke.shape) != (1, 1, 64, 64):
            raise RuntimeError(
                f"MorphoGBM reconstruction smoke output has shape {tuple(smoke.shape)}"
            )
        del smoke

        bundle = InferenceBundle(
            model=model,
            config=config,
            config_dict=validated["config"],
            channel_mean=validated["channel_mean"],
            channel_std=validated["channel_std"],
            calibration=validated["calibration"],
            checkpoint_path=path,
            checkpoint_sha256=checkpoint_sha256,
            manifest_sha256=str(payload["manifest_sha256"]),
            format_version=int(payload["format_version"]),
            device=resolved_device,
        )
        # Remove stale entries for the same path/device after an intentional replace.
        for old_key in list(_BUNDLE_CACHE):
            if old_key[0] == str(path) and old_key[3] == str(resolved_device):
                _BUNDLE_CACHE.pop(old_key, None)
        _BUNDLE_CACHE[key] = bundle
        return bundle


def _as_raw_plane(raw_plane: Any) -> tuple[np.ndarray, str]:
    original = np.asarray(raw_plane)
    if original.ndim != 2:
        raise ValueError(f"MorphoGBM expects one 2-D plane; got shape {original.shape}")
    if original.size == 0:
        raise ValueError("MorphoGBM input plane is empty")
    if not np.issubdtype(original.dtype, np.number):
        raise ValueError(f"MorphoGBM input dtype is not numeric: {original.dtype}")
    plane = original.astype(np.float32)
    if not np.isfinite(plane).all():
        raise ValueError("MorphoGBM input plane contains NaN or Inf")
    return plane, str(original.dtype)


def _contrast_enhance_with_metadata(
    raw_plane: Any,
    p_low: float = 1.0,
    p_high: float = 99.7,
) -> tuple[np.ndarray, dict[str, Any]]:
    """Apply the supplied IF contrast enhancement exactly, with a constant guard."""
    low_percentile, high_percentile = float(p_low), float(p_high)
    if not 0 <= low_percentile < high_percentile <= 100:
        raise ValueError("Contrast percentiles must satisfy 0 <= p_low < p_high <= 100")
    plane, source_dtype = _as_raw_plane(raw_plane)
    low_value = np.percentile(plane, low_percentile)
    high_value = np.percentile(plane, high_percentile)
    low = float(low_value)
    high = float(high_value)
    constant_guard = not high_value > low_value
    if constant_guard:
        enhanced = np.zeros(plane.shape, dtype=np.uint8)
    else:
        contrast = 255.0 / (high_value - low_value)
        brightness = -low_value * contrast
        # Keep the operation ordering and uint8 truncation of image_enhance.py.
        stretched = plane * contrast + brightness
        enhanced = np.clip(stretched, 0, 255).astype(np.uint8)
    return enhanced, {
        "method": "per-plane-linear-percentile-stretch",
        "p_low": low_percentile,
        "p_high": high_percentile,
        "low_value": low,
        "high_value": high,
        "output_dtype": "uint8",
        "constant_plane_guard_applied": constant_guard,
        "source_dtype": source_dtype,
        "source_min": float(plane.min()),
        "source_max": float(plane.max()),
    }


def apply_contrast_enhancement(
    raw_plane: Any,
    p_low: float = 1.0,
    p_high: float = 99.7,
) -> np.ndarray:
    """Return the exact uint8 CE plane used before v10 normalization."""
    return _contrast_enhance_with_metadata(raw_plane, p_low, p_high)[0]


def make_inference_channels(
    raw01: np.ndarray,
    channel_mean: np.ndarray = EXPECTED_CHANNEL_MEAN,
    channel_std: np.ndarray = EXPECTED_CHANNEL_STD,
) -> np.ndarray:
    """Create and standardize the v10 raw/log1p/sqrt grayscale views."""
    raw = np.clip(np.asarray(raw01, dtype=np.float32), 0.0, 1.0)
    if raw.ndim != 2:
        raise ValueError(f"Expected a 2-D normalized plane, got {raw.shape}")
    channels = np.stack(
        [raw, np.log1p(9.0 * raw) / np.log(10.0), np.sqrt(raw)],
        axis=-1,
    ).astype(np.float32)
    mean = np.asarray(channel_mean, dtype=np.float32)[None, None, :]
    std = np.asarray(channel_std, dtype=np.float32)[None, None, :]
    return ((channels - mean) / np.maximum(std, 1e-4)).astype(np.float32)


def tile_positions(length: int, tile_size: int = CORE_SIZE, stride: int = TILE_STRIDE):
    length, tile_size, stride = int(length), int(tile_size), int(stride)
    if length < 1 or tile_size < 1 or stride < 1 or stride > tile_size:
        raise ValueError("Invalid tile length, size, or stride")
    if length <= tile_size:
        return [0]
    positions = list(range(0, length - tile_size + 1, stride))
    final = length - tile_size
    if positions[-1] != final:
        positions.append(final)
    return positions


def gaussian_blend_window(
    size: int = CORE_SIZE,
    sigma_fraction: float = GAUSSIAN_SIGMA_FRACTION,
    floor: float = GAUSSIAN_WEIGHT_FLOOR,
) -> np.ndarray:
    if int(size) < 1 or float(sigma_fraction) <= 0 or not 0 <= float(floor) <= 1:
        raise ValueError("Invalid Gaussian blend-window settings")
    coordinate = np.arange(int(size), dtype=np.float32) - (float(size) - 1.0) / 2.0
    sigma = max(1.0, float(size) * float(sigma_fraction))
    vector = np.exp(-0.5 * np.square(coordinate / sigma))
    window = np.outer(vector, vector)
    window /= max(float(window.max()), 1e-8)
    return np.maximum(window, float(floor)).astype(np.float32)


def _extract_window(
    array: np.ndarray,
    y0: int,
    x0: int,
    height: int,
    width: int,
    fill_value: float = 0,
) -> np.ndarray:
    array = np.asarray(array)
    y0, x0, height, width = map(int, (y0, x0, height, width))
    y1, x1 = y0 + height, x0 + width
    source_y0, source_x0 = max(0, y0), max(0, x0)
    source_y1, source_x1 = min(array.shape[0], y1), min(array.shape[1], x1)
    if source_y1 <= source_y0 or source_x1 <= source_x0:
        return np.full((height, width), fill_value, dtype=array.dtype)
    piece = np.asarray(array[source_y0:source_y1, source_x0:source_x1])
    padding = (
        (source_y0 - y0, y1 - source_y1),
        (source_x0 - x0, x1 - source_x1),
    )
    if any(value > 0 for pair in padding for value in pair):
        piece = np.pad(piece, padding, mode="constant", constant_values=fill_value)
    if piece.shape != (height, width):
        raise RuntimeError(
            f"Window extraction returned {piece.shape}; expected {(height, width)}"
        )
    return piece


def teacher_halo_window(
    raw01: np.ndarray,
    coverage: np.ndarray,
    y: int,
    x: int,
    core: int = CORE_SIZE,
    halo: int = CONTEXT_HALO,
) -> np.ndarray:
    """Reflect the core at missing borders and overlay observed neighboring pixels."""
    raw = np.asarray(raw01, dtype=np.float32)
    coverage = np.asarray(coverage, dtype=np.uint8)
    core_raw = np.asarray(raw[y : y + core, x : x + core], dtype=np.float32)
    if core_raw.shape != (core, core):
        raise ValueError(f"Teacher core at {(y, x)} has shape {core_raw.shape}")
    fallback = np.pad(core_raw, ((halo, halo), (halo, halo)), mode="reflect")
    if halo <= 0:
        return fallback
    observed_raw = _extract_window(
        raw, y - halo, x - halo, core + 2 * halo, core + 2 * halo, 0
    )
    observed = _extract_window(
        coverage, y - halo, x - halo, core + 2 * halo, core + 2 * halo, 0
    ).astype(bool)
    fallback[observed] = observed_raw[observed]
    return fallback.astype(np.float32)


def _d4_apply(tensor, rotation_k: int, horizontal_flip: bool):
    transformed = torch.rot90(tensor, int(rotation_k), dims=(-2, -1))
    return torch.flip(transformed, dims=(-1,)) if horizontal_flip else transformed


def _d4_inverse(tensor, rotation_k: int, horizontal_flip: bool):
    transformed = torch.flip(tensor, dims=(-1,)) if horizontal_flip else tensor
    return torch.rot90(transformed, -int(rotation_k), dims=(-2, -1))


def _label_components_8(mask: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    binary = np.asarray(mask, dtype=np.uint8)
    if scipy_component_label is not None:
        labels, count = scipy_component_label(
            binary,
            structure=np.ones((3, 3), dtype=np.uint8),
        )
        areas = np.bincount(labels.ravel(), minlength=int(count) + 1)
        return labels.astype(np.int32, copy=False), areas.astype(np.int64, copy=False)

    # This dependency-free fallback is for constrained/test environments.  The
    # inference dependency set installs SciPy for large production planes.
    height, width = binary.shape
    labels = np.zeros((height, width), dtype=np.int32)
    areas = [height * width - int(binary.sum())]
    next_label = 0
    for y in range(height):
        for x in range(width):
            if binary[y, x] == 0 or labels[y, x] != 0:
                continue
            next_label += 1
            labels[y, x] = next_label
            stack = [(y, x)]
            area = 0
            while stack:
                cy, cx = stack.pop()
                area += 1
                for ny in range(max(0, cy - 1), min(height, cy + 2)):
                    for nx in range(max(0, cx - 1), min(width, cx + 2)):
                        if binary[ny, nx] and labels[ny, nx] == 0:
                            labels[ny, nx] = next_label
                            stack.append((ny, nx))
            areas.append(area)
    return labels, np.asarray(areas, dtype=np.int64)


def hysteresis_components(
    probability: np.ndarray,
    low: float = HYSTERESIS_LOW_THRESHOLD,
    high: float = HYSTERESIS_HIGH_THRESHOLD,
    minimum_size: int = HYSTERESIS_MINIMUM_SIZE,
) -> np.ndarray:
    """Apply v13's seeded, eight-connected low/high probability rule."""
    if not 0 <= float(low) < float(high) <= 1:
        raise ValueError("Hysteresis thresholds must satisfy 0 <= low < high <= 1")
    if int(minimum_size) < 0:
        raise ValueError("Hysteresis minimum_size cannot be negative")
    probability = np.asarray(probability, dtype=np.float32)
    if probability.ndim != 2 or not np.isfinite(probability).all():
        raise ValueError("Hysteresis probability must be one finite 2-D array")
    low_mask = np.asarray(probability >= float(low), dtype=np.uint8)
    seed = np.asarray(probability >= float(high), dtype=np.uint8)
    if not seed.any():
        return np.zeros(probability.shape, dtype=np.uint8)
    labels, areas = _label_components_8(low_mask)
    seeded_labels = np.unique(labels[seed > 0])
    seeded_labels = seeded_labels[seeded_labels > 0]
    keep = np.zeros(len(areas), dtype=np.uint8)
    if seeded_labels.size:
        area_ok = areas[seeded_labels] >= int(minimum_size)
        keep[seeded_labels[area_ok]] = 1
    return keep[labels]


def _notify(progress: ProgressCallback | None, fraction: float, message: str) -> None:
    if progress is not None:
        progress(float(np.clip(fraction, 0.0, 1.0)), str(message))


def _predict_whole_plane(
    raw01: np.ndarray,
    bundle: InferenceBundle,
    progress: ProgressCallback | None,
) -> tuple[np.ndarray, np.ndarray, int]:
    original_height, original_width = raw01.shape
    canvas_height = max(CORE_SIZE, original_height)
    canvas_width = max(CORE_SIZE, original_width)
    median = float(np.median(raw01))
    raw_canvas = np.pad(
        raw01,
        ((0, canvas_height - original_height), (0, canvas_width - original_width)),
        mode="constant",
        constant_values=median,
    ).astype(np.float32)
    coverage = np.zeros((canvas_height, canvas_width), dtype=np.uint8)
    coverage[:original_height, :original_width] = 1

    first = np.zeros((canvas_height, canvas_width), dtype=np.float32)
    second = np.zeros((canvas_height, canvas_width), dtype=np.float32)
    weight = np.zeros((canvas_height, canvas_width), dtype=np.float32)
    window = gaussian_blend_window()
    jobs = [
        (y, x)
        for y in tile_positions(canvas_height)
        for x in tile_positions(canvas_width)
    ]
    amp_enabled = bundle.device.type == "cuda" and bool(
        getattr(bundle.config, "amp", True)
    )

    for start in range(0, len(jobs), TILE_BATCH_SIZE):
        selected = jobs[start : start + TILE_BATCH_SIZE]
        halo_windows = [
            teacher_halo_window(raw_canvas, coverage, y, x) for y, x in selected
        ]
        channels = np.stack(
            [
                make_inference_channels(
                    halo_window, bundle.channel_mean, bundle.channel_std
                ).transpose(2, 0, 1)
                for halo_window in halo_windows
            ]
        )
        batch = torch.from_numpy(channels).to(bundle.device)
        views = []
        for rotation_k, flip in D4_TRANSFORMS:
            transformed = _d4_apply(batch, rotation_k, flip)
            with torch.autocast(
                device_type=bundle.device.type,
                dtype=torch.float16,
                enabled=amp_enabled,
            ):
                logits = bundle.model(transformed)["mask_logits"]
            probability = _d4_inverse(
                torch.sigmoid(logits.float()), rotation_k, flip
            )
            probability = probability[
                ..., CONTEXT_HALO:-CONTEXT_HALO, CONTEXT_HALO:-CONTEXT_HALO
            ]
            views.append(probability)
        stacked = torch.stack(views, dim=0)
        means = stacked.mean(dim=0)[:, 0].cpu().numpy()
        moments = stacked.square().mean(dim=0)[:, 0].cpu().numpy()
        del batch, views, stacked

        for index, (y, x) in enumerate(selected):
            region = np.s_[y : y + CORE_SIZE, x : x + CORE_SIZE]
            first[region] += means[index] * window
            second[region] += moments[index] * window
            weight[region] += window
        complete = min(start + len(selected), len(jobs))
        _notify(
            progress,
            0.12 + 0.78 * (complete / max(len(jobs), 1)),
            f"Segmenting tiles ({complete}/{len(jobs)})",
        )

    mean = first / np.maximum(weight, 1e-8)
    variance = np.maximum(second / np.maximum(weight, 1e-8) - mean * mean, 0.0)
    probability = mean[:original_height, :original_width].astype(np.float32)
    disagreement = np.sqrt(
        variance[:original_height, :original_width]
    ).astype(np.float32)
    if not np.isfinite(probability).all() or not np.isfinite(disagreement).all():
        raise RuntimeError("MorphoGBM stitched output contains NaN or Inf")
    if float(probability.min()) < -1e-6 or float(probability.max()) > 1.0 + 1e-6:
        raise RuntimeError("MorphoGBM stitched probability is outside [0,1]")
    return probability, disagreement, len(jobs)


def segment_plane(
    raw_plane: Any,
    checkpoint_path: str | Path,
    device: str | Any = "auto",
    progress: ProgressCallback | None = None,
) -> dict[str, Any]:
    """Segment one raw 2-D plane without writing files.

    ``raw_plane`` should be the selected NHS-ester plane after any requested
    Z projection, but before contrast enhancement.  The return dictionary has
    ``mask`` (uint8 ``{0,1}``), ``probability`` and ``disagreement`` (float32),
    plus JSON-compatible provenance under ``metadata``.

    The progress callback, when supplied, is called as ``callback(fraction,
    message)`` with monotonically increasing fractions in ``[0, 1]``.
    """
    _notify(progress, 0.0, "Loading MorphoGBM model")
    bundle = load_inference_bundle(checkpoint_path, device=device)
    _notify(progress, 0.04, "Applying contrast enhancement")
    enhanced, enhancement_metadata = _contrast_enhance_with_metadata(raw_plane)
    raw01 = enhanced.astype(np.float32) / np.float32(255.0)
    _notify(progress, 0.10, "Preparing halo tiles")

    with bundle.inference_lock, torch.inference_mode():
        probability, disagreement, tile_count = _predict_whole_plane(
            raw01, bundle, progress
        )
    _notify(progress, 0.93, "Applying GBM hysteresis")
    mask = hysteresis_components(probability)
    if mask.shape != raw01.shape or set(np.unique(mask)).difference({0, 1}):
        raise RuntimeError("MorphoGBM produced an invalid binary-mask geometry")

    metadata = {
        "model": {
            "name": MODEL_NAME,
            "architecture": "ConvNeXt-Pico residual U-Net",
            # Keep deployment filesystem layout out of API-visible provenance.
            "checkpoint_filename": bundle.checkpoint_path.name,
            "checkpoint_sha256": bundle.checkpoint_sha256,
            "format_version": bundle.format_version,
            "manifest_sha256": bundle.manifest_sha256,
            # Preserve the embedded v10 calibration verbatim for auditability,
            # even though v13 re-calibrated the deployed whole-image rule.
            "checkpoint_calibration": dict(bundle.calibration),
            "checkpoint_config": dict(bundle.config_dict),
        },
        "preprocessing": {
            **enhancement_metadata,
            "input_value_scale": 255.0,
            "derived_channels": ["raw", "log1p_9x_over_log10", "sqrt"],
            "channel_mean": bundle.channel_mean.tolist(),
            "channel_std": bundle.channel_std.tolist(),
        },
        "inference": {
            "contract": "v13-selected-v10-teacher-whole-image",
            "device": str(bundle.device),
            "core_size": CORE_SIZE,
            "context_halo": CONTEXT_HALO,
            "model_input_size": MODEL_INPUT_SIZE,
            "tile_stride": TILE_STRIDE,
            "tile_count": int(tile_count),
            "tta_transforms": [
                {
                    "rotation_k": int(rotation),
                    "horizontal_flip_after_rotation": bool(flip),
                }
                for rotation, flip in D4_TRANSFORMS
            ],
            "probability_reduction": "sigmoid-D4-mean",
            "overlap_stitching": {
                "method": "Gaussian first/second moments",
                "sigma_fraction": GAUSSIAN_SIGMA_FRACTION,
                "weight_floor": GAUSSIAN_WEIGHT_FLOOR,
            },
            "postprocess": {
                "mode": "hysteresis",
                "low_threshold": HYSTERESIS_LOW_THRESHOLD,
                "high_threshold": HYSTERESIS_HIGH_THRESHOLD,
                "minimum_size": HYSTERESIS_MINIMUM_SIZE,
                "connectivity": 8,
            },
            "disagreement_semantics": (
                "sqrt(E[p^2]-E[p]^2) across D4 views and overlapping tiles; "
                "diagnostic, not calibrated epistemic uncertainty"
            ),
        },
        "output": {
            "shape": [int(raw01.shape[0]), int(raw01.shape[1])],
            "mask_dtype": "uint8",
            "mask_values": [0, 1],
            "probability_dtype": "float32",
            "predicted_positive_pixels": int(mask.sum()),
            "predicted_positive_fraction": float(mask.mean()),
        },
    }
    _notify(progress, 1.0, "Segmentation complete")
    return {
        "mask": mask.astype(np.uint8, copy=False),
        "probability": probability,
        "disagreement": disagreement,
        "metadata": metadata,
    }


__all__ = [
    "CONTEXT_HALO",
    "CORE_SIZE",
    "D4_TRANSFORMS",
    "EXPECTED_CHECKPOINT_SHA256",
    "EXPECTED_MANIFEST_SHA256",
    "HYSTERESIS_HIGH_THRESHOLD",
    "HYSTERESIS_LOW_THRESHOLD",
    "InferenceBundle",
    "MODEL_INPUT_SIZE",
    "MorphoGBMv10",
    "TILE_STRIDE",
    "apply_contrast_enhancement",
    "clear_bundle_cache",
    "gaussian_blend_window",
    "hysteresis_components",
    "load_inference_bundle",
    "make_inference_channels",
    "model_runtime_available",
    "segment_plane",
    "teacher_halo_window",
    "tile_positions",
]
