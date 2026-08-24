import re
from pathlib import Path

from .errors import BadRequest, NotFound


IMAGE_EXTS = {".tif", ".tiff", ".nd2"}
TIFF_EXTS = {".tif", ".tiff"}


def natural_sort_key(value: str) -> tuple:
    """Return a case-insensitive key that orders embedded numbers numerically."""
    return tuple(
        (1, int(part)) if part.isdigit() else (0, part.casefold())
        for part in re.split(r"(\d+)", value)
    )


def resolve_under_root(root: Path, *parts: str) -> Path:
    root = Path(root).resolve()
    candidate = root.joinpath(*parts).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise BadRequest("Path escapes configured root") from exc
    return candidate


def ensure_simple_name(value: str, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise BadRequest(f"Invalid {label}")
    if value in {".", ".."} or "/" in value or "\\" in value:
        raise BadRequest(f"Invalid {label}")
    if Path(value).name != value:
        raise BadRequest(f"Invalid {label}")
    return value


def ensure_image_name(filename: str) -> str:
    filename = ensure_simple_name(filename, "filename")
    if Path(filename).suffix.lower() not in IMAGE_EXTS:
        raise BadRequest("Only .tif, .tiff, and .nd2 files are supported")
    return filename


def ensure_tiff_name(filename: str) -> str:
    return ensure_image_name(filename)


def list_cases(data_root: Path) -> list[str]:
    root = Path(data_root).resolve()
    if not root.exists():
        raise NotFound("Data root does not exist")
    return sorted(
        (
            child.name
            for child in root.iterdir()
            if child.is_dir() and not child.name.startswith(".")
        ),
        key=natural_sort_key,
    )


def case_dir(data_root: Path, case: str) -> Path:
    case = ensure_simple_name(case, "case")
    path = resolve_under_root(data_root, case)
    if not path.is_dir():
        raise NotFound("Case not found")
    return path


def image_path(data_root: Path, case: str, filename: str) -> Path:
    filename = ensure_image_name(filename)
    directory = case_dir(data_root, case)
    path = resolve_under_root(directory, filename)
    if not path.is_file():
        raise NotFound("Image file not found")
    return path


def list_tiff_files(data_root: Path, case: str) -> list[str]:
    return list_image_files(data_root, case)


def list_image_files(data_root: Path, case: str) -> list[str]:
    directory = case_dir(data_root, case)
    return sorted(
        child.name
        for child in directory.iterdir()
        if child.is_file() and child.suffix.lower() in IMAGE_EXTS
    )
