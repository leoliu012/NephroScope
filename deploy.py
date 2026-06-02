#!/usr/bin/env python3
"""
deploy.py — Build and deploy the AGH Viewer to the Magnify server.

Steps:
  1. Upload frontend source and build it on the server
  2. Copy built files       ->  /var/www/html/agh
  3. Copy backend           ->  /home/ubuntu/agh-viewer/backend
  4. Install Python deps in a venv
  5. Install Python inference deps in a separate venv
  6. Install / restart systemd services
  7. Install Apache config and run configtest

Image data is intentionally not deployed by this script. Use agh_watcher.py
or a dedicated sync job for NAS -> /data/AGH_APP.
"""
import os
import base64
import hashlib
import subprocess
import sys
import tempfile
from pathlib import Path

HERE    = Path(__file__).parent
REMOTE  = os.environ.get("AGH_DEPLOY_REMOTE")
SSH_KEY = os.environ.get("AGH_SSH_KEY_PATH", "")
STRICT_HOST_KEY_CHECKING = os.environ.get("AGH_STRICT_HOST_KEY_CHECKING", "yes")
KNOWN_HOSTS = os.environ.get("AGH_KNOWN_HOSTS", "")
BASIC_AUTH_USER = os.environ.get("AGH_BASIC_AUTH_USER", "")
BASIC_AUTH_PASSWORD = os.environ.get("AGH_BASIC_AUTH_PASSWORD", "")


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
if not BASIC_AUTH_USER or not BASIC_AUTH_PASSWORD:
    fail("Set AGH_BASIC_AUTH_USER and AGH_BASIC_AUTH_PASSWORD before deploying")
if ":" in BASIC_AUTH_USER or "\n" in BASIC_AUTH_USER:
    fail("AGH_BASIC_AUTH_USER must not contain ':' or newlines")

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


def write_htpasswd_file():
    digest = base64.b64encode(hashlib.sha1(BASIC_AUTH_PASSWORD.encode("utf-8")).digest()).decode("ascii")
    payload = f"{BASIC_AUTH_USER}:{{SHA}}{digest}\n"
    handle = tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False)
    with handle:
        handle.write(payload)
    return Path(handle.name)


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
    HERE / "backend" / "worker.py",
    HERE / "backend" / "requirements.lock.txt",
    HERE / "backend" / "requirements-inference.txt",
    HERE / "backend" / "agh_api",
    HERE / "backend" / "agh_backend.service",
    HERE / "backend" / "agh_analysis_worker.service",
    HERE / "infra" / "apache" / "agh-viewer.conf",
]
ensure_files(frontend_required, frontend_optional)
ensure_files(backend_required)

# ── 1. Upload frontend source to server and build there ──────────────────────
print("\n[1/7] Uploading frontend source to server...")
ssh("mkdir -p /home/ubuntu/agh-viewer/frontend && rm -rf /home/ubuntu/agh-viewer/frontend/src")

# Upload individual config files
for path in ensure_files(frontend_required, frontend_optional):
    scp(str(path), "/home/ubuntu/agh-viewer/frontend/")

# Upload src/ directory
scp(str(HERE / "frontend" / "src"), "/home/ubuntu/agh-viewer/frontend/")

print("\n[2/7] Building React frontend on server...")
ssh("cd /home/ubuntu/agh-viewer/frontend && "
    "if [ -f package-lock.json ]; then npm ci --no-fund --no-audit; "
    "else npm install --no-fund --no-audit; fi && npm run build")

# ── 2. Deploy frontend build ──────────────────────────────────────────────────
print("\n[3/7] Copying frontend build to /var/www/html/agh...")
ssh("sudo mkdir -p /var/www/html/agh && sudo chown ubuntu:ubuntu /var/www/html/agh && "
    "cp -r /home/ubuntu/agh-viewer/frontend/dist/. /var/www/html/agh/")

# ── 3. Deploy backend ─────────────────────────────────────────────────────────
print("\n[4/7] Copying backend to /home/ubuntu/agh-viewer/backend...")
ssh("mkdir -p /home/ubuntu/agh-viewer/backend && rm -rf /home/ubuntu/agh-viewer/backend/agh_api")
scp(str(HERE / "backend" / "app.py"),          "/home/ubuntu/agh-viewer/backend/")
scp(str(HERE / "backend" / "worker.py"),       "/home/ubuntu/agh-viewer/backend/")
scp(str(HERE / "backend" / "requirements.txt"),"/home/ubuntu/agh-viewer/backend/")
scp(str(HERE / "backend" / "requirements.lock.txt"),"/home/ubuntu/agh-viewer/backend/")
scp(str(HERE / "backend" / "requirements-inference.txt"),"/home/ubuntu/agh-viewer/backend/")
scp(str(HERE / "backend" / "agh_api"),         "/home/ubuntu/agh-viewer/backend/")

print("\n  Installing Python dependencies on server...")
ssh("python3 -m venv /home/ubuntu/agh-viewer/venv && "
    "/home/ubuntu/agh-viewer/venv/bin/python -m pip install -U pip && "
    "/home/ubuntu/agh-viewer/venv/bin/pip install -q -r /home/ubuntu/agh-viewer/backend/requirements.lock.txt")

# ── 4. Install inference dependencies ────────────────────────────────────────
print("\n[5/7] Installing inference dependencies on server...")
ssh("python3 -m venv /home/ubuntu/agh-viewer/inference-venv && "
    "/home/ubuntu/agh-viewer/inference-venv/bin/python -m pip install -U pip && "
    "/home/ubuntu/agh-viewer/inference-venv/bin/pip install -q -r /home/ubuntu/agh-viewer/backend/requirements-inference.txt")

# ── 5. Install / restart systemd services ────────────────────────────────────
print("\n[6/7] Installing systemd services...")
scp(str(HERE / "backend" / "agh_backend.service"), "/tmp/agh_backend.service")
scp(str(HERE / "backend" / "agh_analysis_worker.service"), "/tmp/agh_analysis_worker.service")
ssh("sudo cp /tmp/agh_backend.service /etc/systemd/system/ && "
    "sudo cp /tmp/agh_analysis_worker.service /etc/systemd/system/ && "
    "sudo systemctl daemon-reload && "
    "sudo systemctl enable agh_backend && "
    "sudo systemctl enable agh_analysis_worker && "
    "sudo systemctl restart agh_backend && "
    "sudo systemctl restart agh_analysis_worker")
ssh("sleep 2 && curl -fsS http://127.0.0.1:5055/agh/api/health")

# ── 6. Install Apache config ─────────────────────────────────────────────────
print("\n[7/7] Installing Apache config for /agh...")
auth_file = write_htpasswd_file()
try:
    scp(str(auth_file), "/tmp/agh-viewer.htpasswd")
finally:
    auth_file.unlink(missing_ok=True)
ssh("sudo install -o root -g www-data -m 0640 /tmp/agh-viewer.htpasswd /etc/apache2/.agh-viewer.htpasswd && "
    "rm -f /tmp/agh-viewer.htpasswd")
scp(str(HERE / "infra" / "apache" / "agh-viewer.conf"), "/tmp/agh-viewer.conf")
ssh("sudo cp /tmp/agh-viewer.conf /etc/apache2/conf-available/agh-viewer.conf && "
    "sudo a2enmod proxy proxy_http headers >/dev/null && "
    "sudo a2enconf agh-viewer >/dev/null && "
    "sudo apache2ctl configtest && "
    "sudo systemctl reload apache2")

print("\nDeployment complete.")
print("  App: /agh/")
print("  API: /agh/api/health")
