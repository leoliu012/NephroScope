import json
import os
import time
from pathlib import Path
from threading import RLock

from .file_lock import file_lock


PRESENCE_TTL_SECONDS = 20


def _now():
    return time.time()


def _clean_display_name(value, fallback):
    text = str(value or "").strip()
    return text[:120] if text else fallback


def _clean_text(value, limit=260):
    if value is None:
        return None
    text = str(value).strip()
    return text[:limit] if text else None


def _clean_width(value, minimum=160, maximum=900):
    try:
        number = int(round(float(value)))
    except (TypeError, ValueError):
        return None
    return max(minimum, min(maximum, number))


def _jsonable(value):
    try:
        json.dumps(value)
        return value
    except (TypeError, ValueError):
        return None


def _clean_index(value):
    try:
        number = int(value or 0)
    except (TypeError, ValueError):
        number = 0
    return max(0, number)


class CollaborationService:
    """Small file-backed collaboration state store.

    This intentionally keeps only live UI state here. Revisioned annotations
    remain owned by AnnotationService.
    """

    def __init__(self, path: Path):
        self.path = Path(path)
        self._lock = RLock()

    def _default_state(self):
        return {
            "workspace": {
                "selectionPanelWidth": 560,
                "casePanelWidth": 240,
                "imagePanelWidth": 320,
                "updatedAt": None,
                "updatedBy": None,
                "updatedByName": None,
            },
            "presence": {},
            "viewStates": {},
        }

    def _read(self):
        with self._lock:
            try:
                with self.path.open("r", encoding="utf-8") as handle:
                    data = json.load(handle)
            except (FileNotFoundError, json.JSONDecodeError, OSError):
                data = self._default_state()
            state = self._default_state()
            state.update(data if isinstance(data, dict) else {})
            state["workspace"] = {**self._default_state()["workspace"], **(state.get("workspace") or {})}
            state["presence"] = state.get("presence") if isinstance(state.get("presence"), dict) else {}
            state["viewStates"] = state.get("viewStates") if isinstance(state.get("viewStates"), dict) else {}
            return self._prune_presence(state)

    def _write(self, state):
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(self.path.suffix + ".tmp")
            with tmp.open("w", encoding="utf-8") as handle:
                json.dump(state, handle, indent=2, sort_keys=True)
                handle.write("\n")
            os.replace(tmp, self.path)

    def _prune_presence(self, state):
        cutoff = _now() - PRESENCE_TTL_SECONDS
        state["presence"] = {
            key: value for key, value in (state.get("presence") or {}).items()
            if float(value.get("lastSeen") or 0) >= cutoff
        }
        return state

    def snapshot(self):
        state = self._read()
        return {
            "workspace": state["workspace"],
            "presence": sorted(state["presence"].values(), key=lambda item: item.get("displayName") or item.get("username") or ""),
        }

    def heartbeat(self, client_id, actor):
        with file_lock(self.path.with_suffix(self.path.suffix + ".lock")):
            state = self._read()
            now = _now()
            state["presence"][client_id] = {
                **actor,
                "clientId": client_id,
                "caseId": _clean_text(actor.get("caseId")),
                "filename": _clean_text(actor.get("filename")),
                "viewerOpen": bool(actor.get("viewerOpen")),
                "lastSeen": now,
            }
            self._write(state)
        return self.snapshot()

    def update_workspace(self, client_id, actor, payload):
        width = _clean_width(payload.get("selectionPanelWidth"), 360, 900)
        case_width = _clean_width(payload.get("casePanelWidth"), 160, 420)
        image_width = _clean_width(payload.get("imagePanelWidth"), 220, 640)
        with file_lock(self.path.with_suffix(self.path.suffix + ".lock")):
            state = self._read()
            updates = {}
            if case_width is not None:
                updates["casePanelWidth"] = case_width
            if image_width is not None:
                updates["imagePanelWidth"] = image_width
            if width is not None and not updates:
                updates["selectionPanelWidth"] = width
            if updates:
                if "casePanelWidth" in updates or "imagePanelWidth" in updates:
                    next_case_width = updates.get("casePanelWidth", state["workspace"].get("casePanelWidth") or 240)
                    next_image_width = updates.get("imagePanelWidth", state["workspace"].get("imagePanelWidth") or 320)
                    updates["selectionPanelWidth"] = int(next_case_width) + int(next_image_width)
                state["workspace"].update({
                    **updates,
                    "updatedAt": _now(),
                    "updatedBy": actor.get("username"),
                    "updatedByName": actor.get("displayName"),
                })
            self._write(state)
        return {"workspace": state["workspace"]}

    def get_view_state(self, case_id, filename):
        state = self._read()
        key = f"{case_id}/{filename}"
        return state["viewStates"].get(key) or {
            "caseId": case_id,
            "filename": filename,
            "revision": 0,
            "channelSettings": None,
            "measurementSettings": None,
            "zIndex": 0,
            "lastChangedAt": None,
            "lastChangedBy": None,
            "lastChangedByName": None,
            "lastChangedFields": [],
        }

    def update_view_state(self, case_id, filename, actor, payload):
        with file_lock(self.path.with_suffix(self.path.suffix + ".lock")):
            state = self._read()
            key = f"{case_id}/{filename}"
            current = state["viewStates"].get(key) or {
                "caseId": case_id,
                "filename": filename,
                "revision": 0,
                "channelSettings": None,
                "measurementSettings": None,
                "zIndex": 0,
                "lastChangedAt": None,
                "lastChangedBy": None,
                "lastChangedByName": None,
                "lastChangedFields": [],
            }
            changed = []
            for field in ("channelSettings", "measurementSettings", "zIndex"):
                if field in payload:
                    value = _clean_index(payload.get(field)) if field == "zIndex" else _jsonable(payload.get(field))
                    if value is not None:
                        current[field] = value
                        changed.append(field)
            if changed:
                current.update({
                    "caseId": case_id,
                    "filename": filename,
                    "revision": int(current.get("revision") or 0) + 1,
                    "lastChangedAt": _now(),
                    "lastChangedBy": actor.get("username"),
                    "lastChangedByName": actor.get("displayName"),
                    "lastChangedFields": changed,
                })
                state["viewStates"][key] = current
                self._write(state)
        return current


def collaboration_actor(username="", display_name="", case_id=None, filename=None, viewer_open=False):
    fallback = username or "Viewer"
    return {
        "username": username or "",
        "displayName": _clean_display_name(display_name, fallback),
        "caseId": case_id,
        "filename": filename,
        "viewerOpen": viewer_open,
    }
