#!/usr/bin/env python3
"""Fail when legacy image-analysis code drifts back into the viewer-only app."""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

OBSOLETE_PATHS = (
    "backend/worker.py",
    "backend/agh_analysis_worker.service",
    "backend/agh_api/analysis_profiles.py",
    "backend/agh_api/analysis_service.py",
    "backend/agh_api/analysis_store.py",
    "backend/agh_api/job_queue.py",
    "backend/agh_api/model_registry.py",
    "backend/agh_api/processing_service.py",
    "backend/tests/test_analysis_api.py",
    "frontend/src/analysis.js",
    "frontend/src/components/AnalysisPanel.jsx",
    "frontend/src/components/AnalysisWorkspace.jsx",
    "frontend/src/components/ContourOverlay.jsx",
    "frontend/src/components/MetricsPanel.jsx",
    "frontend/src/components/SegmentationOverlay.jsx",
)

ACTIVE_SOURCE_ROOTS = (
    ROOT / "backend" / "agh_api",
    ROOT / "frontend" / "src",
)

ACTIVE_SOURCE_FILES = (
    ROOT / "deploy.py",
)

SOURCE_SUFFIXES = {".py", ".js", ".jsx", ".ts", ".tsx"}
FORBIDDEN_SOURCE_PATTERNS = (
    ("watershed processing", re.compile(r"\bwatershed\b", re.IGNORECASE)),
    ("contour processing", re.compile(r"\bcontours?\b", re.IGNORECASE)),
    ("segmentation processing", re.compile(r"\bsegmentation\b", re.IGNORECASE)),
    ("analysis API route", re.compile(r"/agh/api(?:/v1)?/analysis(?:/|[\"'])", re.IGNORECASE)),
    ("metrics API route", re.compile(r"/agh/api(?:/v1)?/metrics(?:/|[\"'])", re.IGNORECASE)),
    ("legacy analysis import", re.compile(r"\b(?:analysis_profiles|analysis_service|analysis_store|analysis_queue)\b", re.IGNORECASE)),
    ("legacy analysis worker service", re.compile(r"\bagh_analysis_worker\b", re.IGNORECASE)),
)


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


def main() -> int:
    problems: list[str] = []

    for relative in OBSOLETE_PATHS:
        if (ROOT / relative).exists():
            problems.append(f"obsolete viewer-only path still exists: {relative}")

    for marker in sorted(ROOT.glob(".last_*_patch_backup")):
        problems.append(f"stale root patch marker still exists: {marker.name}")

    for path in source_files():
        relative = path.relative_to(ROOT)
        text = path.read_text(encoding="utf-8", errors="replace")
        for label, pattern in FORBIDDEN_SOURCE_PATTERNS:
            if pattern.search(text):
                problems.append(f"{label} reference found in active source: {relative}")

    if problems:
        print("Viewer-only source guard failed:", file=sys.stderr)
        for problem in sorted(set(problems)):
            print(f"  - {problem}", file=sys.stderr)
        return 1

    print("Viewer-only source guard passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
