# Architecture

AGH Image Viewer is a single-server research tool. Its image-serving and model
paths are deliberately separated so ordinary viewing stays source-preserving
and long-running inference cannot tie up the web process.

## Components

```text
frontend/
  React + Vite viewer served as static files under /agh/

backend/agh_api/
  Flask API; Gunicorn binds to 127.0.0.1:5055

backend/sync_images.py
  Mirrors finalized TIFF/ND2 files from the mounted source into AGH_DATA_ROOT

backend/worker.py
  Single-process MorphoGBM worker; claims durable SQLite jobs and atomically
  publishes immutable masks

infra/
  Apache and systemd configuration owned by the repository
```

## API Responsibilities

- `path_guard.py` validates case and image boundaries;
  `analysis_artifacts.py` separately confines UUID run artifacts.
- `tiff_service.py` reads TIFF/ND2 metadata and physical calibration, exposes
  immutable planes for browser display, and provides explicit channel/Z-MIP
  extraction only for queued model runs.
- `annotation_service.py` validates, revision-checks, and atomically writes
  annotation JSON.
- `analysis_store.py` implements the SQLite queue, leases, duplicate-run reuse,
  progress, and immutable terminal records.
- `analysis_routes.py` exposes authenticated run, mask, and ROI-thickness APIs.
- `morphogbm_v10.py` reconstructs the supplied checkpoint and implements the
  selected v13 halo/D4 whole-image inference contract around that v10 model.
- `gbm_thickness.py` implements full-mask skeleton and Euclidean-distance ROI
  thickness.
- `file_lock.py` provides `fcntl.flock()` locks for single-server writes.
- `__init__.py` is the application factory and route wiring.

## Model Data Flow

```text
source TIFF/ND2 (read-only)
  -> selected NHS-ester channel
  -> current plane, or up-to-five-plane shifted Z-MIP
  -> supplied 1st/99.7th-percentile uint8 contrast stretch
  -> raw/log1p/sqrt standardized model channels
  -> v10 ConvNeXt-Pico residual U-Net
  -> 32 px halo + 576 px overlapping cores + D4 mean + Gaussian stitching
  -> v13-selected low/high hysteresis mask
  -> immutable binary PNG + cached thickness geometry
  -> client-side color/opacity overlay and polygon ROI sampling
```

The checkpoint, source identity, channel, actual Z window, preprocessing
version, inference settings, and postprocessing rule are recorded with each
successful run.

## Data Safety

The API does not trust URL paths. Cases must be direct children of
`AGH_DATA_ROOT`; files must be supported direct image files inside a known case.
Annotation writes use file locks and `os.replace()`. Model artifacts are
confined to UUID run directories and are atomically published before a run can
be marked successful. Source images are never rewritten.

## Performance

Metadata reads avoid full pixel loads where possible. Browser display retrieves
immutable raw planes and applies reversible colors/windowing locally. Model
preprocessing occurs only after a user queues a run. A dedicated worker keeps
PyTorch memory and tiled D4 inference outside the two-worker Gunicorn process.
SQLite WAL mode allows status polling while that worker writes progress.

## Access Control

Authentication is enforced by Flask using per-user sessions and CSRF, not by
Apache Basic Auth. Viewing, queuing a model run, retrieving its mask, and making
a local ROI measurement require the existing `view` permission. Actor identity
comes from the authenticated session and run/measurement events are audited.
The API listens only on `127.0.0.1:5055` behind Apache.

## Deliberately Narrow Analysis Scope

The app contains only the supplied MorphoGBM v10 GBM mask and its
notebook-defined ROI thickness method. It does not restore the older generic
MagnifySeg/TensorFlow stack, stain profiles, watershed/degrouping, arbitrary
model registries, or general-purpose processing controls.

Run `make app-scope-check` before committing. The guard verifies the exact
checkpoint checksum and rejects known legacy analysis code.
