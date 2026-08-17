#!/usr/bin/env python3
"""Run the single-process MorphoGBM analysis queue worker."""
from __future__ import annotations

import argparse
import logging
import os
from pathlib import Path
import socket
import threading
import time
import uuid

from agh_api.analysis_store import AnalysisStore, LeaseLost
from agh_api.audit import AuditLog
from agh_api.config import Config
from agh_api.errors import APIError
from agh_api.segmentation_service import OPERATION, execute_segmentation


log = logging.getLogger("agh-analysis-worker")


def worker_config():
    local_dev = os.environ.get("AGH_LOCAL_DEV", "").lower() in {"1", "true", "yes"}
    if local_dev or "AGH_DATA_ROOT" not in os.environ:
        return Config.local_dev(Path(__file__).resolve().parent)
    return Config.from_env()


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Run queued MorphoGBM segmentation jobs")
    parser.add_argument("--once", action="store_true", help="process at most one queued run")
    args = parser.parse_args(argv)
    logging.basicConfig(
        level=os.environ.get("AGH_ANALYSIS_LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    config = worker_config()
    config.ensure_directories()
    store = AnalysisStore(config.analysis_db, config.analysis_lease_seconds)
    worker_id = f"{socket.gethostname()}-{os.getpid()}-{uuid.uuid4().hex[:12]}"

    while True:
        job = store.claim_next_run(worker_id)
        if job is None:
            if args.once:
                return 0
            time.sleep(config.analysis_poll_seconds)
            continue

        run_id = job["runId"]
        log.info("Running %s job %s for %s/%s", job["operation"], run_id, job["case"], job["filename"])
        stop_heartbeat = threading.Event()
        lease_lost = threading.Event()
        heartbeat = threading.Thread(
            target=_heartbeat_loop,
            args=(store, run_id, worker_id, stop_heartbeat, lease_lost),
            daemon=True,
            name=f"analysis-heartbeat-{run_id[:8]}",
        )
        heartbeat.start()
        progress = _progress_reporter(store, run_id, worker_id, lease_lost)

        try:
            if job["operation"] != OPERATION:
                raise ValueError(f"Unknown analysis operation: {job['operation']}")
            result = execute_segmentation(
                config,
                job,
                progress=progress,
                before_publish=lambda: _require_ownership(store, run_id, worker_id, lease_lost),
            )
            _require_ownership(store, run_id, worker_id, lease_lost)
            store.mark_succeeded(run_id, worker_id, result)
            _record_audit(config, job, result="success", details={"model": result.get("modelId")})
            log.info("Segmentation job %s succeeded", run_id)
        except LeaseLost:
            log.warning("Stopped publishing stale analysis attempt for %s after its lease was lost", run_id)
        except Exception as exc:
            public_message = _public_error(exc)
            log.exception("Segmentation job %s failed", run_id)
            try:
                store.mark_failed(run_id, worker_id, public_message)
            except LeaseLost:
                log.warning("Could not mark %s failed because its lease was reclaimed", run_id)
            else:
                _record_audit(
                    config,
                    job,
                    result="failure",
                    details={"error": public_message},
                )
        finally:
            stop_heartbeat.set()
            heartbeat.join(timeout=5)

        if args.once:
            return 0


def _heartbeat_loop(store, run_id, worker_id, stop_event, lease_lost):
    interval = max(1.0, min(30.0, store.lease_seconds / 3.0))
    while not stop_event.wait(interval):
        try:
            store.heartbeat(run_id, worker_id)
        except LeaseLost:
            lease_lost.set()
            return
        except Exception:
            log.exception("Could not heartbeat analysis run %s", run_id)


def _progress_reporter(store, run_id, worker_id, lease_lost):
    last = {"time": 0.0, "stage": None, "percent": -1.0}

    def report(progress):
        if lease_lost.is_set():
            raise LeaseLost(f"Worker no longer owns analysis run {run_id}")
        now = time.monotonic()
        stage = progress.get("stage")
        percent = float(progress.get("percent") or 0.0)
        should_write = (
            stage != last["stage"]
            or percent >= 99.0
            or percent - last["percent"] >= 1.0
            or now - last["time"] >= 1.0
        )
        if not should_write:
            return
        store.update_progress(run_id, worker_id, progress)
        last.update({"time": now, "stage": stage, "percent": percent})

    return report


def _require_ownership(store, run_id, worker_id, lease_lost):
    if lease_lost.is_set() or not store.is_owner(run_id, worker_id):
        raise LeaseLost(f"Worker no longer owns analysis run {run_id}")


def _public_error(exc):
    if isinstance(exc, APIError):
        return exc.message
    message = str(exc)
    controlled_prefixes = (
        "MorphoGBM",
        "Source image changed",
        "Source Z geometry changed",
        "Extracted plane shape",
    )
    if message.startswith(controlled_prefixes):
        return message[:500]
    if isinstance(exc, FileNotFoundError) and message:
        return message[:500]
    return "Segmentation failed; see the server log for details"


def _record_audit(config, job, *, result, details):
    payload = {
        "runId": job["runId"],
        "zIndex": (job.get("request") or {}).get("zIndex"),
        "channelIndex": (job.get("request") or {}).get("channelIndex"),
        **details,
    }
    try:
        AuditLog(config.audit_log_file).record(
            action="SEGMENTATION",
            actor=job.get("requestedBy") or "system",
            result=result,
            case_id=job.get("case"),
            filename=job.get("filename"),
            details=payload,
        )
    except OSError:
        log.exception("Could not record segmentation audit event for %s", job["runId"])


if __name__ == "__main__":
    raise SystemExit(main())

