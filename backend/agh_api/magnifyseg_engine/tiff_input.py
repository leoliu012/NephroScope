import numpy as np

from ..tiff_service import load_raw_plane


def load_model_input(image_path, model_name, request_payload):
    channels = request_payload["channels"]
    z_index = request_payload["zIndex"]

    if model_name == "ACTN4":
        return load_raw_plane(image_path, channels["actn4"], z_index)
    if model_name == "NHS_SINGLE_CHANNEL":
        return load_raw_plane(image_path, channels["nhs"], z_index)
    if model_name == "NHS_COMBINED_ACTN4":
        nhs = load_raw_plane(image_path, channels["nhs"], z_index)
        actn4 = load_raw_plane(image_path, channels["actn4"], z_index)
        return np.stack((nhs, actn4), axis=0)
    raise ValueError(f"Unknown model: {model_name}")
