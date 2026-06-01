# Architecture

AGH Image Viewer is a single-server research tool. The first professionalization step is to harden the simple architecture rather than replace it with a distributed system.

## Components

```text
apps/web equivalent: frontend/
  React + Vite viewer served as static files under /agh/

apps/api equivalent: backend/
  Flask application factory in agh_api/
  Gunicorn binds to 127.0.0.1:5055

sync-agent equivalent: agh_watcher.py
  Runs on a Windows machine with NAS access
  Uploads TIFF files to the server over SSH/SCP

infra/
  Apache and systemd configuration owned by the repo
```

## API Responsibilities

- `path_guard.py`: validates case and filename boundaries.
- `tiff_service.py`: normalizes TIFF axes, creates metadata, renders channel PNGs, and writes thumbnails.
- `annotation_service.py`: validates, revision-checks, and atomically writes annotation JSON.
- `file_lock.py`: provides `fcntl.flock()` based locks for cache and annotation writes on a single Linux server.
- `__init__.py`: application factory and route wiring.

## Data Safety

The API does not trust URL paths. Cases must be direct children of `AGH_DATA_ROOT`; files must be direct TIFF files inside a known case. Annotation writes are protected by per-image file locks and use `os.replace()` so interrupted writes do not leave half-written JSON as the active file.

## Performance

The first request for a channel renders all channel PNGs and a thumbnail into `AGH_CACHE_ROOT`. Cache rendering is protected by a per-cache-key file lock, so parallel channel requests do not decode the same cold TIFF multiple times. Later requests serve cached PNGs. Metadata is read from TIFF series metadata when possible and does not require loading all pixel data.

## Access Control

Production Apache config requires Basic Auth for `/agh` and `/agh/api`. The API listens on `127.0.0.1:5055` behind Apache; it should not be directly exposed.
