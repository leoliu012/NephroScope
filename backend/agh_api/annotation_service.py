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
ALLOWED_TYPES = {"point", "line", "arrow", "rect", "ellipse", "freehand", "text"}
HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")


class AnnotationService:
    def __init__(self, ann_root: Path):
        self.ann_root = Path(ann_root)
        self.ann_root.mkdir(parents=True, exist_ok=True)

    def get(self, case: str, filename: str):
        return self._get_unlocked(case, filename)

    def save(self, case: str, filename: str, payload: dict, updated_by: str = "", require_revision: bool = True):
        if not isinstance(payload, dict):
            raise BadRequest("Annotation payload must be a JSON object")

        digest = image_id(case, filename)
        with file_lock(self._lock_path(digest)):
            current = self._get_unlocked(case, filename)
            expected_revision = payload.get("revision")
            if expected_revision is None:
                if require_revision:
                    raise BadRequest("revision is required")
                expected_revision = current["revision"]
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
        if ann_type not in ALLOWED_TYPES:
            raise BadRequest(f"Annotation {index} has unsupported type")
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
        cleaned.append(dict(ann))
    return cleaned


def _atomic_write_json(path: Path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, sort_keys=True)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
