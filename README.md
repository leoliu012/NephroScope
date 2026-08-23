# AGH Image Viewer

Web-based microscopy image viewer for AGH TIFF images and JSON annotations.

The viewer supports adjustable annotation color and stroke thickness, editable text annotations with font sizing, and calibrated ruler measurements. Pixel size is read from TIFF metadata when available; otherwise the viewer uses the explicit default calibration `0.106872 µm/px` and marks it as a default in the bottom status bar.

The project intentionally stays simple: Apache serves the React build at `/agh/`, proxies `/agh/api/` to a Flask API running behind Gunicorn, and a separate worker mirrors a mounted remote image folder into the local cache.

## Architecture

```text
Mounted remote image folder
  |
  | agh_image_sync service
  | remote-authoritative cache sync + rename detection
  v
Backend host
  |
  | /data/AGH_APP          raw TIFF files
  | /data/agh_annotations  revisioned annotation JSON
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
```

## Configuration

Copy `.env.example` and set the values for your machine or service manager.

Backend:

```bash
export AGH_DATA_ROOT=/data/AGH_APP
export AGH_ANN_ROOT=/data/agh_annotations
export AGH_HOST=127.0.0.1
export AGH_PORT=5055
```

Remote image cache sync:

```bash
# The remote share must be mounted on the backend host.
export AGH_REMOTE_DATA_ROOT=/mnt/r/AGH_APP
export AGH_SYNC_STATE_DIR=/home/ubuntu/agh-viewer/state/localdata-sync
export AGH_SYNC_INTERVAL_SECONDS=86400
```

Deployment:

```bash
export AGH_DEPLOY_REMOTE=ubuntu@example.org
export AGH_SSH_KEY_PATH=$HOME/.ssh/agh-deploy.pem
export AGH_STRICT_HOST_KEY_CHECKING=yes
export AGH_STATE_DIR=/home/ubuntu/agh-viewer/state   # optional; this is the default
```

Replace `ubuntu@example.org` and the key path with real values. The deploy
script exits early if these are still placeholders or if the key file does not
exist. It deploys application and model assets only — accounts are created separately with
`manage_users.py` (see Accounts below), so no password passes through the
deploy.

## Backend

Run locally:

```bash
cd backend
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
python app.py
```

When `python app.py` is run directly without `AGH_DATA_ROOT`, it uses writable local development folders under `backend/.local_data/`. Production remains configured by systemd environment variables and uses `/data/...`.

Model runs need the separate inference dependency set and worker. For local
development it is fine to install both sets into the same project virtualenv,
then keep the API and worker in separate terminals:

```bash
cd backend
. .venv/bin/activate
pip install torch==2.12.1 torchvision==0.27.1 \
  --index-url https://download.pytorch.org/whl/cpu
pip install -r requirements-inference.txt
AGH_LOCAL_DEV=1 python app.py

# second terminal, same virtualenv
cd backend
AGH_LOCAL_DEV=1 python worker.py
```

Production deployment creates `venv` for the web API and `inference-venv` for
the single model worker so Gunicorn never imports PyTorch. Deployment uses the
official CPU wheel index by default; set `AGH_PYTORCH_INDEX_URL` to the matching
official CUDA index when the worker host has a supported NVIDIA GPU.

If you previously exported production paths in the same terminal and see a `/data` permission error, clear them or force local mode:

```bash
unset AGH_DATA_ROOT AGH_ANN_ROOT
python app.py

# or
AGH_LOCAL_DEV=1 python app.py
```

Local development defaults to `AGH_AUTH_REQUIRED=1` with an empty account
store, so create a dev account first (state lives under
`backend/.local_data/state`):

```bash
cd backend
AGH_LOCAL_DEV=1 python manage_users.py add me
# then run the app and sign in at the SPA login screen
```

Accounts have roles. New accounts default to `annotator`; assign a narrower or
broader role with:

```bash
AGH_LOCAL_DEV=1 python manage_users.py add reviewer1 --role reviewer
AGH_LOCAL_DEV=1 python manage_users.py role reviewer1 viewer
```

Supported roles are `admin`, `reviewer`, `pathologist`, `annotator`, `viewer`,
and `upload_agent`. Audit events are written as JSONL to
`AGH_AUDIT_LOG_FILE` or, by default, under the configured state directory.

To skip login entirely while developing on a private loopback-only setup, set
both variables below. Do not use this when exposing the app through ngrok,
Tailscale, Apache, or any other network tunnel/proxy.

