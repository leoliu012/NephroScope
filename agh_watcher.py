"""
agh_watcher.py
==============
Monitors the NAS AGH_APP folder for new/changed TIFF files and automatically
uploads them to the remote server.

Requirements:
    pip install watchdog

Run:
    python agh_watcher.py

To run silently at Windows startup, create a Task Scheduler entry that calls:
    pythonw agh_watcher.py
with log output redirected to agh_watcher.log (see LOG_FILE below).
"""

import json
import os
import posixpath
import shlex
import sys
import time
import logging
import subprocess
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Dict

from watchdog.observers.polling import PollingObserver
from watchdog.events import FileSystemEventHandler

# -- Configuration -----------------------------------------------------------

SCRIPT_DIR = Path(__file__).resolve().parent

NAS_ROOT = Path(os.environ.get("AGH_NAS_ROOT", r"T:\Ha\AGH_APP"))
SERVER = os.environ.get("AGH_REMOTE_HOST", "agh-upload@example.org")
SERVER_DIR = os.environ.get("AGH_REMOTE_DIR", "/data/AGH_APP")
SSH_KEY = os.environ.get("AGH_SSH_KEY_PATH", "")
KNOWN_HOSTS = os.environ.get("AGH_KNOWN_HOSTS", "")
STRICT_HOST_KEY_CHECKING = os.environ.get("AGH_STRICT_HOST_KEY_CHECKING", "yes")

DEBOUNCE_SECS = int(os.environ.get("AGH_DEBOUNCE_SECONDS", "15"))
POLL_INTERVAL = int(os.environ.get("AGH_POLL_INTERVAL", "30"))
RECONCILE_INTERVAL = int(os.environ.get("AGH_RECONCILE_INTERVAL", "300"))
MAX_BACKOFF = int(os.environ.get("AGH_MAX_RETRY_BACKOFF", "300"))

TIFF_EXTS = {".tif", ".tiff"}
LOG_FILE = Path(os.environ.get("AGH_LOG_FILE", SCRIPT_DIR / "agh_watcher.log"))
STATE_FILE = Path(os.environ.get("AGH_STATE_FILE", SCRIPT_DIR / ".agh_watcher_state.json"))

# -- Logging -----------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s  %(levelname)-7s %(message)s',
    handlers=[
        logging.FileHandler(LOG_FILE, encoding='utf-8'),
        logging.StreamHandler(sys.stdout),
    ]
)
log = logging.getLogger('agh_watcher')


# -- Helpers -----------------------------------------------------------------


def _ssh_base():
    cmd = ["ssh"]
    if SSH_KEY:
        cmd.extend(["-i", SSH_KEY])
    cmd.extend([
        "-o", "BatchMode=yes",
        "-o", f"StrictHostKeyChecking={STRICT_HOST_KEY_CHECKING}",
    ])
    if KNOWN_HOSTS:
        cmd.extend(["-o", f"UserKnownHostsFile={KNOWN_HOSTS}"])
    cmd.append(SERVER)
    return cmd


def _scp_base():
    cmd = ["scp"]
    if SSH_KEY:
        cmd.extend(["-i", SSH_KEY])
    cmd.extend([
        "-o", "BatchMode=yes",
        "-o", f"StrictHostKeyChecking={STRICT_HOST_KEY_CHECKING}",
    ])
    if KNOWN_HOSTS:
        cmd.extend(["-o", f"UserKnownHostsFile={KNOWN_HOSTS}"])
    return cmd


def _ssh(command):
    """Run a command on the remote server via SSH."""
    cmd = _ssh_base() + [command]
    return subprocess.run(cmd, capture_output=True, text=True)


def _scp_file(local, remote_path):
    """SCP a local file to an exact remote path."""
    cmd = _scp_base() + [str(local), f"{SERVER}:{shlex.quote(remote_path)}"]
    return subprocess.run(cmd, capture_output=True, text=True)


def _wait_for_stable_size(path: Path, pause=3, max_wait=120):
    """Wait until a file's size stops changing (i.e. it has finished writing)."""
    last_size = -1
    waited = 0
    while waited < max_wait:
        try:
            size = path.stat().st_size
        except OSError:
            return False
        if size == last_size and size > 0:
            return True
        last_size = size
        time.sleep(pause)
        waited += pause
    log.warning('Timed out waiting for %s to stabilise', path.name)
    return True  # upload anyway


