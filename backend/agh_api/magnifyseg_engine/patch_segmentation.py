import math

from PIL import Image
import numpy as np
import tifffile

def compute_avg_thickness(mask, px_size, label=1):
    from skimage.morphology import medial_axis

    skel, dist = medial_axis(mask == label, return_distance=True)
    diam = 2 * dist[skel]
    for i, each in enumerate(diam):
        diam[i] = diam[i]*px_size
    if diam.size == 0:
        return 0.0
    return skel, diam, diam.mean()

def run_patches(path, model, P_HEIGHT, P_WIDTH, N_CLASSES, MODEL_WIDTH, MODEL_HEIGHT):
    arr_large = tifffile.imread(path)
    if arr_large.ndim == 3:
        arr_large = np.moveaxis(arr_large, 0, -1)
        H, W, _ = arr_large.shape
    else:
        H, W= arr_large.shape

        # 50% overlap on patches
    step_h, step_w = P_HEIGHT // 2, P_WIDTH // 2

    if H < P_HEIGHT or W < P_WIDTH:
        patch_np = _pad_to_at_least(arr_large, P_HEIGHT, P_WIDTH)[:P_HEIGHT, :P_WIDTH]
        patch_np = _resize_patch(patch_np, MODEL_WIDTH, MODEL_HEIGHT)
        pred_whole = model.predict(_to_model_batch(patch_np))[0]
        if pred_whole.shape[:2] != (P_HEIGHT, P_WIDTH):
            pred_whole = _resize_prediction(pred_whole, P_WIDTH, P_HEIGHT)
        return np.argmax(pred_whole, axis=-1).astype(np.uint8)[:H, :W]

    n_h = math.ceil((H - P_HEIGHT) / step_h) + 1
    n_w = math.ceil((W - P_WIDTH) / step_w) + 1

    covered_h = (n_h - 1) * step_h + P_HEIGHT
    covered_w = (n_w - 1) * step_w + P_WIDTH

    pad_h = covered_h - H
    pad_w = covered_w - W

    pad_width = ((0, pad_h), (0, pad_w), (0, 0)) if arr_large.ndim == 3 else ((0, pad_h), (0, pad_w))
    arr_padded = np.pad(arr_large, pad_width, mode='reflect')


    probs_acc = np.zeros((H, W, N_CLASSES), dtype=np.float32)
    counts  = np.zeros((H, W), dtype=np.float32)

    for i in range(n_h):
        for j in range(n_w):
            y0 = i * step_h
            x0 = j * step_w

            patch_np = arr_padded[y0:y0+P_HEIGHT, x0:x0+P_WIDTH]
            # resize patch to model size
            patch_np = _resize_patch(patch_np, MODEL_WIDTH, MODEL_HEIGHT)

            # arr = np.array(patch_im, dtype="float32")[None, ..., None]
            # arr = normalize(arr, axis=1)
            arr = _to_model_batch(patch_np)

            pred = model.predict(arr)[0]  #(MODEL_HEIGHT, MODEL_WIDTH, N_CLASSES)

            # upsample prediction
            up_channels = []
            for c in range(N_CLASSES):
                band = Image.fromarray(pred[..., c])
                band_up = band.resize((P_WIDTH, P_HEIGHT), Image.BILINEAR)
                up_channels.append(np.array(band_up, dtype=np.float32))
            pred_up = np.stack(up_channels, axis=-1)  #(P_HEIGHT, P_WIDTH, N_CLASSES)

            # accumulate
            y1 = min(y0 + P_HEIGHT, H)
            x1 = min(x0 + P_WIDTH, W)

            dy = y1 - y0
            dx = x1 - x0
            probs_acc[y0:y1, x0:x1] += pred_up[:dy, :dx, :]
            counts[y0:y1, x0:x1] += 1.0

    counts_exp = counts[..., None]
    counts_exp[counts_exp == 0] = 1.0

    avg_probs = probs_acc / counts_exp
    recon = np.argmax(avg_probs, axis=-1).astype(np.uint8)
    return recon


def _resize_patch(patch_np, width, height):
    if patch_np.ndim == 2:
        return np.array(
            Image.fromarray(patch_np.astype(np.uint8)).resize((width, height), Image.BILINEAR),
            dtype=np.uint8,
        )
    bands = [
        np.array(
            Image.fromarray(patch_np[..., c].astype(np.uint8)).resize((width, height), Image.BILINEAR),
            dtype=np.uint8,
        )
        for c in range(patch_np.shape[-1])
    ]
    return np.stack(bands, axis=-1)


def _resize_prediction(pred, width, height):
    channels = [
        np.array(
            Image.fromarray(pred[..., c]).resize((width, height), Image.BILINEAR),
            dtype=np.float32,
        )
        for c in range(pred.shape[-1])
    ]
    return np.stack(channels, axis=-1)


def _pad_to_at_least(arr, height, width):
    pad_h = max(0, height - arr.shape[0])
    pad_w = max(0, width - arr.shape[1])
    if pad_h == 0 and pad_w == 0:
        return arr
    pad_width = ((0, pad_h), (0, pad_w), (0, 0)) if arr.ndim == 3 else ((0, pad_h), (0, pad_w))
    return np.pad(arr, pad_width, mode="edge")


def _to_model_batch(arr):
    arr = np.asarray(arr, dtype=np.float32)
    if arr.ndim == 2:
        arr = arr[..., None]
    return arr[None, ...] / 255.0
