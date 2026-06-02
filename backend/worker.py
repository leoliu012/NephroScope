#!/usr/bin/env python3
import argparse
import logging
import os
import socket
import time
import uuid
from pathlib import Path

from agh_api.analysis_service import execute_analysis, execute_gbm_thickness, execute_process_nnd
from agh_api.analysis_store import AnalysisStore
from agh_api.config import Config


log = logging.getLogger("agh-analysis-worker")


def _worker_config():
    local_dev = os.environ.get("AGH_LOCAL_DEV", "").lower() in {"1", "true", "yes"}
    if local_dev or "AGH_DATA_ROOT" not in os.environ:
        return Config.local_dev(Path(__file__).resolve().parent)
    return Config.from_env()


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true", help="Process at most one queued analysis run")
    args = parser.parse_args(argv)

    logging.basicConfig(level=os.environ.get("AGH_LOG_LEVEL", "INFO"))
    config = _worker_config()
    config.ensure_directories()
    store = AnalysisStore(config.analysis_db)
    worker_id = f"{socket.gethostname()}-{os.getpid()}-{uuid.uuid4()}"
    recovered = store.recover_stale_running()
    if recovered:
        log.warning("Marked %s stale RUNNING analysis jobs as FAILED", recovered)
    poll_seconds = float(os.environ.get("AGH_ANALYSIS_WORKER_POLL_SECONDS", "1"))

    while True:
        job = store.claim_next_run(worker_id=worker_id)
        if job is None:
            if args.once:
                return 0
            time.sleep(poll_seconds)
            continue

        log.info("Running %s job %s for %s/%s", job["operation"], job["runId"], job["case"], job["filename"])
        try:
            store.heartbeat(job["runId"])
            result = _execute_job(config, store, job)
            store.mark_succeeded(job["runId"], result)
            log.info("%s job %s succeeded", job["operation"], job["runId"])
        except Exception as exc:
            log.exception("%s job %s failed", job["operation"], job["runId"])
            store.mark_failed(job["runId"], str(exc))

        if args.once:
            return 0


def _execute_job(config, store, job):
    if job["operation"] == "magnifyseg-segmentation":
        return execute_analysis(config, store, job)
    if job["operation"] == "gbm-thickness":
        return execute_gbm_thickness(config, store, job)
    if job["operation"] == "process-nnd":
        return execute_process_nnd(config, store, job)
    raise ValueError(f"Unknown analysis operation: {job['operation']}")


if __name__ == "__main__":
    raise SystemExit(main())
