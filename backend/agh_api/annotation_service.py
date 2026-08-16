import hashlib
import json
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

from .errors import BadRequest, Conflict
from .file_lock import file_lock
from .path_guard import resolve_under_root


SCHEMA_VERSION = 1
ALLOWED_TYPES = {"point", "line", "measure", "arrow", "rect", "ellipse", "freehand", "text"}
TYPE_ALIASES = {
    "box": "rect",
    "brush": "freehand",
    "caliper": "measure",
    "caliper_line": "measure",
    "caliper_measure": "measure",
    "caliper_measurement": "measure",
    "caliper_tool": "measure",
    "calipers": "measure",
    "calibrated_measure": "measure",
    "calibrated_measurement": "measure",
    "calibrated_measurement_line": "measure",
    "calibrated_ruler": "measure",
    "circle": "point",
    "distance": "measure",
    "distance_line": "measure",
    "distance_measure": "measure",
    "distance_measurement": "measure",
    "distance_measurement_line": "measure",
    "distance_ruler": "measure",
    "distance_tool": "measure",
    "dot": "point",
    "draw": "freehand",
    "free_hand": "freehand",
    "label": "text",
    "length": "measure",
    "length_indicator": "measure",
    "length_line": "measure",
    "length_marker": "measure",
    "length_measure": "measure",
    "length_measurement": "measure",
    "length_ruler": "measure",
    "length_tool": "measure",
    "line_measurement": "measure",
    "line_measurement_tool": "measure",
    "linear_measure": "measure",
    "linear_measurement": "measure",
    "marker": "point",
    "measure_annotation": "measure",
    "measure_line": "measure",
    "measure_object": "measure",
    "measure_shape": "measure",
    "measure_tool": "measure",
    "rectangle": "rect",
    "measurement": "measure",
    "measurement_annotation": "measure",
    "measurement_line": "measure",
    "measurement_object": "measure",
    "measurement_shape": "measure",
    "measurement_tool": "measure",
    "measurements": "measure",
    "measurements_line": "measure",
    "note": "text",
    "oval": "ellipse",
    "path": "freehand",
    "pen": "freehand",
    "polygon": "freehand",
    "polyline": "freehand",
    "ruler": "measure",
    "ruler_line": "measure",
    "ruler_measure": "measure",
    "ruler_measurement": "measure",
    "ruler_measurement_tool": "measure",
    "ruler_tool": "measure",
    "scale_bar": "measure",
    "scalebar": "measure",
    "scribble": "freehand",
    "square": "rect",
}
TYPE_FIELDS = (
    "type",
    "annotationType",
    "annotation_type",
    "kind",
    "tool",
    "toolType",
    "tool_type",
    "toolId",
    "tool_id",
    "toolKey",
    "tool_key",
    "toolName",
    "tool_name",
    "shape",
    "shapeType",
    "shape_type",
    "mode",
    "name",
    "class",
    "className",
    "class_name",
    "category",
    "objectType",
    "object_type",
    "subtype",
    "subType",
    "sub_type",
    "measurementType",
    "measurement_type",
)
TYPE_VALUE_FIELDS = (
    "type",
    "annotationType",
    "annotation_type",
    "kind",
    "tool",
    "toolType",
    "tool_type",
    "toolId",
    "tool_id",
    "toolKey",
    "tool_key",
    "toolName",
    "tool_name",
    "shape",
    "shapeType",
    "shape_type",
    "mode",
    "name",
    "id",
    "value",
    "label",
    "key",
    "code",
    "title",
    "displayName",
    "display_name",
    "class",
    "className",
    "class_name",
    "category",
    "objectType",
    "object_type",
    "subtype",
    "subType",
    "sub_type",
    "measurementType",
    "measurement_type",
)
TYPE_CONTAINER_FIELDS = (
    "metadata",
    "meta",
    "properties",
    "props",
    "attributes",
    "attrs",
    "classification",
    "classifications",
    "data",
    "details",
    "extra",
    "extras",
    "toolData",
    "tool_data",
)
MEASUREMENT_HINT_FIELDS = {
    "calibration",
    "distance",
    "distance_px",
    "distance_um",
    "is_measurement",
    "label_dx",
    "label_dy",
    "length",
    "length_px",
    "length_um",
    "measure",
    "measurement",
    "microns",
    "micrometers",
    "pixel_size",
    "pixel_size_um",
    "pixel_size_x_um",
    "pixel_size_y_um",
    "ruler",
    "unit_um",
}
HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")


