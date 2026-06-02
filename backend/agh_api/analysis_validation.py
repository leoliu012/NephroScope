from .errors import BadRequest
from .magnifyseg_engine.model_registry import model_names_for_request


STAIN_KEYS = ("actn4", "dapi", "nhs")
PREPROCESSING_MODES = {"percentile-stretch", "direct-uint8", "magnifyseg-enhanced"}


def validate_analysis_request(payload, metadata):
    if not isinstance(payload, dict):
        raise BadRequest("JSON body is required")

    z_index = _int_value(payload.get("zIndex", 0), "zIndex")
    if z_index < 0 or z_index >= int(metadata.get("numZSlices", 1)):
        raise BadRequest("Z-slice index out of range")

    channels = payload.get("channels") or {}
    models = payload.get("models") or {}
    if not isinstance(channels, dict) or not isinstance(models, dict):
        raise BadRequest("Invalid analysis request")

    normalized_channels = {}
    num_channels = int(metadata.get("numChannels", 0))
    for stain in STAIN_KEYS:
        value = channels.get(stain)
        if value is None or value == "":
            normalized_channels[stain] = None
            continue
        index = _int_value(value, f"{stain} channel")
        if index < 0 or index >= num_channels:
            raise BadRequest(f"{stain} channel is out of range")
        normalized_channels[stain] = index

    used = [value for value in normalized_channels.values() if value is not None]
    if len(set(used)) != len(used):
        raise BadRequest("Duplicate channel assignment detected")

    normalized_models = {stain: bool(models.get(stain, False)) for stain in STAIN_KEYS}
    if not any(normalized_models.values()):
        raise BadRequest("Select at least one MagnifySeg model")

    nhs_mode = payload.get("nhsMode") or "combined-actn4"
    if nhs_mode not in {"single-channel", "combined-actn4"}:
        raise BadRequest("Invalid NHS model mode")

    if normalized_models["actn4"] and normalized_channels["actn4"] is None:
        raise BadRequest("ACTN4 model requires an ACTN4 channel")
    if normalized_models["dapi"] and normalized_channels["dapi"] is None:
        raise BadRequest("DAPI model requires a DAPI channel")
    if normalized_models["nhs"] and normalized_channels["nhs"] is None:
        raise BadRequest("NHS model requires an NHS Ester channel")
    if normalized_models["nhs"] and nhs_mode == "combined-actn4" and normalized_channels["actn4"] is None:
        raise BadRequest("Combined NHS model requires an ACTN4 channel")

    preprocessing_mode = payload.get("preprocessingMode") or "percentile-stretch"
    if preprocessing_mode not in PREPROCESSING_MODES:
        raise BadRequest("Invalid preprocessing mode")
    if preprocessing_mode == "magnifyseg-enhanced":
        preprocessing_mode = "percentile-stretch"

    calibration = _normalize_calibration(payload.get("calibration") or {}, metadata)
    normalized = {
        "zIndex": z_index,
        "channels": normalized_channels,
        "models": normalized_models,
        "nhsMode": nhs_mode,
        "preprocessingMode": preprocessing_mode,
        "calibration": calibration,
        "modelNames": model_names_for_request(normalized_models, nhs_mode),
    }
    return normalized


def _normalize_calibration(payload, metadata):
    if not isinstance(payload, dict):
        raise BadRequest("Invalid calibration")
    pixel_size = payload.get("pixelSize", metadata.get("pixelSize"))
    if pixel_size in ("", None):
        pixel_size = None
    else:
        pixel_size = float(pixel_size)
        if pixel_size <= 0:
            raise BadRequest("Pixel size must be positive")

    pixel_unit = str(payload.get("pixelUnit") or metadata.get("pixelUnit") or "um").strip() or "um"
    expanded = bool(payload.get("expanded", True))
    expansion_factor = float(payload.get("expansionFactor", 7.0))
    if expansion_factor <= 0:
        raise BadRequest("Expansion factor must be positive")

    effective_pixel_size = None
    if pixel_size is not None:
        effective_pixel_size = pixel_size / expansion_factor if expanded else pixel_size
    return {
        "pixelSize": pixel_size,
        "effectivePixelSize": effective_pixel_size,
        "pixelUnit": pixel_unit,
        "expanded": expanded,
        "expansionFactor": expansion_factor,
    }


def _int_value(value, label):
    if isinstance(value, bool):
        raise BadRequest(f"Invalid {label}")
    try:
        return int(value)
    except (TypeError, ValueError) as exc:
        raise BadRequest(f"Invalid {label}") from exc
