import numpy as np


def direct_uint8(plane):
    """Prepare an already processed model input without data-dependent contrast changes."""
    arr = np.asarray(plane, dtype=np.float32)
    if arr.size and float(np.nanmax(arr)) <= 1.0:
        arr = arr * 255.0
    return np.clip(arr, 0, 255).astype(np.uint8)


def direct_uint8_stack(stack):
    arr = np.asarray(stack, dtype=np.float32)
    if arr.ndim == 2:
        return direct_uint8(arr)
    return np.stack([direct_uint8(channel) for channel in arr], axis=0)


def normalize_by_max(plane):
    arr = np.asarray(plane, dtype=np.float32)
    max_value = float(np.max(arr)) if arr.size else 0.0
    if max_value <= 0:
        return np.zeros(arr.shape, dtype=np.float32)
    return arr / max_value


def percentile_stretch_uint8(plane, p_low=1.0, p_high=99.7):
    """Match MagnifySeg auto_enhance_*: percentile stretch without max-normalization."""
    arr = np.asarray(plane, dtype=np.float32)
    lo = float(np.percentile(arr, p_low))
    hi = float(np.percentile(arr, p_high))
    if hi <= lo:
        return np.clip(arr, 0, 255).astype(np.uint8)
    stretched = (arr - lo) * (255.0 / (hi - lo))
    return np.clip(stretched, 0, 255).astype(np.uint8)


def preprocess_plane(plane, p_low=1.0, p_high=99.7):
    return percentile_stretch_uint8(plane, p_low, p_high)


def preprocess_stack(stack, p_low=1.0, p_high=99.7):
    arr = np.asarray(stack, dtype=np.float32)
    if arr.ndim == 2:
        return preprocess_plane(arr, p_low, p_high)
    return np.stack([preprocess_plane(channel, p_low, p_high) for channel in arr], axis=0)
