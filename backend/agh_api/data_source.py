"""Persistent project image source and backend-visible folder validation."""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
from pathlib import Path, PureWindowsPath

from .path_guard import IMAGE_EXTS, ensure_simple_name


SETTINGS_FILENAME = "image-source.json"


class SourceConfigurationError(ValueError):
    pass


def source_settings(config) -> dict:
    """Read an atomic snapshot shared by API processes and background workers."""
    try:
        source = json.loads((Path(config.sync_state_dir) / SETTINGS_FILENAME).read_text(encoding="utf-8"))
    except FileNotFoundError:
        folder = config.remote_data_root or config.data_root
        return {
            "mode": "sync" if config.remote_data_root else "direct",
            "folderPath": str(folder),
            "resolvedPath": str(folder),
        }
    if (
        not isinstance(source, dict)
        or source.get("mode") not in {"sync", "direct"}
        or not isinstance(source.get("folderPath"), str)
        or not isinstance(source.get("resolvedPath"), str)
        or not Path(source["resolvedPath"]).is_absolute()
    ):
        raise SourceConfigurationError("The saved image folder configuration is invalid")
    return source


def active_data_root(config) -> Path:
    source = source_settings(config)
    return Path(source["resolvedPath"]) if source["mode"] == "direct" else Path(config.data_root)


def image_source_id(path: Path) -> str:
    """Distinguish identically named images without exposing server paths."""
    return hashlib.sha256(str(path.resolve()).encode("utf-8")).hexdigest()


def is_temporary_name(name: str) -> bool:
    lowered = name.lower()
    return (
        name.startswith((".", "~"))
        or name.endswith("~")
        or any(marker in lowered for marker in (".partial", ".part", ".tmp", ".upload", ".inprogress"))
    )


def _mounted_windows_paths() -> list[tuple[str, Path]]:
    """Map drvfs/9p Windows volumes and mounted SMB shares to Linux paths."""
    try:
        lines = Path("/proc/mounts").read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    mounts = []
    for line in lines:
        fields = [re.sub(r"\\([0-7]{3})", lambda match: chr(int(match[1], 8)), field) for field in line.split()]
        if len(fields) < 4:
            continue
        source, target, _, options = fields[:4]
        aliases = [source]
        aliases.extend(re.findall(r"(?:^|[,;])path=([^,;]+)", options))
        for alias in aliases:
            if PureWindowsPath(alias).is_absolute():
                mounts.append((alias, Path(target)))
    return mounts


def resolve_folder(value: str) -> Path:
    if not isinstance(value, str) or not value.strip() or "\x00" in value:
        raise SourceConfigurationError("Enter an absolute folder path on the backend host")
    value = value.strip()
    windows_path = PureWindowsPath(value)
    if windows_path.is_absolute() and os.name != "nt":
        # Prefer actual mount mappings, including shares mounted outside /mnt.
        for alias, mount in sorted(_mounted_windows_paths(), key=lambda item: len(item[0]), reverse=True):
            try:
                relative = windows_path.relative_to(PureWindowsPath(alias))
            except ValueError:
                continue
            return mount.joinpath(*relative.parts).resolve()
        try:
            translated = subprocess.run(
                ["wslpath", "-u", value], capture_output=True, text=True, timeout=5, check=True,
            ).stdout.strip()
        except (OSError, subprocess.SubprocessError):
            translated = ""
        if translated.startswith("/") and not translated.startswith("//"):
            return Path(translated).resolve()
        raise SourceConfigurationError(
            "This Windows drive or share is not accessible from WSL. Mount it in WSL "
            "and enter its mounted path (for example /mnt/r/AGH_APP)."
        )
    path = Path(value).expanduser()
    if not path.is_absolute():
        raise SourceConfigurationError("Use an absolute Linux, Windows drive, or mounted share path")
    return path.resolve()


def validate_case_folder(root: Path) -> None:
    """Require root/case/image.{tif,tiff,nd2}, matching the viewer's layout."""
    try:
        entries = [entry for entry in root.iterdir() if not is_temporary_name(entry.name)]
        if any(entry.is_file() and entry.suffix.lower() in IMAGE_EXTS for entry in entries):
            raise SourceConfigurationError("Choose the parent folder containing case subfolders, not an individual case folder")
        cases = [entry for entry in entries if entry.is_dir()]
        if not cases:
            raise SourceConfigurationError("The folder must contain case subfolders with TIFF or ND2 images")
        image_count = 0
        for case in cases:
            ensure_simple_name(case.name, "case folder name")
            if case.is_symlink():
                raise SourceConfigurationError("Case subfolders must be real directories, not symbolic links")
            for image in case.iterdir():
                if is_temporary_name(image.name):
                    continue
                if image.is_dir():
                    continue
                if image.suffix.lower() in IMAGE_EXTS:
                    ensure_simple_name(image.name, "image filename")
                    if image.is_symlink() or not image.is_file():
                        raise SourceConfigurationError("Case images must be regular files, not symbolic links")
                    with image.open("rb") as handle:
                        handle.read(1)
                    image_count += 1
        if not image_count:
            raise SourceConfigurationError("Case subfolders must contain at least one readable .tif, .tiff, or .nd2 image")
    except OSError as exc:
        raise SourceConfigurationError(
            f"The folder is unavailable or unreadable by the backend: {root}. "
            "For a Windows remote drive, make sure it is mounted and accessible in WSL."
        ) from exc


def validate_sync_roots(local: Path, remote: Path) -> None:
    local, remote = local.resolve(), remote.resolve()
    if local == remote or local in remote.parents or remote in local.parents:
        raise SourceConfigurationError("The sync source and local cache must be separate, non-overlapping folders. Use direct mode to read the cache itself.")
