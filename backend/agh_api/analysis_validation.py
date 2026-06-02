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
    if bool(models.get("dapi", False)):
        raise BadRequest("DAPI segmentation is no longer supported")

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
    if normalized_models["nhs"] and normalized_channels["nhs"] is None:
        raise BadRequest("NHS model requires an NHS Ester channel")
    if normalized_models["nhs"] and nhs_mode == "combined-actn4" and normalized_channels["actn4"] is None:
        raise BadRequest("Combined NHS model requires an ACTN4 channel")

    preprocessing_mode = payload.get("preprocessingMode") or "percentile-stretch"
    if preprocessing_mode not in PREPROCESSING_MODES:
        raise BadRequest("Invalid preprocessing mode")
    if preprocessing_mode == "magnifyseg-enhanced":
        preprocessing_mode = "percentile-stretch"

    calibration = normalize_calibration(payload.get("calibration") or {}, metadata)
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


def normalize_calibration(payload, metadata=None):
    """Normalize raw and effective XY pixel calibration.

    Expansion factor is a scale ratio, not a pixel size. Physical metrics can
    use either a raw XY pixel size (optionally divided by EF) or a direct
    effective-pixel-size override when TIFF metadata is unavailable.
    """
    metadata = metadata or {}
    if not isinstance(payload, dict):
        raise BadRequest("Invalid calibration")

    pixel_size = _optional_positive_float(payload.get("pixelSize", metadata.get("pixelSize")), "pixel size")
    pixel_unit = str(payload.get("pixelUnit") or metadata.get("pixelUnit") or "um").strip() or "um"
    expanded = bool(payload.get("expanded", True))
    expansion_factor = _positive_float(payload.get("expansionFactor", 7.0), "expansion factor")

    effective_override = _optional_positive_float(
        payload.get("effectivePixelSizeOverride"),
        "effective pixel size override",
    )
    # Backwards compatibility for stored metric calibration records that only
    # contain an effective size and no raw pixel size.
    if effective_override is None and pixel_size is None and payload.get("effectivePixelSize") not in (None, ""):
        effective_override = _optional_positive_float(payload.get("effectivePixelSize"), "effective pixel size")

    if effective_override is not None:
        effective_pixel_size = effective_override
        source = "override"
    elif pixel_size is not None:
        effective_pixel_size = pixel_size / expansion_factor if expanded else pixel_size
        source = "raw-pixel-size/expansion-factor" if expanded else "raw-pixel-size"
    else:
        effective_pixel_size = None
        source = None

    return {
        "pixelSize": pixel_size,
        "effectivePixelSizeOverride": effective_override,
        "effectivePixelSize": effective_pixel_size,
        "effectivePixelSizeSource": source,
        "pixelUnit": pixel_unit,
        "expanded": expanded,
        "expansionFactor": expansion_factor,
    }


def _optional_positive_float(value, label):
    if value in (None, ""):
        return None
    return _positive_float(value, label)


def _positive_float(value, label):
    try:
        parsed = float(value)
    except (TypeError, ValueError) as exc:
        raise BadRequest(f"Invalid {label}") from exc
    if parsed <= 0:
        raise BadRequest(f"{label.capitalize()} must be positive")
    return parsed


def _int_value(value, label):
    if isinstance(value, bool):
        raise BadRequest(f"Invalid {label}")
    try:
        return int(value)
    except (TypeError, ValueError) as exc:
        raise BadRequest(f"Invalid {label}") from exc


