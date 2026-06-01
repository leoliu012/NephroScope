from pathlib import Path

from .errors import BadRequest, NotFound


TIFF_EXTS = {".tif", ".tiff"}


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


def ensure_tiff_name(filename: str) -> str:
    filename = ensure_simple_name(filename, "filename")
    if Path(filename).suffix.lower() not in TIFF_EXTS:
        raise BadRequest("Only .tif and .tiff files are supported")
    return filename


def list_cases(data_root: Path) -> list[str]:
    root = Path(data_root).resolve()
    if not root.exists():
        raise NotFound("Data root does not exist")
    return sorted(
        child.name
        for child in root.iterdir()
        if child.is_dir() and not child.name.startswith(".")
    )


def case_dir(data_root: Path, case: str) -> Path:
    case = ensure_simple_name(case, "case")
    path = resolve_under_root(data_root, case)
    if not path.is_dir():
        raise NotFound("Case not found")
    return path


def image_path(data_root: Path, case: str, filename: str) -> Path:
    filename = ensure_tiff_name(filename)
    directory = case_dir(data_root, case)
    path = resolve_under_root(directory, filename)
    if not path.is_file():
        raise NotFound("Image file not found")
    return path


def list_tiff_files(data_root: Path, case: str) -> list[str]:
    directory = case_dir(data_root, case)
    return sorted(
        child.name
        for child in directory.iterdir()
        if child.is_file() and child.suffix.lower() in TIFF_EXTS
    )