class AnnotationService:
    def __init__(self, ann_root: Path):
        self.ann_root = Path(ann_root)
        self.ann_root.mkdir(parents=True, exist_ok=True)

    def get(self, case: str, filename: str):
        return self._get_unlocked(case, filename)

    def save(self, case: str, filename: str, payload: dict, updated_by: str = ""):
        if not isinstance(payload, dict):
            raise BadRequest("Annotation payload must be a JSON object")

        digest = image_id(case, filename)
        with file_lock(self._lock_path(digest)):
            current = self._get_unlocked(case, filename)
            expected_revision = payload.get("revision")
            if expected_revision is None:
                raise BadRequest("revision is required")
            if not isinstance(expected_revision, int):
                raise BadRequest("revision must be an integer")
            if expected_revision != current["revision"]:
                raise Conflict("Annotation revision changed; reload before saving")

            annotations = _validate_annotations(payload.get("annotations", []))
            document = {
                "schemaVersion": SCHEMA_VERSION,
                "imageId": digest,
                "case": case,
                "filename": filename,
                "revision": current["revision"] + 1,
                "updatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                "updatedBy": updated_by or payload.get("updatedBy") or "",
                "annotations": annotations,
            }

            _atomic_write_json(self._path_for_id(digest), document)
            return {
                "ok": True,
                "imageId": document["imageId"],
                "revision": document["revision"],
                "updatedAt": document["updatedAt"],
                "updatedBy": document["updatedBy"],
            }

    def _get_unlocked(self, case: str, filename: str):
        path = self._path(case, filename)
        if path.exists():
            return self._read_document(path, case, filename)

        # Preserve existing annotations written before hashed filenames were introduced.
        # New saves always write the canonical hashed path above.
        legacy = self._legacy_path(case, filename)
        if legacy.exists():
            return self._read_document(legacy, case, filename, revision_default=0)

        return self._empty_document(case, filename)

    def _empty_document(self, case: str, filename: str):
        return {
            "schemaVersion": SCHEMA_VERSION,
            "imageId": image_id(case, filename),
            "case": case,
            "filename": filename,
            "revision": 0,
            "updatedAt": None,
            "updatedBy": "",
            "annotations": [],
        }

    def _read_document(self, path: Path, case: str, filename: str, revision_default=0):
        with path.open("r", encoding="utf-8") as f:
            raw = json.load(f)
        annotations = _validate_annotations(raw.get("annotations", []))
        return {
            "schemaVersion": int(raw.get("schemaVersion", SCHEMA_VERSION)),
            "imageId": raw.get("imageId") or image_id(case, filename),
            "case": raw.get("case") or case,
            "filename": raw.get("filename") or filename,
            "revision": int(raw.get("revision", revision_default)),
            "updatedAt": raw.get("updatedAt"),
            "updatedBy": raw.get("updatedBy", ""),
            "annotations": annotations,
        }

    def _path(self, case: str, filename: str):
        digest = image_id(case, filename)
        return self._path_for_id(digest)

    def _path_for_id(self, digest: str):
        return resolve_under_root(self.ann_root, f"{digest}.json")

    def _lock_path(self, digest: str):
        return resolve_under_root(self.ann_root, ".locks", f"{digest}.lock")

    def _legacy_path(self, case: str, filename: str):
        key = (case + "__" + filename).replace("/", "_").replace("\\", "_")
        return resolve_under_root(self.ann_root, key + ".json")


def image_id(case: str, filename: str):
    return hashlib.sha256(f"{case}/{filename}".encode("utf-8")).hexdigest()


