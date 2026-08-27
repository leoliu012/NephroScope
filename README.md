# NephroScope

NephroScope is a small, single-server viewer for renal microscopy images. It
started life as the AGH Image Viewer, which is why quite a few paths and
environment variables still begin with `AGH_`.

The everyday workflow is fairly simple: pick a case, open a TIFF or ND2 file,
adjust the channels, and add or review annotations. The app can also queue a
MorphoGBM segmentation run and measure GBM thickness inside a hand-drawn ROI.
Model output is saved per Z slice so it can be reviewed later instead of being
treated as a one-off preview.

This is research software. The segmentation and thickness measurements have
not been validated for diagnosis or treatment decisions.

## What is in here

- A React/Vite viewer for multi-channel images, Z stacks, annotations, and PDF
  export.
- A Flask API for image access, user sessions, annotation revisions, audit
  events, and analysis jobs.
- A separate PyTorch worker for MorphoGBM inference. Gunicorn never loads the
  model itself.
- A sync worker that mirrors finished `.tif`, `.tiff`, and `.nd2` files from a
  mounted source into the server's local image cache.
- Apache and systemd files for the current deployment.

The source images are read-only from the application's point of view. Display
windowing, channel colors, contrast adjustment, and model preprocessing do not
rewrite the original file.

## Local setup

There is no sample dataset in the repository. Put at least one image under a
case directory before expecting much from the UI:

```text
backend/.local_data/AGH_APP/
  example-case/
    image.tif
```

Set up and start the API:

```bash
cd backend
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt

AGH_LOCAL_DEV=1 python manage_users.py add me
AGH_LOCAL_DEV=1 python app.py
```

`manage_users.py` prompts for a password. Local auth is enabled by default, so
an empty account store otherwise looks a lot like a broken login page.

In a second terminal, start Vite:

```bash
cd frontend
npm ci
npm run dev
```

Open <http://localhost:5173/agh/>. The `/agh/` suffix matters; it is the base
path used by both local Vite and the Apache deployment.

### Running the model locally

Normal viewing and annotation do not need PyTorch. For segmentation, install
the inference dependencies into the same development virtualenv and run the
worker in another terminal:

```bash
cd backend
. .venv/bin/activate
pip install torch==2.12.1 torchvision==0.27.1 \
  --index-url https://download.pytorch.org/whl/cpu
pip install -r requirements-inference.txt
AGH_LOCAL_DEV=1 python worker.py
```

The API only queues the job. If the worker is not running, the job will remain
queued rather than silently falling back to an in-process model.

## Repository layout

```text
frontend/            React viewer
backend/agh_api/      Flask application package
backend/worker.py     model job worker
backend/sync_images.py
                     mounted-folder sync worker
backend/models/       deployed checkpoint and checksum
infra/                Apache and systemd configuration
docs/                 the details that used to make this README enormous
```

For the backend data layout, each direct child of `AGH_DATA_ROOT` is a case:

```text
/data/AGH_APP/<case>/<image>.tif
/data/agh_annotations/<sha256-image-id>.json
```

## Production shape

```text
mounted image source
        |
        | agh_image_sync
        v
local image cache <-- Flask/Gunicorn <-- Apache /agh/api
        |                                  Apache /agh serves the React build
        |
        +--> SQLite job queue --> MorphoGBM worker --> saved mask/skeleton
```

The API binds to `127.0.0.1:5055` in production and is meant to sit behind
Apache. Authentication lives in Flask, not Apache Basic Auth. Annotation saves
are locked, atomic, and revision checked; a stale save gets `409 Conflict`
instead of overwriting somebody else's work.

Start with `.env.example` for the full list of settings. The ones most often
needed are:

| Variable | Purpose |
| --- | --- |
| `AGH_DATA_ROOT` | local case/image cache |
| `AGH_ANN_ROOT` | annotation JSON directory |
| `AGH_STATE_DIR` | accounts, sessions, audit log, and analysis state |
| `AGH_REMOTE_DATA_ROOT` | optional mounted, remote-authoritative image source |
| `AGH_MODEL_CHECKPOINT` | MorphoGBM checkpoint used by the worker |
| `AGH_INFERENCE_DEVICE` | `auto`, `cpu`, or `cuda` |

The deploy script copies the application and verified model asset. It does not
copy image data or create user accounts:

```bash
AGH_DEPLOY_REMOTE=ubuntu@example.org \
AGH_SSH_KEY_PATH=$HOME/.ssh/agh-deploy.pem \
python deploy.py
```

Use real values, obviously. `deploy.py` refuses the placeholders. The complete
server procedure, including account creation and the sync service, is in
[`docs/deployment.md`](docs/deployment.md).

## Checks

```bash
make app-scope-check   # checkpoint checksum and legacy-analysis guard
make backend-test
make frontend-test
make frontend-build

# everything above
make test
```

The frontend tests are small Node self-tests rather than a browser test suite.
That is enough for the pure channel/annotation/measurement helpers, but it does
not exercise a real TIFF in the canvas.

## A few rough edges

- `AGH_*`, `/agh/`, and a handful of `agh_*.service` names are historical. A
  rename would touch deployment state for no functional benefit, so they have
  been left alone.
- TIFF-oriented module names also handle ND2 now. That naming is similarly
  older than the feature.
- The application assumes one trusted server filesystem. File locks use
  `flock`, and the analysis queue uses local SQLite; this is not a distributed
  worker design.
- The pixel-size fallback is `0.106872 µm/px` when the image has no usable
  calibration metadata. The viewer labels the value as a default, but it is
  still worth checking before using a measurement.
- The model path is intentionally narrow: one supplied MorphoGBM v10 checkpoint
  with the validated v13 whole-image inference path around it. This is not a
  general model registry.

## More detail

- [`docs/architecture.md`](docs/architecture.md) — component boundaries and
  model data flow
- [`docs/model-inference.md`](docs/model-inference.md) — tiling, preprocessing,
  thresholds, and saved run metadata
- [`docs/deployment.md`](docs/deployment.md) — deployment and image sync
- [`docs/security.md`](docs/security.md) — accounts, roles, sessions, CSRF, and
  audit behavior
- [`docs/operations-runbook.md`](docs/operations-runbook.md) — routine checks
  and recovery notes
