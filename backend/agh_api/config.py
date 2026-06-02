import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


@dataclass(frozen=True)
class Config:
    data_root: Path
    ann_root: Path
    cache_root: Path
    analysis_root: Optional[Path] = None
    model_root: Optional[Path] = None
    analysis_db: Optional[Path] = None
    host: str = "127.0.0.1"
    port: int = 5055

    def __post_init__(self):
        base = Path(self.cache_root).parent
        if self.analysis_root is None:
            object.__setattr__(self, "analysis_root", base / "agh_analysis")
        if self.model_root is None:
            object.__setattr__(self, "model_root", base / "agh_models")
        if self.analysis_db is None:
            object.__setattr__(self, "analysis_db", Path(self.analysis_root) / "jobs.sqlite3")

    @classmethod
    def from_env(cls):
        analysis_root = _env_path("AGH_ANALYSIS_ROOT", "/data/agh_analysis")
        return cls(
            data_root=_env_path("AGH_DATA_ROOT", "/data/AGH_APP"),
            ann_root=_env_path("AGH_ANN_ROOT", "/data/agh_annotations"),
            cache_root=_env_path("AGH_CACHE_ROOT", "/data/agh_cache"),
            analysis_root=analysis_root,
            model_root=_env_path("AGH_MODEL_ROOT", "/data/agh_models"),
            analysis_db=_env_path("AGH_ANALYSIS_DB", analysis_root / "jobs.sqlite3"),
            host=os.environ.get("AGH_HOST", "127.0.0.1"),
            port=int(os.environ.get("AGH_PORT", "5055")),
        )

    @classmethod
    def local_dev(cls, backend_dir: Path):
        base = Path(backend_dir) / ".local_data"
        return cls(
            data_root=base / "AGH_APP",
            ann_root=base / "agh_annotations",
            cache_root=base / "agh_cache",
            analysis_root=base / "agh_analysis",
            model_root=base / "agh_models",
            analysis_db=base / "agh_analysis" / "jobs.sqlite3",
            host=os.environ.get("AGH_HOST", "127.0.0.1"),
            port=int(os.environ.get("AGH_PORT", "5055")),
        )

    def ensure_directories(self):
        for label, path in (
            ("image data", self.data_root),
            ("annotation", self.ann_root),
            ("cache", self.cache_root),
            ("analysis", self.analysis_root),
            ("model", self.model_root),
        ):
            try:
                path.mkdir(parents=True, exist_ok=True)
            except OSError as exc:
                raise RuntimeError(
                    f"Cannot create {label} directory at {path}. "
                    "For local development, unset AGH_DATA_ROOT/AGH_ANN_ROOT/AGH_CACHE_ROOT "
                    "or run with AGH_LOCAL_DEV=1. To use a real local dataset, set "
                    "AGH_DATA_ROOT, AGH_ANN_ROOT, AGH_CACHE_ROOT, and AGH_ANALYSIS_ROOT "
                    "to writable paths. "
                    "For production, create the /data directories with the service user's permissions."
                ) from exc
        try:
            self.analysis_db.parent.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise RuntimeError(f"Cannot create analysis database directory at {self.analysis_db.parent}") from exc


def _env_path(name, default):
    return Path(os.environ.get(name, default)).expanduser()
