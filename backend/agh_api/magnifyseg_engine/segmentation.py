from pathlib import Path

import numpy as np
import tifffile

from .model_registry import MODEL_REGISTRY, weights_path
from .preprocess import direct_uint8_stack, preprocess_stack
from .tiff_input import load_model_input


PATCH_SIZE = 576


def run_segmentation(*, image_path: Path, workspace: Path, model_root: Path, model_name: str, request_payload: dict):
    if model_name not in MODEL_REGISTRY:
        raise ValueError(f"Unknown MagnifySeg model: {model_name}")

    workspace = Path(workspace)
    workspace.mkdir(parents=True, exist_ok=True)
    weights = weights_path(model_root, model_name)
    _assert_weights_ready(weights)

    model_info = MODEL_REGISTRY[model_name]
    plane = load_model_input(image_path, model_name, request_payload)
    model_input = _prepare_model_input(plane, request_payload.get("preprocessingMode", "percentile-stretch"))
    model_input_path = workspace / f"input_{model_name}.tif"
    tifffile.imwrite(model_input_path, model_input, photometric="minisblack")

    try:
        from .model_archi import multi_unet_model_trans
        from .patch_segmentation import run_patches
    except ImportError as exc:
        raise RuntimeError(
            "MagnifySeg segmentation requires TensorFlow/Keras and inference dependencies. "
            "Install backend/requirements-inference.txt in the inference environment."
        ) from exc

    model = multi_unet_model_trans(
        n_classes=model_info["classes"],
        IMG_HEIGHT=PATCH_SIZE,
        IMG_WIDTH=PATCH_SIZE,
        IMG_CHANNELS=model_info["channels"],
    )
    model.load_weights(str(weights))

    segmentation = run_patches(
        str(model_input_path),
        model,
        PATCH_SIZE,
        PATCH_SIZE,
        model_info["classes"],
        PATCH_SIZE,
        PATCH_SIZE,
    )
    segmentation = _postprocess_segmentation_labels(model_name, segmentation)
    output_path = workspace / model_info["segmentationName"]
    tifffile.imwrite(output_path, segmentation.astype(np.uint8))
    return output_path


def _assert_weights_ready(weights: Path):
    if not weights.is_file():
        raise RuntimeError(f"Missing MagnifySeg weights: {weights}")
    if weights.stat().st_size < 1024:
        head = weights.read_text(encoding="utf-8", errors="ignore")[:128]
        if "git-lfs.github.com/spec" in head:
            raise RuntimeError(
                f"MagnifySeg weights at {weights} are Git LFS pointer files. "
                "Copy the real .hdf5 files into AGH_MODEL_ROOT."
            )


def _prepare_model_input(plane, preprocessing_mode):
    if preprocessing_mode == "direct-uint8":
        return direct_uint8_stack(plane)
    if preprocessing_mode in {"percentile-stretch", "magnifyseg-enhanced"}:
        return preprocess_stack(plane)
    raise ValueError(f"Unknown preprocessing mode: {preprocessing_mode}")


def _postprocess_segmentation_labels(model_name, segmentation):
    labels = np.asarray(segmentation)
    if model_name in {"NHS_SINGLE_CHANNEL", "NHS_COMBINED_ACTN4"}:
        return np.where(labels == 1, 1, 0).astype(np.uint8)
    return labels.astype(np.uint8)
