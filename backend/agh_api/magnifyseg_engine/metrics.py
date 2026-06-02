import csv
import math
from pathlib import Path

import numpy as np
import tifffile


def compute_gbm_thickness(mask, pixel_size, output_dir: Path, roi=None):
    _require_metric_deps()
    from skimage.morphology import medial_axis

    cropped, offset = _crop_mask(mask, roi)
    m = np.asarray(cropped).astype(bool)
    output_dir = Path(output_dir)
    out_csv = output_dir / "thickness_points.csv"
    out_json = output_dir / "thickness.json"

    if not np.any(m):
        result = {"meanThickness": None, "unit": None, "points": [], "csv": out_csv.name}
        _write_csv(out_csv, [])
        _write_json(out_json, result)
        return result

    skel, dist = medial_axis(m, return_distance=True)
    diam = 2.0 * dist[skel] * float(pixel_size)
    ys, xs = np.nonzero(skel)
    points = [
        {"x": int(x + offset[0]), "y": int(y + offset[1]), "value": float(d)}
        for x, y, d in zip(xs, ys, diam)
    ]
    mean_val = float(np.mean(diam)) if diam.size else None
    _write_csv(out_csv, ((p["x"], p["y"], f"{p['value']:.6f}") for p in points))
    result = {"meanThickness": mean_val, "points": points, "csv": out_csv.name}
    _write_json(out_json, result)
    return result


def compute_process_nnd(
    mask,
    pixel_size,
    output_dir: Path,
    roi=None,
    max_pair_px=560.0,
    ws_min_dist=150.0,
    ws_thresh_rel=0.26,
    ws_sigma=0.0,
):
    _require_metric_deps()
    from scipy import ndimage as ndi
    from skimage.feature import peak_local_max
    from skimage.measure import label as sklabel, regionprops
    from skimage.segmentation import watershed

    cropped, offset = _crop_mask(mask, roi)
    m = np.asarray(cropped).astype(bool)
    output_dir = Path(output_dir)
    out_csv = output_dir / "proc_pairs.csv"
    out_json = output_dir / "proc.json"
    labels_path = output_dir / "proc_labels.tif"
    contours_path = output_dir / "proc_contours.tif"
    outer_path = output_dir / "proc_outer_contours.tif"

    if not np.any(m):
        result = {"meanDistance": None, "pairs": [], "csv": out_csv.name}
        _write_csv(out_csv, [])
        _write_json(out_json, result)
        return result

    dist = ndi.distance_transform_edt(m)
    peaks = peak_local_max(
        dist,
        labels=m,
        footprint=np.ones((3, 3)),
        min_distance=max(1, int(round(ws_min_dist))),
        threshold_rel=float(ws_thresh_rel),
        exclude_border=False,
    )
    markers = np.zeros_like(dist, dtype=np.int32)
    for i, (row, col) in enumerate(peaks, start=1):
        markers[row, col] = i

    grad = ndi.gaussian_gradient_magnitude(dist.astype(np.float32), sigma=float(ws_sigma))
    labels = watershed(grad, markers=markers, mask=m).astype(np.uint16)
    if labels.max() == 0:
        labels = sklabel(m, connectivity=2).astype(np.uint16)

    tifffile.imwrite(labels_path, labels, dtype=np.uint16)
    tifffile.imwrite(contours_path, labels_to_contours(labels), dtype=np.uint8)
    tifffile.imwrite(outer_path, labels_to_contours(m.astype(np.uint16)), dtype=np.uint8)

    centroids = [(p.centroid[1], p.centroid[0]) for p in regionprops(labels)]
    pairs = []
    dists = []
    for i, (x0, y0) in enumerate(centroids):
        best_d = None
        best_j = None
        for j, (x1, y1) in enumerate(centroids):
            if i == j:
                continue
            d = float(math.hypot(x1 - x0, y1 - y0))
            if d < float(max_pair_px) and (best_d is None or d < best_d):
                best_d = d
                best_j = j
        if best_j is None:
            continue
        x1, y1 = centroids[best_j]
        distance = best_d * float(pixel_size)
        pairs.append({
            "x0": float(x0 + offset[0]),
            "y0": float(y0 + offset[1]),
            "x1": float(x1 + offset[0]),
            "y1": float(y1 + offset[1]),
            "distance": distance,
        })
        dists.append(distance)

    mean_val = float(np.mean(dists)) if dists else None
    _write_csv(out_csv, ((p["x0"], p["y0"], p["x1"], p["y1"], f"{p['distance']:.6f}") for p in pairs))
    result = {
        "meanDistance": mean_val,
        "pairs": pairs,
        "csv": out_csv.name,
        "labels": labels_path.name,
        "contours": contours_path.name,
        "outerContours": outer_path.name,
    }
    _write_json(out_json, result)
    return result


def labels_to_contours(labels_u16):
    lab = labels_u16.astype(np.int32)
    h, w = lab.shape
    edges = np.zeros((h, w), np.uint8)
    edges[1:, :] |= ((lab[1:, :] != 0) & (lab[1:, :] != lab[:-1, :])).astype(np.uint8)
    edges[:-1, :] |= ((lab[:-1, :] != 0) & (lab[:-1, :] != lab[1:, :])).astype(np.uint8)
    edges[:, 1:] |= ((lab[:, 1:] != 0) & (lab[:, 1:] != lab[:, :-1])).astype(np.uint8)
    edges[:, :-1] |= ((lab[:, :-1] != 0) & (lab[:, :-1] != lab[:, 1:])).astype(np.uint8)
    return (edges * 255).astype(np.uint8)


def _crop_mask(mask, roi):
    arr = np.asarray(mask)
    if arr.ndim == 3:
        arr = arr[0]
    if roi is None:
        return arr, (0, 0)
    x = max(0, int(round(roi.get("x", 0))))
    y = max(0, int(round(roi.get("y", 0))))
    width = max(0, int(round(roi.get("width", 0))))
    height = max(0, int(round(roi.get("height", 0))))
    return arr[y:y + height, x:x + width], (x, y)


def _require_metric_deps():
    try:
        import scipy  # noqa: F401
        import skimage  # noqa: F401
    except ImportError as exc:
        raise RuntimeError(
            "MagnifySeg metrics require scipy and scikit-image. "
            "Install backend/requirements-inference.txt in the inference environment."
        ) from exc


def _write_csv(path, rows):
    with Path(path).open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        for row in rows:
            writer.writerow(row)


def _write_json(path, payload):
    import json

    with Path(path).open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.write("\n")
