# NephroScope

NephroScope is a web application for viewing renal microscopy images, annotating
structures, and analyzing glomerular basement membrane (GBM) thickness with
machine-learning segmentation. It brings TIFF/ND2 viewing, MorphoGBM predictions,
ROI measurements, case comparisons, and image/report export into one workflow.

Segmentation and thickness measurements are for research use only and are not
validated for clinical diagnosis or treatment decisions.

## Key features

### 1. Multi-channel image viewing and annotation

Browse cases with image previews, open TIFF or ND2 images, and move through Z
slices. Adjust each channel's marker label, color, visibility, intensity window,
brightness, contrast, and inversion without changing the source image.

Pan and zoom, then add points, lines, arrows, rectangles, ellipses, freehand
outlines, editable text, or calibrated rulers. Annotation colors, stroke widths,
and text sizes are adjustable; revision checks protect against conflicting saves.
Pixel size comes from image metadata when available, with a visibly labeled
`0.106872 µm/px` fallback.

### 2. ML segmentation and ROI thickness measurement

Run MorphoGBM v10 on a selected channel and Z view to segment the GBM. Stack
analysis uses an up-to-five-plane maximum-intensity projection (Z-MIP).
Predictions are saved per Z slice and can be revisited or deleted individually.

Inspect the segmentation mask and saved thickness skeleton over the source image,
with adjustable overlay colors, mask opacity, and skeleton line width. Draw a
polygon ROI to measure average GBM thickness and compare observed values with
expansion-factor (EF) adjusted values using the current calibration.

### 3. In-viewer thickness analysis

Select **Run thickness analysis** to open the **Thickness** tab. Choose a channel
and Z sampling gap, then inspect the pooled image distribution or separate box
plots for each analyzed Z slice. Results include sample counts, quartiles, median,
whiskers, range, and outlier counts.

Matching saved segmentations are reused. Results retain their analysis calibration,
and the viewer flags settings that have changed since the analysis was run.

### 4. Compare thickness across cases and images

Open **Case analysis** to select cases and images, sample their Z slices, and
compare thickness distributions grouped by case, image, or image/Z slice.
Automatic selection uses the Post and 60X filename groups; manual selection is
available when a case has no matching images.

Change grouping, included images, units, or observed versus EF-adjusted thickness
to explore the results. Box-plot statistics use all saved full-mask centerline
samples, rather than averages of images or cases. Queued jobs continue after
leaving the page, and reopening it in the same browser restores the comparison.

### 5. Export images with analysis results

Export the current image as PDF, PNG, or JPEG, with optional annotations and
model overlays. Enable **Include thickness box plot and statistics** to include
the current Thickness tab results. PDF exports add report pages; PNG/JPEG exports
append the report below the image. Partial analyses are labeled in the report.

### 6. Configurable image sources and shared review

Admins can select **Administration → Project image folder** to read a folder
directly or synchronize a mounted source into a local cache. Per-user accounts,
roles, audit events, and revisioned annotations support shared review.

## Architecture

Apache serves the React build at `/agh/` and proxies `/agh/api/` to a Flask API
behind Gunicorn. A separate model worker processes segmentation jobs, and an
image-sync worker mirrors a mounted source folder when sync mode is enabled.

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

Admins can set **Administration → Project image folder** to either sync a source
folder into the local `AGH_DATA_ROOT` cache, or read a folder directly without
syncing. Both choices require a parent folder containing case subfolders, with
readable `.tif`, `.tiff`, or `.nd2` images directly inside the cases. The choice
persists in `AGH_SYNC_STATE_DIR/image-source.json` and takes effect without an
application restart. The API and workers must share the same `AGH_SYNC_STATE_DIR`.

Windows drive paths (for example `R:\AGH_APP`) and UNC shares are accepted when
accessible through a WSL mount; the Linux mount path (such as `/mnt/r/AGH_APP`)
also works. Mount the drive or share with access for the backend service user first.

Sync mode requires the separate `agh_image_sync` service described in
[the deployment guide](docs/deployment.md#data-sync). It synchronizes only final
`.tif`, `.tiff`, and `.nd2` files every 24 hours or on an admin-requested run.
Saving a sync folder queues a run; the remote folder is authoritative. The worker
stays idle in direct mode. Environment paths remain the defaults until an admin
saves a folder choice.

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

## Analysis workflow details

Open **Case analysis** from the files-browser header. Automatic selection uses
the files browser's Post and 60X filename groups. Cases with no matching images
say so and offer manual selection. Compact case cards can be folded without
changing checked images; their headers show selection counts.

The Z-gap slider runs all
slices at 0; gap 1 skips one slice (Z1, Z3, Z5), up to gap 8. Each image can
override the batch gap. If the stack is too short for two samples, its middle
slice is used (the upper middle for an even stack). Runs use the existing model's
up-to-five-plane Z-MIP. Verify each image's channel and pixel-size/EF settings
before starting; calibration defaults match the image viewer.

The model worker must be running. Queued runs continue when the page closes;
reopening Case analysis in the same browser restores the last comparison and
resumes pending submissions and progress. Box-plot quartiles use every saved
full-mask centerline thickness sample, including repeated values, rather than
image or case averages. Displayed dots are representative; the statistics use
all samples. Comparisons can change grouping, image inclusion, units, observed
versus EF-adjusted thickness, and whether the axis focuses on the IQR whiskers.

The opened image viewer also has **Run thickness analysis**, which opens the
**Thickness** side tab. Choose a channel and Z gap, then run to view the pooled
full-image distribution or separate boxes for each analyzed Z slice, with
point counts, quartiles, median, whiskers, range, and outlier counts. Results
retain the analysis calibration; changes to channel, pixel size, EF, or gap are
identified until another analysis applies them. Per-image progress can resume
after reopening and does not replace the separate Case analysis comparison.

In the existing **Export** window, check **Include thickness box plot and
statistics**. The current Thickness tab grouping, units, and completed samples
are included, with partial analyses labeled explicitly. PDF adds report pages;
PNG/JPEG append the report below the image. This works even when the Thickness
tab is hidden. Very large combined image reports should use PDF.

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
