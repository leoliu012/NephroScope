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
    min_area_percentile=0.0,
    max_area_percentile=100.0,
):
    _require_metric_deps()
    from scipy import ndimage as ndi
    from skimage.feature import peak_local_max
    from skimage.measure import regionprops
    from skimage.segmentation import watershed

    full_mask = np.asarray(mask)
    if full_mask.ndim == 3:
        full_mask = full_mask[0]
    full_mask = full_mask.astype(bool)

    cropped, offset = _crop_mask(full_mask, roi)
    m = np.asarray(cropped).astype(bool)
    output_dir = Path(output_dir)
    out_csv = output_dir / "proc_pairs.csv"
    out_json = output_dir / "proc.json"
    labels_path = output_dir / "proc_labels.tif"
    all_labels_path = output_dir / "proc_all_labels.tif"
    contours_path = output_dir / "proc_contours.tif"
    all_contours_path = output_dir / "proc_all_contours.tif"
    included_contours_path = output_dir / "proc_included_contours.tif"
    excluded_contours_path = output_dir / "proc_excluded_contours.tif"
    outer_path = output_dir / "proc_outer_contours.tif"

    if not np.any(m):
        result = {
            "meanDistance": None,
            "processCount": 0,
            "pairCount": 0,
            "displayPairCount": 0,
            "displayExcludedPairCount": 0,
            "pairs": [],
            "displayPairs": [],
            "areaFilter": {
                "totalProcessCount": 0,
                "includedProcessCount": 0,
                "excludedProcessCount": 0,
                "excludedSmallProcessCount": 0,
                "excludedLargeProcessCount": 0,
                "minPercentile": float(min_area_percentile),
                "maxPercentile": float(max_area_percentile),
            },
            "foregroundPixelCount": 0,
            "labeledPixelCount": 0,
            "unlabeledPixelCount": 0,
            "foregroundCoverage": 1.0,
            "csv": out_csv.name,
        }
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

    markers = _ensure_marker_per_component(m, dist, markers)

    grad = ndi.gaussian_gradient_magnitude(dist.astype(np.float32), sigma=float(ws_sigma))
    labels = watershed(grad, markers=markers, mask=m).astype(np.uint16)
    labels = _fill_unlabeled_foreground(labels, m)

    foreground_pixels = int(np.count_nonzero(m))
    labeled_pixels = int(np.count_nonzero(labels))
    unlabeled_pixels = int(np.count_nonzero(m & (labels == 0)))
    foreground_coverage = float(labeled_pixels) / float(foreground_pixels) if foreground_pixels else 1.0
    if unlabeled_pixels != 0 or foreground_coverage < 1.0:
        raise RuntimeError("Process NND watershed did not label every ACTN4 foreground pixel")

    all_labels = labels.copy()
    filtered = filter_process_labels_by_area(
        all_labels,
        min_percentile=min_area_percentile,
        max_percentile=max_area_percentile,
    )
    included_labels = filtered["includedLabels"]
    included_mask = np.isin(all_labels, list(included_labels))
    excluded_mask = (all_labels > 0) & ~included_mask
    included_labels_image = np.where(included_mask, all_labels, 0).astype(np.uint16)
    excluded_labels_image = np.where(excluded_mask, all_labels, 0).astype(np.uint16)

    local_contours = labels_to_contours(included_labels_image)
    local_all_contours = labels_to_contours(all_labels)
    local_included_contours = labels_to_contours(included_labels_image)
    local_excluded_contours = labels_to_contours(excluded_labels_image)
    local_outer_contours = labels_to_contours((included_labels_image > 0).astype(np.uint16))
    full_labels = _embed_in_full_frame(included_labels_image, full_mask.shape, offset)
    full_all_labels = _embed_in_full_frame(all_labels, full_mask.shape, offset)
    full_contours = _embed_in_full_frame(local_contours, full_mask.shape, offset)
    full_all_contours = _embed_in_full_frame(local_all_contours, full_mask.shape, offset)
    full_included_contours = _embed_in_full_frame(local_included_contours, full_mask.shape, offset)
    full_excluded_contours = _embed_in_full_frame(local_excluded_contours, full_mask.shape, offset)
    full_outer_contours = _embed_in_full_frame(local_outer_contours, full_mask.shape, offset)

    tifffile.imwrite(labels_path, full_labels, dtype=np.uint16)
    tifffile.imwrite(all_labels_path, full_all_labels, dtype=np.uint16)
    tifffile.imwrite(contours_path, full_contours, dtype=np.uint8)
    tifffile.imwrite(all_contours_path, full_all_contours, dtype=np.uint8)
    tifffile.imwrite(included_contours_path, full_included_contours, dtype=np.uint8)
    tifffile.imwrite(excluded_contours_path, full_excluded_contours, dtype=np.uint8)
    tifffile.imwrite(outer_path, full_outer_contours, dtype=np.uint8)

    processes = [
        {
            "label": int(prop.label),
            "x": float(prop.centroid[1]),
            "y": float(prop.centroid[0]),
            "areaPx": float(prop.area),
            "area": float(prop.area) * float(pixel_size) ** 2,
        }
        for prop in filtered["includedProps"]
    ]
    pairs = []
    display_pairs = []
    dists = []
    excluded_from_display = 0
    for source_index, source in enumerate(processes):
        best_d = None
        best_target = None
        best_target_index = None
        for target_index, target in enumerate(processes):
            if source_index == target_index:
                continue
            d = float(math.hypot(target["x"] - source["x"], target["y"] - source["y"]))
            if best_d is None or d < best_d:
                best_d = d
                best_target = target
                best_target_index = target_index
        if best_target is None:
            continue
        distance = best_d * float(pixel_size)
        pair = {
            "sourceProcess": source_index,
            "targetProcess": best_target_index,
            "sourceLabel": source["label"],
            "targetLabel": best_target["label"],
            "x0": float(source["x"] + offset[0]),
            "y0": float(source["y"] + offset[1]),
            "x1": float(best_target["x"] + offset[0]),
            "y1": float(best_target["y"] + offset[1]),
            "distance": distance,
            "distancePx": best_d,
            "withinDisplayCap": best_d <= float(max_pair_px),
        }
        pairs.append(pair)
        dists.append(distance)
        if pair["withinDisplayCap"]:
            display_pairs.append(pair)
        else:
            excluded_from_display += 1

    mean_val = float(np.mean(dists)) if dists else None
    _write_csv(out_csv, (
        (
            p["sourceProcess"],
            p["targetProcess"],
            p["x0"],
            p["y0"],
            p["x1"],
            p["y1"],
            f"{p['distance']:.6f}",
            p["withinDisplayCap"],
        )
        for p in pairs
    ))
    result = {
        "meanDistance": mean_val,
        "processCount": len(processes),
        "nndIncludedProcessCount": len(dists),
        "pairCount": len(pairs),
        "displayPairCount": len(display_pairs),
        "displayExcludedPairCount": excluded_from_display,
        "pairs": pairs,
        "displayPairs": display_pairs,
        "processes": [
            {
                "label": process["label"],
                "x": float(process["x"] + offset[0]),
                "y": float(process["y"] + offset[1]),
                "areaPx": process["areaPx"],
                "area": process["area"],
            }
            for process in processes
        ],
        "areaFilter": filtered["summary"],
        "foregroundPixelCount": foreground_pixels,
        "labeledPixelCount": labeled_pixels,
        "unlabeledPixelCount": unlabeled_pixels,
        "foregroundCoverage": foreground_coverage,
        "csv": out_csv.name,
        "labels": labels_path.name,
        "allLabels": all_labels_path.name,
        "contours": contours_path.name,
        "allContours": all_contours_path.name,
        "includedContours": included_contours_path.name,
        "excludedContours": excluded_contours_path.name,
        "outerContours": outer_path.name,
    }
    _write_json(out_json, result)
    return result


