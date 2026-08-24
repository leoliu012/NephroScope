#!/usr/bin/env python3
"""
deploy.py — Build and deploy NephroScope to the Magnify server.

Steps:
  1. Upload frontend source and build it on the server
  2. Copy built files       ->  /var/www/html/agh
  3. Copy backend           ->  /home/ubuntu/agh-viewer/backend
  4. Install Python deps in a venv
  5. Install model-inference deps in a separate venv
  6. Create state directories (accounts, sessions, segmentation jobs)
  7. Install / restart systemd services
  8. Install Apache config and run configtest

This script deploys application and model assets only. It does NOT handle credentials: accounts are
created on the server with backend/manage_users.py, so no password ever passes
through this deploy or the process table. Image data is likewise not deployed
here; the dedicated remote-cache sync service fills /data/AGH_APP.
"""
import hashlib
import os
import shlex
import subprocess
import sys
from pathlib import Path

shq = shlex.quote

HERE    = Path(__file__).parent
REMOTE  = os.environ.get("AGH_DEPLOY_REMOTE")
SSH_KEY = os.environ.get("AGH_SSH_KEY_PATH", "")
STRICT_HOST_KEY_CHECKING = os.environ.get("AGH_STRICT_HOST_KEY_CHECKING", "yes")
KNOWN_HOSTS = os.environ.get("AGH_KNOWN_HOSTS", "")
STATE_DIR = os.environ.get("AGH_STATE_DIR", "/home/ubuntu/agh-viewer/state")
PYTORCH_INDEX_URL = os.environ.get(
    "AGH_PYTORCH_INDEX_URL", "https://download.pytorch.org/whl/cpu"
)
MODEL_CHECKPOINT = HERE / "backend" / "models" / "morphogbm_v10_topology_robust_inference.pt"
MODEL_SHA256 = "a729ecc0036ddb6a52819dc92e93be43bd18d2ce8d472179a9fb92f0a76aec7f"


def fail(message):
    print(f"Configuration error: {message}")
    sys.exit(2)


def ssh_options():
    opts = [
        "-o", f"StrictHostKeyChecking={STRICT_HOST_KEY_CHECKING}",
        "-o", "ConnectTimeout=10",
    ]
    if SSH_KEY:
        opts.extend(["-i", SSH_KEY])
    if KNOWN_HOSTS:
        opts.extend(["-o", f"UserKnownHostsFile={KNOWN_HOSTS}"])
    return opts


if not REMOTE:
    fail("Set AGH_DEPLOY_REMOTE to the real server login, for example ubuntu@35.173.74.55")
if "example.org" in REMOTE or REMOTE.endswith("@your-server"):
    fail(f"AGH_DEPLOY_REMOTE is still a placeholder: {REMOTE}")
if SSH_KEY and not Path(SSH_KEY).expanduser().is_file():
    fail(f"AGH_SSH_KEY_PATH does not exist: {SSH_KEY}")
if KNOWN_HOSTS and not Path(KNOWN_HOSTS).expanduser().is_file():
    fail(f"AGH_KNOWN_HOSTS does not exist: {KNOWN_HOSTS}")

SSH = ["ssh", *ssh_options(), REMOTE]
SCP = ["scp", *ssh_options(), "-r"]

def run(cmd, **kw):
    print("▶", " ".join(cmd) if isinstance(cmd, list) else cmd)
    result = subprocess.run(cmd, shell=isinstance(cmd, str), **kw)
    if result.returncode != 0:
        print(f"  ✗ exit {result.returncode}")
        sys.exit(result.returncode)

def ssh(command):
    run(SSH + [command])

def scp(src, dest):
    run(SCP + [src, f"{REMOTE}:{dest}"])


def ensure_files(required, optional=None):
    missing = [str(path) for path in required if not path.exists()]
    if missing:
        fail("Missing required deploy files:\n  " + "\n  ".join(missing))
    return list(required) + [path for path in (optional or []) if path.exists()]