def _is_tiff(path: Path):
    return path.is_file() and path.suffix.lower() in TIFF_EXTS


def _iter_tiffs(directory: Path):
    try:
        for child in directory.rglob("*"):
            if _is_tiff(child):
                yield child
    except OSError as exc:
        log.warning("Could not scan %s: %s", directory, exc)


def _rel(path: Path):
    return path.relative_to(NAS_ROOT)


def _remote_path_for(local_path: Path):
    rel = _rel(local_path)
    return posixpath.join(SERVER_DIR, *rel.parts)


def _remote_quote(path: str):
    return shlex.quote(path)


def _file_signature(path: Path):
    st = path.stat()
    return {"size": st.st_size, "mtime_ns": st.st_mtime_ns}


def _same_or_child(path: Path, parent: Path):
    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def upload_file(local_path: Path):
    """Upload one TIFF using a remote temp file followed by atomic rename."""
    try:
        remote_final = _remote_path_for(local_path)
    except ValueError:
        log.warning('Path %s is outside NAS_ROOT, skipping', local_path)
        return False

    if not _is_tiff(local_path):
        return None

    log.info("Uploading file: %s", local_path)
    if not _wait_for_stable_size(local_path):
        return None

    try:
        signature_before = _file_signature(local_path)
    except OSError as exc:
        log.warning("Could not stat %s before upload: %s", local_path, exc)
        return None

    remote_dir = posixpath.dirname(remote_final)
    remote_tmp = f"{remote_final}.{uuid.uuid4().hex}.uploading"

    mkdir = _ssh(f"mkdir -p {_remote_quote(remote_dir)}")
    if mkdir.returncode != 0:
        log.error("Remote mkdir failed for %s\n%s", remote_dir, mkdir.stderr.strip())
        return None

    copied = _scp_file(local_path, remote_tmp)
    if copied.returncode != 0:
        log.error("SCP failed for %s\n%s", local_path, copied.stderr.strip())
        _ssh(f"rm -f {_remote_quote(remote_tmp)}")
        return None

    renamed = _ssh(f"mv -f {_remote_quote(remote_tmp)} {_remote_quote(remote_final)}")
    if renamed.returncode != 0:
        log.error("Remote rename failed for %s\n%s", local_path, renamed.stderr.strip())
        return None

    try:
        signature_after = _file_signature(local_path)
    except OSError as exc:
        log.warning("Could not stat %s after upload: %s", local_path, exc)
        return None

    if signature_before != signature_after:
        log.warning("File changed during upload, scheduling retry: %s", local_path)
        return None

    log.info("OK  %s", local_path.name)
    return signature_after