def _ensure_marker_per_component(mask, dist, markers):
    from scipy import ndimage as ndi

    components, component_count = ndi.label(mask)
    next_marker = int(markers.max()) + 1

    for component_id in range(1, component_count + 1):
        component_mask = components == component_id
        if np.any(markers[component_mask] > 0):
            continue

        component_dist = np.where(component_mask, dist, -1.0)
        row, col = np.unravel_index(np.argmax(component_dist), component_dist.shape)
        markers[row, col] = next_marker
        next_marker += 1

    return markers


def _fill_unlabeled_foreground(labels, mask):
    from scipy import ndimage as ndi

    missing = mask & (labels == 0)
    if not np.any(missing):
        return labels

    residual, residual_count = ndi.label(missing)
    next_label = int(labels.max()) + 1

    for residual_id in range(1, residual_count + 1):
        labels[residual == residual_id] = next_label
        next_label += 1

    return labels


def filter_process_labels_by_area(labels, min_percentile=0.0, max_percentile=100.0):
    from skimage.measure import regionprops

    min_percentile = float(min_percentile)
    max_percentile = float(max_percentile)
    if min_percentile < 0 or max_percentile > 100:
        raise ValueError("Process area percentiles must remain between 0 and 100")
    if min_percentile >= max_percentile:
        raise ValueError("Minimum area percentile must be lower than maximum area percentile")

    props = list(regionprops(labels))
    if not props:
        return {
            "includedLabels": set(),
            "excludedSmallLabels": set(),
            "excludedLargeLabels": set(),
            "includedProps": [],
            "excludedProps": [],
            "summary": {
                "totalProcessCount": 0,
                "includedProcessCount": 0,
                "excludedProcessCount": 0,
                "excludedSmallProcessCount": 0,
                "excludedLargeProcessCount": 0,
                "minPercentile": min_percentile,
                "maxPercentile": max_percentile,
            },
        }

    ordered = sorted(props, key=lambda prop: (float(prop.area), int(prop.label)))
    count = len(ordered)
    smallest_count = int(math.floor(count * min_percentile / 100.0))
    largest_count = int(math.floor(count * (100.0 - max_percentile) / 100.0))
    if smallest_count + largest_count >= count:
        raise ValueError("Process area filter excludes every detected process")

    small_labels = {int(prop.label) for prop in ordered[:smallest_count]}
    large_labels = {int(prop.label) for prop in ordered[count - largest_count:]} if largest_count else set()
    excluded_labels = small_labels | large_labels
    included_props = [prop for prop in props if int(prop.label) not in excluded_labels]
    excluded_props = [prop for prop in props if int(prop.label) in excluded_labels]
    included_labels = {int(prop.label) for prop in included_props}

    return {
        "includedLabels": included_labels,
        "excludedSmallLabels": small_labels,
        "excludedLargeLabels": large_labels,
        "includedProps": included_props,
        "excludedProps": excluded_props,
        "summary": {
            "totalProcessCount": count,
            "includedProcessCount": len(included_props),
            "excludedProcessCount": len(excluded_props),
            "excludedSmallProcessCount": len(small_labels),
            "excludedLargeProcessCount": len(large_labels),
            "minPercentile": min_percentile,
            "maxPercentile": max_percentile,
        },
    }