def _validate_annotations(value):
    if not isinstance(value, list):
        raise BadRequest("annotations must be a list")
    if len(value) > 5000:
        raise BadRequest("Too many annotations")

    cleaned = []
    for index, ann in enumerate(value):
        if not isinstance(ann, dict):
            raise BadRequest(f"Annotation {index} must be an object")
        ann_type = ann.get("type")
        normalized_type = _normalize_annotation_type(ann)
        if normalized_type not in ALLOWED_TYPES:
            raise BadRequest(f"Annotation {index} has unsupported type: {ann_type!r}")
        ann_id = ann.get("id")
        if not isinstance(ann_id, str) or not ann_id:
            raise BadRequest(f"Annotation {index} requires an id")
        coords = ann.get("coords")
        if not isinstance(coords, list) or not coords:
            raise BadRequest(f"Annotation {index} requires coords")
        for coord in coords:
            if not isinstance(coord, (int, float)):
                raise BadRequest(f"Annotation {index} contains non-numeric coords")
        color = ann.get("color")
        if color is not None and (not isinstance(color, str) or not HEX_COLOR.match(color)):
            raise BadRequest(f"Annotation {index} has invalid color")
        if "label" in ann and not isinstance(ann["label"], str):
            raise BadRequest(f"Annotation {index} label must be a string")
        if "annotator" in ann:
            if not isinstance(ann["annotator"], str):
                raise BadRequest(f"Annotation {index} annotator must be a string")
            if len(ann["annotator"]) > 200:
                raise BadRequest(f"Annotation {index} annotator is too long")
        normalized = dict(ann)
        normalized["type"] = normalized_type
        if normalized_type == "point":
            normalized = _normalize_point_geometry(normalized)
        if normalized_type == "measure":
            normalized = _normalize_measurement_annotation(normalized)
        coords = normalized["coords"]
        if normalized_type == "measure" and len(coords) != 4:
            raise BadRequest(f"Annotation {index} measurement requires exactly four coords")
        _validate_optional_number(normalized, index, "strokeWidth", 0.5, 20)
        _validate_optional_number(normalized, index, "fontSize", 8, 160)
        _validate_optional_number(normalized, index, "radius", 0, 1_000_000)
        _validate_optional_number(normalized, index, "pixelSizeUm", 0, 1_000_000)
        _validate_optional_number(normalized, index, "pixelSizeXUm", 0, 1_000_000)
        _validate_optional_number(normalized, index, "pixelSizeYUm", 0, 1_000_000)
        _validate_optional_number(normalized, index, "labelDx", -1_000_000, 1_000_000, allow_zero=True)
        _validate_optional_number(normalized, index, "labelDy", -1_000_000, 1_000_000, allow_zero=True)
        _validate_optional_number(normalized, index, "rotation", -360_000, 360_000, allow_zero=True)
        _validate_optional_integer(normalized, index, "zIndex", 0, 1_000_000)
        cleaned.append(normalized)
    return cleaned


def _normalize_annotation_type(annotation):
    values = list(_annotation_type_values(annotation))
    first_normalized = None
    for value in values:
        normalized = _normalize_annotation_type_value(value)
        if first_normalized is None:
            first_normalized = normalized
        if normalized in ALLOWED_TYPES:
            return normalized
    if isinstance(annotation, dict) and _annotation_looks_like_measurement(annotation):
        return "measure"
    return first_normalized


def _annotation_type_values(annotation):
    if not isinstance(annotation, dict):
        yield from _nested_type_values(annotation)
        return
    for field in TYPE_FIELDS:
        if field in annotation:
            yield from _nested_type_values(annotation[field])
    for field in TYPE_CONTAINER_FIELDS:
        if field in annotation:
            yield from _nested_type_values(annotation[field])


def _nested_type_values(value):
    if isinstance(value, dict):
        for field in (*TYPE_VALUE_FIELDS, *TYPE_CONTAINER_FIELDS):
            if field in value:
                yield from _nested_type_values(value[field])
        return
    if isinstance(value, list):
        for item in value:
            yield from _nested_type_values(item)
        return
    yield value


def _normalize_annotation_type_value(value):
    if not isinstance(value, str):
        return None
    key = _normalize_annotation_key(value)
    if not key:
        return None
    if key in TYPE_ALIASES:
        return TYPE_ALIASES[key]
    if _key_looks_like_measurement_type(key):
        return "measure"
    return key


