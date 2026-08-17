#!/usr/bin/env python3
"""Guard the supported AGH viewer + MorphoGBM integration surface.

The filename is retained for compatibility with older CI jobs. The app is no
longer viewer-only: it intentionally contains one narrowly scoped MorphoGBM v10
segmentation workflow. This guard rejects the removed generic/TensorFlow
analysis stack and verifies the exact deployment checkpoint instead of banning
all model-inference terminology.
"""
from __future__ import annotations

import hashlib
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]

OBSOLETE_PATHS = (
    "backend/agh_api/analysis_profiles.py",
    "backend/agh_api/analysis_service.py",
    "backend/agh_api/job_queue.py",
    "backend/agh_api/model_registry.py",
    "backend/agh_api/processing_service.py",
    "backend/agh_api/magnifyseg_engine",
    "frontend/src/components/AnalysisPanel.jsx",
    "frontend/src/components/AnalysisWorkspace.jsx",
    "frontend/src/components/ContourOverlay.jsx",
    "frontend/src/components/MetricsPanel.jsx",
)

ACTIVE_SOURCE_ROOTS = (
    ROOT / "backend" / "agh_api",
    ROOT / "frontend" / "src",
)
ACTIVE_SOURCE_FILES = (ROOT / "deploy.py",)
SOURCE_SUFFIXES = {".py", ".js", ".jsx", ".ts", ".tsx"}
FORBIDDEN_SOURCE_PATTERNS = (
    ("watershed processing", re.compile(r"\bwatershed\b", re.IGNORECASE)),
    (
        "legacy analysis import",
        re.compile(
            r"\b(?:analysis_profiles|analysis_service|analysis_queue)\b",
            re.IGNORECASE,
        ),
    ),
    ("legacy TensorFlow runtime", re.compile(r"\b(?:tensorflow|keras)\b", re.IGNORECASE)),
    (
        "legacy MagnifySeg runtime",
        re.compile(r"\bmagnifyseg(?:_engine)?\b", re.IGNORECASE),
    ),
)

MODEL_PATH = (
    ROOT / "backend" / "models" / "morphogbm_v10_topology_robust_inference.pt"
)
MODEL_SHA256 = "a729ecc0036ddb6a52819dc92e93be43bd18d2ce8d472179a9fb92f0a76aec7f"


def source_files():
    for source_root in ACTIVE_SOURCE_ROOTS:
        if not source_root.exists():
            continue
        for path in source_root.rglob("*"):
            if path.is_file() and path.suffix.lower() in SOURCE_SUFFIXES:
                yield path
    for path in ACTIVE_SOURCE_FILES:
        if path.is_file():
            yield path


def checkpoint_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    problems: list[str] = []

    for relative in OBSOLETE_PATHS:
        if (ROOT / relative).exists():
            problems.append(f"obsolete generic-analysis path still exists: {relative}")

    for marker in sorted(ROOT.glob(".last_*_patch_backup")):
        problems.append(f"stale root patch marker still exists: {marker.name}")

    for path in source_files():
        relative = path.relative_to(ROOT)
        text = path.read_text(encoding="utf-8", errors="replace")
        for label, pattern in FORBIDDEN_SOURCE_PATTERNS:
            if pattern.search(text):
                problems.append(f"{label} reference found in active source: {relative}")

    if not MODEL_PATH.is_file():
        problems.append(
            f"required MorphoGBM checkpoint is missing: {MODEL_PATH.relative_to(ROOT)}"
        )
    else:
        actual_sha256 = checkpoint_sha256(MODEL_PATH)
        if actual_sha256 != MODEL_SHA256:
            problems.append(
                "MorphoGBM checkpoint checksum mismatch: "
                f"expected {MODEL_SHA256}, found {actual_sha256}"
            )

    if problems:
        print("AGH application-scope guard failed:", file=sys.stderr)
        for problem in sorted(set(problems)):
            print(f"  - {problem}", file=sys.stderr)
        return 1

    print("AGH application-scope guard passed (MorphoGBM checkpoint verified).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
