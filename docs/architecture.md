# Architecture

AGH Image Viewer is a single-server research tool. The first professionalization step is to harden the simple architecture rather than replace it with a distributed system.

## Components

```text
apps/web equivalent: frontend/
  React + Vite viewer served as static files under /agh/

apps/api equivalent: backend/
  Flask application factory in agh_api/
  Gunicorn binds to 127.0.0.1:5055

sync-agent equivalent: backend/sync_images.py
  Runs beside the backend and reads the mounted remote image folder
  Mirrors final TIFF/ND2 files into the local AGH_DATA_ROOT cache
  Tracks file identities in SQLite so remote renames are local renames

infra/
  Apache and systemd configuration owned by the repo
```

## API Responsibilities

- `path_guard.py`: validates case and filename boundaries.
- `tiff_service.py`: reads TIFF metadata and physical pixel calibration, transcodes the first source plane to browser-viewable PNG, and exposes selected immutable raw channel planes for browser-side display controls without MIP or scientific intensity preprocessing.
- `annotation_service.py`: validates, revision-checks, and atomically writes annotation JSON.
- `file_lock.py`: provides `fcntl.flock()` based locks for annotation writes on a single Linux server.
- `__init__.py`: application factory and route wiring.

## Data Safety

The API does not trust URL paths. Cases must be direct children of `AGH_DATA_ROOT`; files must be direct TIFF files inside a known case. Annotation writes are protected by per-image file locks and use `os.replace()` so interrupted writes do not leave half-written JSON as the active file.

## Performance

Metadata is read from TIFF series metadata when possible and does not require loading all pixel data. Physical pixel size is read from OME-XML, ImageJ metadata, or TIFF resolution tags when available; otherwise the API reports the explicit default `0.106872 µm/px`. Image display uses the source TIFF as the authority. The case-browser preview and the opened-image viewer both retrieve immutable 8-bit or 16-bit raw channel planes. The browser applies the same automatic min/max windowing and reversible viewer-only marker colors, brightness, contrast, visibility, and polarity inversion in both contexts. The backend does not apply MIP, normalization, percentile stretch, contrast enhancement, or pseudocolor mapping. Unsupported formats are rejected rather than silently converted.

## Access Control

Authentication is enforced by the Flask API (per-user accounts, session cookies, CSRF), not by Apache Basic Auth. The API listens on `127.0.0.1:5055` behind Apache; it should not be directly exposed.



## Deliberately Excluded Features

The active application does not include model inference, segmentation, derived metrics, watershed processing, preprocessing controls, an analysis queue, or an analysis worker. Those concerns belong in a separate analysis application if they are needed again later.

Run `make viewer-only-check` before committing. The guard rejects known legacy analysis files and active-source references so those concerns do not drift back into this repository.