def preview_process_area_filter(labels, pixel_size, min_percentile=0.0, max_percentile=100.0, max_pair_px=560.0):
    label_image = np.asarray(labels).astype(np.uint16)
    filtered = filter_process_labels_by_area(
        label_image,
        min_percentile=min_percentile,
        max_percentile=max_percentile,
    )
    included_labels = filtered["includedLabels"]
    included_mask = np.isin(label_image, list(included_labels))
    excluded_mask = (label_image > 0) & ~included_mask

    processes = [
        {
            "label": int(prop.label),
            "x": float(prop.centroid[1]),
            "y": float(prop.centroid[0]),
            "areaPx": float(prop.area),
            "area": float(prop.area) * float(pixel_size) ** 2,
        }
        for prop in filtered["includedProps"]
    ]
    pairs = []
    display_pairs = []
    dists = []
    excluded_from_display = 0
    for source_index, source in enumerate(processes):
        best_d = None
        best_target = None
        best_target_index = None
        for target_index, target in enumerate(processes):
            if source_index == target_index:
                continue
            d = float(math.hypot(target["x"] - source["x"], target["y"] - source["y"]))
            if best_d is None or d < best_d:
                best_d = d
                best_target = target
                best_target_index = target_index
        if best_target is None:
            continue
        distance = best_d * float(pixel_size)
        pair = {
            "sourceProcess": source_index,
            "targetProcess": best_target_index,
            "sourceLabel": source["label"],
            "targetLabel": best_target["label"],
            "x0": source["x"],
            "y0": source["y"],
            "x1": best_target["x"],
            "y1": best_target["y"],
            "distance": distance,
            "distancePx": best_d,
            "withinDisplayCap": best_d <= float(max_pair_px),
        }
        pairs.append(pair)
        dists.append(distance)
        if pair["withinDisplayCap"]:
            display_pairs.append(pair)
        else:
            excluded_from_display += 1

    return {
        "meanDistance": float(np.mean(dists)) if dists else None,
        "processCount": len(processes),
        "pairCount": len(pairs),
        "displayPairCount": len(display_pairs),
        "displayExcludedPairCount": excluded_from_display,
        "pairs": pairs,
        "displayPairs": display_pairs,
        "includedMask": included_mask,
        "excludedMask": excluded_mask,
        "areaFilter": filtered["summary"],
    }


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


def _embed_in_full_frame(cropped, full_shape, offset):
    source = np.asarray(cropped)
    if source.ndim != 2:
        raise ValueError("Expected a 2D metric artifact")

    full_height, full_width = full_shape
    x, y = offset
    height, width = source.shape

    canvas = np.zeros((full_height, full_width), dtype=source.dtype)
    canvas[y:y + height, x:x + width] = source
    return canvas


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