def file_sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


frontend_required = [
    HERE / "frontend" / "package.json",
    HERE / "frontend" / "vite.config.js",
    HERE / "frontend" / "index.html",
    HERE / "frontend" / "tailwind.config.js",
    HERE / "frontend" / "postcss.config.js",
]
frontend_optional = [HERE / "frontend" / "package-lock.json"]
backend_required = [
    HERE / "backend" / "app.py",
    HERE / "backend" / "manage_users.py",
    HERE / "backend" / "sync_images.py",
    HERE / "backend" / "worker.py",
    HERE / "backend" / "requirements.txt",
    HERE / "backend" / "requirements.lock.txt",
    HERE / "backend" / "requirements-inference.txt",
    MODEL_CHECKPOINT,
    HERE / "backend" / "agh_api",
    HERE / "backend" / "agh_backend.service",
    HERE / "backend" / "agh_analysis_worker.service",
    HERE / "backend" / "agh_image_sync.service",
    HERE / "infra" / "apache" / "agh-viewer.conf",
]
ensure_files(frontend_required, frontend_optional)
ensure_files(backend_required)
model_sha256 = file_sha256(MODEL_CHECKPOINT)
if model_sha256 != MODEL_SHA256:
    fail(
        "MorphoGBM checkpoint checksum mismatch: "
        f"expected {MODEL_SHA256}, found {model_sha256}"
    )

# ── 1. Upload frontend source to server and build there ──────────────────────
print("\n[1/8] Uploading frontend source to server...")
ssh("mkdir -p /home/ubuntu/agh-viewer/frontend && rm -rf /home/ubuntu/agh-viewer/frontend/src")

# Upload individual config files
for path in ensure_files(frontend_required, frontend_optional):
    scp(str(path), "/home/ubuntu/agh-viewer/frontend/")

# Upload src/ directory
scp(str(HERE / "frontend" / "src"), "/home/ubuntu/agh-viewer/frontend/")

print("\n[2/8] Building React frontend on server...")
ssh("cd /home/ubuntu/agh-viewer/frontend && "
    "if [ -f package-lock.json ]; then npm ci --no-fund --no-audit; "
    "else npm install --no-fund --no-audit; fi && npm run build")

# ── 2. Deploy frontend build ──────────────────────────────────────────────────
print("\n[3/8] Copying frontend build to /var/www/html/agh...")
ssh("sudo mkdir -p /var/www/html/agh && sudo chown ubuntu:ubuntu /var/www/html/agh && "
    "cp -r /home/ubuntu/agh-viewer/frontend/dist/. /var/www/html/agh/")

# ── 3. Deploy backend ─────────────────────────────────────────────────────────
print("\n[4/8] Copying backend and model to /home/ubuntu/agh-viewer/backend...")
ssh("mkdir -p /home/ubuntu/agh-viewer/backend && "
    "rm -rf /home/ubuntu/agh-viewer/backend/agh_api /home/ubuntu/agh-viewer/backend/models")
scp(str(HERE / "backend" / "app.py"),          "/home/ubuntu/agh-viewer/backend/")
scp(str(HERE / "backend" / "manage_users.py"), "/home/ubuntu/agh-viewer/backend/")
scp(str(HERE / "backend" / "sync_images.py"), "/home/ubuntu/agh-viewer/backend/")
scp(str(HERE / "backend" / "worker.py"), "/home/ubuntu/agh-viewer/backend/")
scp(str(HERE / "backend" / "requirements.txt"),"/home/ubuntu/agh-viewer/backend/")
scp(str(HERE / "backend" / "requirements.lock.txt"),"/home/ubuntu/agh-viewer/backend/")
scp(str(HERE / "backend" / "requirements-inference.txt"),"/home/ubuntu/agh-viewer/backend/")
scp(str(HERE / "backend" / "agh_api"),         "/home/ubuntu/agh-viewer/backend/")
scp(str(HERE / "backend" / "models"),          "/home/ubuntu/agh-viewer/backend/")