class StateStore:
    def __init__(self, path: Path):
        self.path = path
        self.files: Dict[str, dict] = {}

    def load(self):
        try:
            with self.path.open("r", encoding="utf-8") as f:
                data = json.load(f)
            self.files = data.get("files", {})
        except FileNotFoundError:
            self.files = {}
        except Exception as exc:
            log.warning("Could not read state file %s: %s", self.path, exc)
            self.files = {}

    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(f".{self.path.name}.{os.getpid()}.tmp")
        payload = {"version": 1, "files": self.files}
        with tmp.open("w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2, sort_keys=True)
            f.write("\n")
        os.replace(tmp, self.path)

    def changed(self, path: Path):
        rel = _rel(path).as_posix()
        try:
            sig = _file_signature(path)
        except OSError:
            return False
        return self.files.get(rel) != sig

    def mark_uploaded(self, path: Path, signature=None):
        rel = _rel(path).as_posix()
        self.files[rel] = signature or _file_signature(path)


@dataclass
class PendingTask:
    path: Path
    last_event: float
    attempts: int = 0
    next_attempt: float = 0


# -- Event handler ------------------------------------------------------------

class AGHHandler(FileSystemEventHandler):
    """Debounced handler: queues events, uploads after DEBOUNCE_SECS of quiet."""

    def __init__(self, state: StateStore):
        self.state = state
        self._pending: Dict[str, PendingTask] = {}

    def _queue(self, path: str):
        p = Path(path)
        if p.is_dir():
            self._queue_case_dir(p)
        elif p.suffix.lower() in TIFF_EXTS:
            self.queue_file(p)

    def _queue_case_dir(self, path: Path):
        try:
            rel = _rel(path)
        except ValueError:
            return
        if not rel.parts:
            return
        case_dir = NAS_ROOT / rel.parts[0]
        key = str(case_dir)
        for pending_key in list(self._pending.keys()):
            if _same_or_child(Path(pending_key), case_dir):
                del self._pending[pending_key]
        self._pending[key] = PendingTask(case_dir, time.time())
        log.info("Queued case reconciliation: %s", case_dir.name)

    def queue_file(self, path: Path):
        try:
            rel = _rel(path)
        except ValueError:
            return
        if not rel.parts:
            return
        case_dir = NAS_ROOT / rel.parts[0]
        if str(case_dir) in self._pending:
            log.debug("Skipping child event because case is pending: %s", path.name)
            return
        key = str(path)
        if key not in self._pending:
            log.debug("Queued: %s", path.name)
        self._pending[key] = PendingTask(path, time.time())

    def on_created(self, event):
        self._queue(event.src_path)

    def on_modified(self, event):
        self._queue(event.src_path)

    def on_moved(self, event):
        # A "move into" on SMB often looks like a rename from temp name
        self._queue(event.dest_path)

    def flush(self):
        """Called periodically; uploads anything that has been quiet long enough."""
        now = time.time()
        ready = [
            key for key, task in self._pending.items()
            if now - task.last_event >= DEBOUNCE_SECS and now >= task.next_attempt
        ]
        for key in ready:
            task = self._pending.pop(key)
            ok = self._upload_task(task)
            self.state.save()
            if ok:
                continue
            task.attempts += 1
            delay = min(MAX_BACKOFF, 10 * (2 ** min(task.attempts, 5)))
            task.next_attempt = time.time() + delay
            task.last_event = time.time() - DEBOUNCE_SECS
            self._pending[key] = task
            log.warning("Retrying %s in %d seconds", task.path, delay)

    def _upload_task(self, task: PendingTask):
        path = task.path
        if path.is_dir():
            ok = True
            for file_path in _iter_tiffs(path):
                if not self.state.changed(file_path):
                    continue
                uploaded_signature = upload_file(file_path)
                if uploaded_signature:
                    self.state.mark_uploaded(file_path, uploaded_signature)
                else:
                    ok = False
            return ok

        if not path.exists():
            log.warning("Queued file disappeared, skipping: %s", path)
            return True
        if not self.state.changed(path):
            log.info("Unchanged, skipping: %s", path.name)
            return True
        uploaded_signature = upload_file(path)
        if uploaded_signature:
            self.state.mark_uploaded(path, uploaded_signature)
            return True
        return False


def reconcile(handler: AGHHandler):
    """Queue files whose size/mtime differs from the local upload manifest."""
    log.info("Reconciling NAS tree...")
    queued = 0
    for file_path in _iter_tiffs(NAS_ROOT):
        if handler.state.changed(file_path):
            handler.queue_file(file_path)
            queued += 1
    log.info("Reconciliation queued %d changed TIFF(s)", queued)


# -- Main ---------------------------------------------------------------------

def main():
    nas = Path(NAS_ROOT)
    if not nas.exists():
        log.error('Cannot reach NAS path: %s', NAS_ROOT)
        log.error('Make sure you are on the CMU network (or VPN) and the share is mounted.')
        sys.exit(1)

    state = StateStore(STATE_FILE)
    state.load()
    handler = AGHHandler(state)
    reconcile(handler)

    # PollingObserver is required for SMB/NAS — inotify doesn't work on network drives
    observer = PollingObserver(timeout=POLL_INTERVAL)
    observer.schedule(handler, str(nas), recursive=True)
    observer.start()

    log.info('AGH Watcher started')
    log.info('  Watching : %s', NAS_ROOT)
    log.info('  Server   : %s:%s', SERVER, SERVER_DIR)
    log.info('  State    : %s', STATE_FILE)
    log.info('  Poll     : every %d s   Debounce: %d s', POLL_INTERVAL, DEBOUNCE_SECS)
    log.info('Press Ctrl+C to stop.\n')

    next_reconcile = time.time() + RECONCILE_INTERVAL
    try:
        while True:
            time.sleep(2)
            handler.flush()
            if time.time() >= next_reconcile:
                reconcile(handler)
                next_reconcile = time.time() + RECONCILE_INTERVAL
    except KeyboardInterrupt:
        log.info('Stopping watcher...')
    finally:
        observer.stop()
        observer.join()
        log.info('AGH Watcher stopped.')


if __name__ == '__main__':
    main()