def _normalize_annotation_key(value):
    key = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", str(value).strip())
    return re.sub(r"[^A-Za-z0-9]+", "_", key).strip("_").lower()


def _key_looks_like_measurement_type(key):
    tokens = set(key.split("_"))
    if not tokens:
        return False
    if tokens & {"measurement", "measurements", "ruler", "caliper", "calipers"}:
        return True
    if "measure" in tokens:
        return True
    if tokens & {"distance", "length"} and tokens & {"annotation", "line", "object", "shape", "tool"}:
        return True
    if "linear" in tokens and tokens & {"annotation", "line", "measure", "measurement", "tool"}:
        return True
    if "scale" in tokens and tokens & {"bar", "line", "tool"}:
        return True
    return False


def _annotation_looks_like_measurement(annotation):
    coords = annotation.get("coords")
    if not isinstance(coords, list) or len(coords) != 4:
        return False
    if not all(isinstance(coord, (int, float)) and not isinstance(coord, bool) for coord in coords):
        return False
    return _has_measurement_hint(annotation)


def _has_measurement_hint(value):
    if isinstance(value, dict):
        for key, nested in value.items():
            normalized_key = _normalize_annotation_key(key)
            if normalized_key in MEASUREMENT_HINT_FIELDS or _key_looks_like_measurement_hint(normalized_key):
                return True
            if isinstance(nested, (dict, list)) and _has_measurement_hint(nested):
                return True
        return False
    if isinstance(value, list):
        return any(_has_measurement_hint(item) for item in value)
    return False


def _key_looks_like_measurement_hint(key):
    tokens = set(key.split("_"))
    if not tokens:
        return False
    if tokens & {"measurement", "measurements", "ruler", "caliper", "calipers"}:
        return True
    if "measure" in tokens:
        return True
    if tokens & {"distance", "length"}:
        return True
    if "pixel" in tokens and tokens & {"size", "spacing", "micron", "microns", "um"}:
        return True
    return False


def _normalize_point_geometry(annotation):
    coords = annotation.get("coords", [])
    radius = annotation.get("radius")
    if isinstance(radius, (int, float)) and not isinstance(radius, bool) and radius > 0:
        return annotation
    if len(coords) >= 4:
        x1, y1, x2, y2 = coords[:4]
        annotation = dict(annotation)
        annotation["coords"] = [(x1 + x2) / 2, (y1 + y2) / 2]
        annotation["radius"] = max(1, max(abs(x2 - x1), abs(y2 - y1)) / 2)
        return annotation
    if len(coords) >= 3 and isinstance(coords[2], (int, float)) and not isinstance(coords[2], bool) and coords[2] > 0:
        annotation = dict(annotation)
        annotation["coords"] = coords[:2]
        annotation["radius"] = coords[2]
    return annotation


def _normalize_measurement_annotation(annotation):
    pixel_size = annotation.get("pixelSizeUm")
    if "pixelSizeXUm" not in annotation and pixel_size is not None:
        annotation["pixelSizeXUm"] = pixel_size
    if "pixelSizeYUm" not in annotation and pixel_size is not None:
        annotation["pixelSizeYUm"] = pixel_size
    return annotation


def _validate_optional_number(annotation, index, field, minimum, maximum, allow_zero=False):
    if field not in annotation:
        return
    value = annotation[field]
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise BadRequest(f"Annotation {index} {field} must be numeric")
    lower_ok = minimum <= value if allow_zero else minimum < value
    if not lower_ok or value > maximum:
        raise BadRequest(f"Annotation {index} {field} is outside the supported range")


def _validate_optional_integer(annotation, index, field, minimum, maximum):
    if field not in annotation:
        return
    value = annotation[field]
    if isinstance(value, bool) or not isinstance(value, int):
        raise BadRequest(f"Annotation {index} {field} must be an integer")
    if value < minimum or value > maximum:
        raise BadRequest(f"Annotation {index} {field} is outside the supported range")


def _atomic_write_json(path: Path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, sort_keys=True)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