print("\n  Installing Python dependencies on server...")
ssh("python3 -m venv /home/ubuntu/agh-viewer/venv && "
    "/home/ubuntu/agh-viewer/venv/bin/python -m pip install -U pip && "
    "/home/ubuntu/agh-viewer/venv/bin/pip install -q -r /home/ubuntu/agh-viewer/backend/requirements.lock.txt")

print("\n[5/8] Installing MorphoGBM inference dependencies...")
ssh("python3 -m venv /home/ubuntu/agh-viewer/inference-venv && "
    "/home/ubuntu/agh-viewer/inference-venv/bin/python -m pip install -U pip && "
    "/home/ubuntu/agh-viewer/inference-venv/bin/pip install -q "
    f"--index-url {shq(PYTORCH_INDEX_URL)} torch==2.12.1 torchvision==0.27.1 && "
    "/home/ubuntu/agh-viewer/inference-venv/bin/pip install -q "
    "-r /home/ubuntu/agh-viewer/backend/requirements-inference.txt")

# ── 4. Create the auth state directory (accounts + sessions) ─────────────────
print("\n[6/8] Preparing application state directories...")
ssh(f"mkdir -p {shq(STATE_DIR)}/sessions {shq(STATE_DIR)}/analysis/runs && "
    f"chmod 700 {shq(STATE_DIR)} {shq(STATE_DIR)}/sessions {shq(STATE_DIR)}/analysis")

# ── 5. Install / restart systemd services ────────────────────────────────────
print("\n[7/8] Installing systemd services...")
scp(str(HERE / "backend" / "agh_backend.service"), "/tmp/agh_backend.service")
scp(str(HERE / "backend" / "agh_analysis_worker.service"), "/tmp/agh_analysis_worker.service")
scp(str(HERE / "backend" / "agh_image_sync.service"), "/tmp/agh_image_sync.service")
ssh("sudo cp /tmp/agh_backend.service /tmp/agh_analysis_worker.service "
    "/tmp/agh_image_sync.service /etc/systemd/system/ && "
    "sudo systemctl daemon-reload && "
    "sudo systemctl enable agh_backend && "
    "sudo systemctl restart agh_backend && "
    "sudo systemctl enable agh_analysis_worker && "
    "sudo systemctl restart agh_analysis_worker && "
    "sudo systemctl enable agh_image_sync && "
    "if [ -f /etc/agh-viewer/image-sync.env ]; then sudo systemctl restart agh_image_sync; fi")
# The health endpoint is public (no credentials), so this needs no auth.
ssh("sleep 2 && curl -fsS http://127.0.0.1:5055/agh/api/health")

# ── 6. Install Apache config ─────────────────────────────────────────────────
print("\n[8/8] Installing Apache config for /agh...")
scp(str(HERE / "infra" / "apache" / "agh-viewer.conf"), "/tmp/agh-viewer.conf")
ssh("sudo cp /tmp/agh-viewer.conf /etc/apache2/conf-available/agh-viewer.conf && "
    "sudo a2enmod proxy proxy_http headers >/dev/null && "
    "sudo a2enconf agh-viewer >/dev/null && "
    "sudo apache2ctl configtest && "
    "sudo systemctl reload apache2")

print("\nDeployment complete.")
print("  App: /agh/")
print("  API: /agh/api/health")
print("")
print("Create the first account on the server (you will be prompted for a password):")
print(f"  ssh {REMOTE} \\")
print(f"    'cd /home/ubuntu/agh-viewer/backend && AGH_STATE_DIR={STATE_DIR} \\")
print("     /home/ubuntu/agh-viewer/venv/bin/python manage_users.py add <username>'")
print("Then sign in at /agh/ with that username and password.")
