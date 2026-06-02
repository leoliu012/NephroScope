from .errors import BadRequest


PROCESS_WATERSHED_PRESETS = {
    "conservative": {
        "label": "Conservative",
        "minDistanceUm": 0.10,
        "maxPairDistanceUm": 1.50,
        "thresholdRelative": 0.34,
        "sigma": 1.0,
    },
    "balanced": {
        "label": "Balanced",
        "minDistanceUm": 0.08,
        "maxPairDistanceUm": 1.50,
        "thresholdRelative": 0.26,
        "sigma": 0.0,
    },
    "aggressive": {
        "label": "Aggressive",
        "minDistanceUm": 0.055,
        "maxPairDistanceUm": 1.50,
        "thresholdRelative": 0.18,
        "sigma": 0.8,
    },
}


def resolve_process_watershed(payload=None, effective_pixel_size=None, pixel_unit="um"):
    """
    Normalize process separation settings.

    The web UI sends physical-unit defaults so a preset keeps the same meaning
    across TIFF resolutions. Legacy pixel-unit fields remain accepted for
    backwards compatibility with earlier clients.
    """
    payload = payload or {}
    if not isinstance(payload, dict):
        raise BadRequest("Invalid watershed settings")

    pixel_size = _positive_float(effective_pixel_size, "effective pixel size")
    pixel_size_um = _to_um(pixel_size, pixel_unit)
    requested_preset = str(payload.get("preset") or "balanced")
    preset = PROCESS_WATERSHED_PRESETS.get(requested_preset, PROCESS_WATERSHED_PRESETS["balanced"])

    min_distance_um = _optional_positive_float(payload.get("minDistanceUm"), "minDistanceUm")
    max_pair_um = _optional_positive_float(payload.get("maxPairDistanceUm"), "maxPairDistanceUm")

    # Backwards compatibility: older clients sent pixel-unit fields.
    legacy_min_px = _optional_positive_float(payload.get("minDistance"), "minDistance")
    legacy_max_px = _optional_positive_float(payload.get("maxPairDistance"), "maxPairDistance")

    if min_distance_um is None:
        min_distance_um = legacy_min_px * pixel_size_um if legacy_min_px is not None else preset["minDistanceUm"]
    if max_pair_um is None:
        max_pair_um = legacy_max_px * pixel_size_um if legacy_max_px is not None else preset["maxPairDistanceUm"]

    resolved = {
        "preset": requested_preset if requested_preset in PROCESS_WATERSHED_PRESETS else "custom",
        "label": preset.get("label", "Custom"),
        "minDistanceUm": min_distance_um,
        "maxPairDistanceUm": max_pair_um,
        "minDistance": min_distance_um / pixel_size_um,
        "maxPairDistance": max_pair_um / pixel_size_um,
        "thresholdRelative": _positive_float(
            payload.get("thresholdRelative", preset["thresholdRelative"]),
            "thresholdRelative",
        ),
        "sigma": _nonnegative_float(payload.get("sigma", preset["sigma"]), "sigma"),
        "effectivePixelSize": pixel_size,
        "effectivePixelSizeUm": pixel_size_um,
        "pixelUnit": str(pixel_unit or "um"),
    }
    if resolved["thresholdRelative"] > 1:
        raise BadRequest("thresholdRelative must be between 0 and 1")
    if resolved["preset"] == "custom":
        resolved["label"] = str(payload.get("label") or "Custom")
    return resolved


def _to_um(value, unit):
    normalized = str(unit or "um").strip().lower().replace("\u00b5", "u")
    factors = {
        "um": 1.0,
        "micrometer": 1.0,
        "micrometers": 1.0,
        "nm": 0.001,
        "nanometer": 0.001,
        "nanometers": 0.001,
        "mm": 1000.0,
        "millimeter": 1000.0,
        "millimeters": 1000.0,
    }
    return value * factors.get(normalized, 1.0)


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
        raise BadRequest(f"{label} must be positive")
    return parsed


def _nonnegative_float(value, label):
    try:
        parsed = float(value)
    except (TypeError, ValueError) as exc:
        raise BadRequest(f"Invalid {label}") from exc
    if parsed < 0:
        raise BadRequest(f"{label} must be non-negative")
    return parsed
