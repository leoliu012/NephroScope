from pathlib import Path


MODEL_REGISTRY = {
    "ACTN4": {
        "weights": "ACTN4.hdf5",
        "channels": 1,
        "classes": 2,
        "segmentationName": "seg_ACTN4.tif",
    },
    "NHS_SINGLE_CHANNEL": {
        "weights": "NHS_ester_single.hdf5",
        "channels": 1,
        "classes": 3,
        "segmentationName": "seg_NHS_SINGLE_CHANNEL.tif",
    },
    "NHS_COMBINED_ACTN4": {
        "weights": "NHS_ester_com.hdf5",
        "channels": 2,
        "classes": 3,
        "segmentationName": "seg_NHS_COMBINED_ACTN4.tif",
    },
}


def model_names_for_request(models, nhs_mode):
    names = []
    if models.get("actn4"):
        names.append("ACTN4")
    if models.get("nhs"):
        names.append("NHS_SINGLE_CHANNEL" if nhs_mode == "single-channel" else "NHS_COMBINED_ACTN4")
    return names


def weights_path(model_root: Path, model_name: str) -> Path:
    return Path(model_root) / MODEL_REGISTRY[model_name]["weights"]
