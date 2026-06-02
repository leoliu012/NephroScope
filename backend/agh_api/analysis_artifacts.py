import mimetypes
import uuid
from pathlib import Path, PurePosixPath

from .errors import BadRequest, NotFound
from .path_guard import ensure_simple_name, resolve_under_root


ALLOWED_ARTIFACT_EXTENSIONS = {".png", ".json", ".csv", ".tif", ".tiff"}


def run_directory(analysis_root: Path, run_id: str) -> Path:
    ensure_run_id(run_id)
    return resolve_under_root(Path(analysis_root) / "runs", run_id)


def metric_directory(analysis_root: Path, segmentation_run_id: str, metric_run_id: str) -> Path:
    ensure_run_id(metric_run_id)
    return resolve_under_root(run_directory(analysis_root, segmentation_run_id), "metrics", metric_run_id)


def ensure_run_id(run_id: str) -> str:
    try:
        uuid.UUID(str(run_id))
    except (TypeError, ValueError) as exc:
        raise BadRequest("Invalid analysis run id") from exc
    return str(run_id)


def artifact_path(analysis_root: Path, run_id: str, artifact_name: str) -> Path:
    parts = _artifact_parts(artifact_name)
    if Path(parts[-1]).suffix.lower() not in ALLOWED_ARTIFACT_EXTENSIONS:
        raise BadRequest("Unsupported artifact type")
    directory = run_directory(analysis_root, run_id)
    path = resolve_under_root(directory, *parts)
    if not path.is_file():
        raise NotFound("Analysis artifact not found")
    return path


def artifact_mimetype(path: Path):
    if path.suffix.lower() in {".tif", ".tiff"}:
        return "image/tiff"
    if path.suffix.lower() == ".csv":
        return "text/csv"
    return mimetypes.guess_type(path.name)[0] or "application/octet-stream"


def metric_artifact_name(metric_run_id: str, filename: str) -> str:
    ensure_run_id(metric_run_id)
    filename = ensure_simple_name(filename, "artifact")
    return f"metrics/{metric_run_id}/{filename}"


def _artifact_parts(artifact_name: str):
    if not isinstance(artifact_name, str) or not artifact_name or "\\" in artifact_name:
        raise BadRequest("Invalid artifact")
    parts = PurePosixPath(artifact_name).parts
    if not parts:
        raise BadRequest("Invalid artifact")
    return [ensure_simple_name(part, "artifact") for part in parts]