```bash
export AGH_AUTH_REQUIRED=0
export AGH_ALLOW_INSECURE_AUTH_BYPASS=I_UNDERSTAND_THIS_EXPOSES_DATA
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

Current endpoints:

```text
GET  /agh/api/health                 (public)
GET  /agh/api/session                 (public; reports whether you are signed in)
POST /agh/api/login                   (public; {username, password})
POST /agh/api/logout
GET  /agh/api/cases
GET  /agh/api/cases/:case/files
GET  /agh/api/cases/:case/files/:filename/meta
GET  /agh/api/cases/:case/files/:filename/image
GET  /agh/api/cases/:case/files/:filename/preview
GET  /agh/api/cases/:case/files/:filename/channels/:channelIndex/raw
GET  /agh/api/cases/:case/files/:filename/annotations
PUT  /agh/api/cases/:case/files/:filename/annotations   (requires X-AGH-CSRF)
```

The API rejects path traversal, only serves direct TIFF files inside known case folders, and only allows `.tif` / `.tiff`.

Authentication is per-user. The login page posts the username and password to
`/agh/api/login`; on success the server sets an HttpOnly, SameSite=Strict
session cookie and returns a CSRF token the SPA echoes in the `X-AGH-CSRF`
header on writes. Passwords are stored only as salted PBKDF2 hashes and are
never kept in the browser. Apache must not protect `/agh/` or `/agh/api` with
`AuthType Basic`. See `docs/security.md` for the full model and account
management.

Annotation writes are locked, atomic, and revisioned. A stale save returns `409 Conflict` instead of silently overwriting another user's work. Annotation updates use `PUT` and must include `revision`. The `updatedBy` field is stamped from the authenticated session, so it cannot be forged.

## Remote image cache sync

The production image source is always the local `AGH_DATA_ROOT` cache. To use
a mounted remote drive, configure `AGH_REMOTE_DATA_ROOT` and run the separate
`agh_image_sync` service described in [the deployment guide](docs/deployment.md#data-sync).
It synchronizes only final `.tif`, `.tiff`, and `.nd2` files every 24 hours
(or on an admin-requested run) without making normal image viewing wait for
the network. The remote folder is authoritative.

## Deployment

`deploy.py` deploys only the application. It does not copy `/data/AGH_APP`.

```bash
AGH_DEPLOY_REMOTE=ubuntu@example.org \
AGH_SSH_KEY_PATH=$HOME/.ssh/agh-deploy.pem \
python deploy.py
```

Those values are placeholders. Use the real server address and the real SSH key path from your Lightsail setup.

The script uploads and builds the frontend, uploads the backend and verified v10
checkpoint, installs the web and inference virtualenvs, prepares application
state, installs the API/model/image-sync services, validates Apache, and reloads
it. Create accounts afterwards with `manage_users.py` (see `docs/security.md`).

## Tests

Application-scope and model-checksum guard:

```bash
make app-scope-check
```

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
- Bounded auto-adjusted TIFF previews in the case browser; the TIFF source is never modified
- Per-channel marker / antibody mapping, visibility, display color, min/max windowing, brightness, contrast, and black/white inversion
- Pan and zoom
- Point, line, arrow, rectangle, ellipse, freehand, text, and calibrated ruler annotations
- Adjustable annotation color, stroke thickness, and text size
- Pixel calibration from image metadata with a visible `0.106872 µm/px` fallback
- Revisioned annotation save with conflict detection
- PDF export with or without annotation overlay
- MorphoGBM v10 GBM segmentation for the current Z view, with a five-plane
  Z-MIP for stacks and the supplied fluorescence contrast enhancement
- Client-adjustable segmentation overlay color, visibility, and opacity
- Exact saved GBM thickness-skeleton overlay with independent visibility,
  color, and rendered line-width controls
- Persistent per-Z predictions with running/segmented Z labels and explicit
  per-slice deletion
- Polygon ROI measurement of average GBM thickness using full-mask
  skeleton/Euclidean-distance geometry, showing both observed and
  EF-adjusted values that follow the current pixel-size/EF settings

## Raw Display and Model Analysis Contract

Normal image display remains source-preserving: opening or adjusting an image
never modifies the TIFF/ND2 source. Model runs are explicit, asynchronous
research operations. They read one chosen source channel, form an up-to-five
slice Z-MIP around the current Z for stacks, and apply the supplied per-image
1st/99.7th-percentile uint8 contrast stretch only to the inference copy.

The deployed checkpoint is MorphoGBM v10. Whole-image prediction follows the
validated v13 notebook teacher path around that v10 model: 32-pixel halo
context, overlapping 576-pixel cores, D4 test-time averaging, Gaussian
stitching, and the v13-selected hysteresis rule. A dedicated single worker owns
the PyTorch model so web requests do not load duplicate models or time out.
Every successful run records its source version, channel/Z window,
preprocessing contract, model checksum, and inference settings.
See [`docs/model-inference.md`](docs/model-inference.md) for the exact mapping
from the supplied notebooks/scripts to the deployed pipeline.

The backend retains a simple raw PNG endpoint for compatibility. The case browser now uses a bounded, versioned PNG preview so remote users do not download every full-resolution raw channel just by selecting an image. Opening the editor still loads immutable raw channel planes and applies reversible display-only controls without changing the TIFF. Supported raw channel formats are 8-bit or 16-bit unsigned grayscale planes. Files that would require intensity conversion are rejected with an explicit error rather than silently normalized.

Segmentation and thickness values are for research use only and are not
validated for clinical diagnosis or treatment decisions.
