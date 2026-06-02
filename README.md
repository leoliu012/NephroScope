# AGH Image Viewer

Web-based multi-channel microscopy image viewer for AGH TIFF images and JSON annotations.

The project intentionally stays simple: Apache serves the React build at `/agh/`, proxies `/agh/api/` to a Flask API running behind Gunicorn, and a Windows sync agent uploads TIFFs from the CMU NAS to the server.

## Architecture

```text
CMU NAS
  |
  | agh_watcher.py on a Windows lab machine
  | reconciliation + retry + temp upload + atomic rename
  v
AWS / Lightsail
  |
  | /data/AGH_APP          raw TIFF files
  | /data/agh_annotations  revisioned annotation JSON
  | /data/agh_cache        metadata, channel PNGs, thumbnails
  |
  | Apache /agh            React static build
  | Apache /agh/api        reverse proxy
  v
Gunicorn -> Flask agh_api on 127.0.0.1:5055
```

## Server Data Layout

```text
/data/AGH_APP/
  case1/
    image.tif

/data/agh_annotations/
  <sha256-image-id>.json

/data/agh_cache/
  <cache-key>/
    metadata.json
    channel_0.png
    thumbnail.png
```

Cache keys include image relative path, file size, and mtime. If a TIFF changes, the cache automatically misses and regenerates.

## Configuration

Copy `.env.example` and set the values for your machine or service manager.

Backend:

```bash
export AGH_DATA_ROOT=/data/AGH_APP
export AGH_ANN_ROOT=/data/agh_annotations
export AGH_CACHE_ROOT=/data/agh_cache
export AGH_ANALYSIS_ROOT=/data/agh_analysis
export AGH_MODEL_ROOT=/data/agh_models
export AGH_ANALYSIS_DB=/data/agh_analysis/jobs.sqlite3
export AGH_HOST=127.0.0.1
export AGH_PORT=5055
```

Watcher:

```powershell
$env:AGH_NAS_ROOT="T:\Ha\AGH_APP"
$env:AGH_REMOTE_HOST="agh-upload@example.org"
$env:AGH_REMOTE_DIR="/data/AGH_APP"
$env:AGH_SSH_KEY_PATH="C:\Users\you\.ssh\agh-upload.pem"
$env:AGH_KNOWN_HOSTS="C:\Users\you\.ssh\known_hosts"
$env:AGH_STRICT_HOST_KEY_CHECKING="yes"
```

Deployment:

```bash
export AGH_DEPLOY_REMOTE=ubuntu@example.org
export AGH_SSH_KEY_PATH=$HOME/.ssh/agh-deploy.pem
export AGH_STRICT_HOST_KEY_CHECKING=yes
export AGH_BASIC_AUTH_USER=agh-lab
export AGH_BASIC_AUTH_PASSWORD='choose-a-real-password'
```

Replace `ubuntu@example.org`, the key path, and the Basic Auth password with real values. The deploy script exits early if these are still placeholders, if the key file does not exist, or if Basic Auth credentials are missing.

## Backend

Run locally:

```bash
cd backend
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
python app.py
```

Run the analysis worker locally in another shell:

```bash
cd backend
. .venv/bin/activate
python worker.py --once   # process one queued run, useful for debugging
python worker.py          # continuous worker loop
```

For real MagnifySeg inference, create a separate inference environment and install:

```bash
cd backend
python3 -m venv ../inference-venv
../inference-venv/bin/pip install -r requirements-inference.txt
```

When `python app.py` is run directly without `AGH_DATA_ROOT`, it uses writable local development folders under `backend/.local_data/`. Production remains configured by systemd environment variables and uses `/data/...`.

If you previously exported production paths in the same terminal and see a `/data` permission error, clear them or force local mode:

```bash
unset AGH_DATA_ROOT AGH_ANN_ROOT AGH_CACHE_ROOT
python app.py

# or
AGH_LOCAL_DEV=1 python app.py
```

Production runs with Gunicorn:

```bash
gunicorn --bind 127.0.0.1:5055 --workers 2 --threads 4 --timeout 120 "agh_api:create_app()"
```

Health check:

```bash
curl http://127.0.0.1:5055/agh/api/health
```

## API

Current compatible endpoints:

