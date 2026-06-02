from pathlib import Path

import numpy as np
import tifffile
from PIL import Image


OVERLAY_ALPHA = 112


def write_segmentation_overlays(segmentation_paths, output_dir: Path, hide_nhs_nuclei=False):
    output_dir = Path(output_dir)
    artifacts = []
    for model_name, seg_path in segmentation_paths.items():
        labels = tifffile.imread(seg_path)
        if labels.ndim == 3:
            labels = labels[0]
        labels = labels.astype(np.uint8, copy=False)

        if model_name == "ACTN4":
            artifacts.append(_write_label_overlay(labels > 0, output_dir / "overlay_ACTN4.png", (0, 255, 0)))
        elif model_name == "DAPI":
            artifacts.append(_write_label_overlay(labels > 0, output_dir / "overlay_DAPI.png", (0, 80, 255)))
        elif model_name in {"NHS_SINGLE_CHANNEL", "NHS_COMBINED_ACTN4"}:
            artifacts.append(_write_label_overlay(labels == 1, output_dir / "overlay_NHS_GBM.png", (255, 0, 255)))
            if not hide_nhs_nuclei:
                artifacts.append(_write_label_overlay(labels == 2, output_dir / "overlay_NHS_NUCLEI.png", (255, 0, 0)))
    return [artifact for artifact in artifacts if artifact is not None]


def write_binary_overlay(mask, output_path: Path, color, alpha=OVERLAY_ALPHA):
    return _write_label_overlay(np.asarray(mask).astype(bool), output_path, color, alpha)


def _write_label_overlay(mask, output_path: Path, color, alpha=OVERLAY_ALPHA):
    mask = np.asarray(mask).astype(bool)
    rgba = np.zeros((mask.shape[0], mask.shape[1], 4), dtype=np.uint8)
    rgba[mask, 0] = color[0]
    rgba[mask, 1] = color[1]
    rgba[mask, 2] = color[2]
    rgba[mask, 3] = alpha
    Image.fromarray(rgba, mode="RGBA").save(output_path, format="PNG")
    return output_path.name
