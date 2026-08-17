# Deployment

Deployment and image synchronization are separate flows.

## Application Deployment

Set:

```bash
export AGH_DEPLOY_REMOTE=ubuntu@example.org
export AGH_SSH_KEY_PATH=$HOME/.ssh/agh-deploy.pem
export AGH_STRICT_HOST_KEY_CHECKING=yes
export AGH_STATE_DIR=/home/ubuntu/agh-viewer/state   # optional; this is the default
# Optional: choose the matching official CUDA index on a supported GPU host.
export AGH_PYTORCH_INDEX_URL=https://download.pytorch.org/whl/cpu
```

Replace every placeholder with real values before deploying. `deploy.py`
deploys application code plus the repository-owned inference checkpoint; it
never handles passwords. Accounts are created
separately with `manage_users.py` (see below), so no credential ever passes
through the deploy or the process table.

Then run:

```bash
python deploy.py
```

The script:

1. uploads frontend source;
2. runs `npm ci` or `npm install` on the server;
3. copies the Vite build to `/var/www/html/agh`;
4. uploads backend code, the worker service, and the checksum-verified v10
   inference checkpoint;
5. installs locked Python dependencies into `/home/ubuntu/agh-viewer/venv`;
6. installs PyTorch/timm/scientific inference dependencies into the separate
   `/home/ubuntu/agh-viewer/inference-venv`;
7. creates the auth and segmentation state directories (`$AGH_STATE_DIR`,
   mode 700);
8. restarts `agh_backend`, `agh_analysis_worker`, and the configured image-sync
   service;
9. installs `infra/apache/agh-viewer.conf`, runs `apache2ctl configtest`, and
   reloads Apache.

## Creating Accounts

There is no shared password. Each person gets an individual account whose
password is stored only as a salted PBKDF2 hash. Create the first account on
the server:

```bash
ssh ubuntu@example.org \
  'cd /home/ubuntu/agh-viewer/backend && AGH_STATE_DIR=/home/ubuntu/agh-viewer/state \
   /home/ubuntu/agh-viewer/venv/bin/python manage_users.py add alice'
```

You will be prompted for the password twice; it is never taken from the
command line. Other subcommands: `passwd`, `disable`, `enable`, `remove`,
`list`. See `docs/security.md` for the full account and session model.

## Data Sync

The API always reads the local cache at `AGH_DATA_ROOT` (normally
`/data/AGH_APP`). It never reads source images from the network mount.

Configure the mounted remote folder on the host that runs the backend. For a
Windows drive exposed to WSL, that is typically a path such as
`/mnt/r/AGH_APP`; a backend on another Linux host must mount the same share
there (or at another local path) itself. Create the following file with owner
`root` and mode `600`:

```ini
# /etc/agh-viewer/image-sync.env
AGH_REMOTE_DATA_ROOT=/mnt/r/AGH_APP
AGH_SYNC_STATE_DIR=/home/ubuntu/agh-viewer/state/localdata-sync
AGH_SYNC_INTERVAL_SECONDS=86400
AGH_SYNC_POLL_SECONDS=15
AGH_SYNC_FINGERPRINT_MB=4
```

Then enable the included worker:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now agh_image_sync
systemctl status agh_image_sync
```

The worker runs once at startup, then every 24 hours. Admins can queue a run
from **Administration → Image sync → Sync now**; the worker notices that
request within `AGH_SYNC_POLL_SECONDS`. The status endpoint and button do not
scan the mounted folder, so viewing images stays local and responsive.

Only final `.tif`, `.tiff`, and `.nd2` files are mirrored, with a
case-insensitive check. Hidden/temp names and common `.partial`, `.part`,
`.tmp`, `.upload`, and `.inprogress` uploads are ignored. Publish uploads by
atomically renaming a completed temporary file to its final extension.

The remote folder is authoritative: files removed remotely are removed from
the local cache. `sync-index.sqlite` in `AGH_SYNC_STATE_DIR` tracks size,
mtime, endpoint fingerprint, and sync time. A matching fingerprint at a new
remote path is renamed locally with `os.replace()` instead of transferred;
ambiguous fingerprints fall back to a complete SHA-256 comparison.

Application deploys must not upload `/data/AGH_APP`.

## Production Process

The API should run as:

```text
Apache (TLS) -> Gunicorn on 127.0.0.1:5055 -> Flask agh_api
                                              |
                                              +-> SQLite model-run queue

agh_analysis_worker (single process) -> MorphoGBM v10 checkpoint -> run artifacts
```

Gunicorn serves status, mask, and ROI-measurement requests but never imports
PyTorch. The dedicated worker owns one model instance and survives API restarts
through the durable queue under `$AGH_STATE_DIR/analysis`.

Do not expose port `5055` directly to the public internet.

Authentication is enforced by the Flask API: per-user accounts, an HttpOnly
session cookie issued at login, and a CSRF token on state-changing requests.
Apache must **not** add `AuthType Basic` for `/agh` or `/agh/api`, otherwise
browsers show their native credential popup ahead of the app's login screen.
Apache forwards `X-Forwarded-Proto` so the backend marks the session cookie
`Secure` when the client connection is HTTPS; serve the app over HTTPS
(a TLS vhost, or WireGuard/Tailscale) in production.