```text
GET  /agh/api/health
GET  /agh/api/cases
GET  /agh/api/cases/:case/files
GET  /agh/api/cases/:case/files/:filename/meta
GET  /agh/api/cases/:case/files/:filename/thumbnail
GET  /agh/api/cases/:case/files/:filename/channel/:channelIndex
GET  /agh/api/cases/:case/files/:filename/annotations
PUT  /agh/api/cases/:case/files/:filename/annotations
POST /agh/api/cases/:case/files/:filename/annotations
POST /agh/api/cases/:case/files/:filename/analysis-runs
GET  /agh/api/analysis-runs/:runId
GET  /agh/api/analysis-runs/:runId/artifacts/:artifact
POST /agh/api/analysis-runs/:runId/metrics/gbm-thickness
POST /agh/api/analysis-runs/:runId/metrics/process-nnd
```

The API now rejects path traversal, only serves direct TIFF files inside known case folders, and only allows `.tif` / `.tiff`.

Annotation writes are locked, atomic, and revisioned. A stale save returns `409 Conflict` instead of silently overwriting another user's work. `PUT` requests must include `revision`; `POST` remains only for legacy compatibility.

MagnifySeg analysis runs are queued in SQLite and processed by `backend/worker.py`.
The queue currently uses `magnifyseg-segmentation`, `gbm-thickness`, and `process-nnd`
operations. Metric POST endpoints return a queued run id; poll
`GET /agh/api/analysis-runs/:runId` for completion.
Segmentation defaults to `preprocessingMode: percentile-stretch`: TIFF planes are
stretched with 1.0-99.7 percentiles, written as uint8 model inputs, and
`run_patches()` scales them by `1/255`. This matches the MagnifySeg
`auto_enhance_single_channel` / `auto_enhance_multi_channel` flow and does not
perform max-normalization before the percentile stretch. `direct-uint8` remains
available as an explicit comparison mode.
The API stores immutable segmentation artifacts under `AGH_ANALYSIS_ROOT/runs/<run-id>/`
and metric artifacts under `AGH_ANALYSIS_ROOT/runs/<segmentation-run-id>/metrics/<metric-run-id>/`.
Real segmentation requires the four model weights in `AGH_MODEL_ROOT`:
`ACTN4.hdf5`, `DAPI.hdf5`, `NHS_ester_single.hdf5`, and `NHS_ester_com.hdf5`.
Make sure these are real Git LFS files, not pointer text files.

## Watcher

Install once on the Windows lab machine:

```powershell
pip install watchdog
```

Before first run, pin the server host key in `known_hosts` using your lab-approved process. Do not disable host key checking for routine operation.

Run:

```powershell
python .\agh_watcher.py
```

The watcher combines three protections:

- realtime polling events for new and modified TIFFs;
- startup and periodic reconciliation using `relative_path + size + mtime`;
- upload to `*.uploading` followed by remote atomic rename.
- source file signature comparison before and after upload, so files that change during SCP are retried.

Use a dedicated upload user such as `agh-upload`. That account should write only to a staging or data directory and should not be a general-purpose admin account.

## Deployment

`deploy.py` deploys only the application. It does not copy `/data/AGH_APP`.

```bash
AGH_DEPLOY_REMOTE=ubuntu@example.org \
AGH_SSH_KEY_PATH=$HOME/.ssh/agh-deploy.pem \
AGH_BASIC_AUTH_USER=agh-lab \
AGH_BASIC_AUTH_PASSWORD='choose-a-real-password' \
python deploy.py
```

Those values are placeholders. Use the real server address and the real SSH key path from your Lightsail setup.

The script uploads the frontend source, builds it on the server, uploads the backend package, installs locked backend dependencies into `/home/ubuntu/agh-viewer/venv`, installs `backend/agh_backend.service`, creates the Apache Basic Auth password file, installs `infra/apache/agh-viewer.conf`, runs `apache2ctl configtest`, and reloads Apache.

## Tests

Backend tests:

```bash
make backend-test
```

Frontend build:

```bash
make frontend-build
```

Both:

```bash
make test
```

## Viewer Features

- Case and TIFF browser
- TIFF metadata, channel PNG rendering, and thumbnail preview
- Multi-channel canvas composition
- Pan and zoom
- Point, line, arrow, rectangle, ellipse, freehand, and text annotations
- Revisioned annotation save with conflict detection
- PDF export with or without annotation overlay
