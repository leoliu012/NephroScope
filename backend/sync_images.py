#!/usr/bin/env python3
"""Run the remote-mounted-folder image cache synchronizer.

The systemd service runs this continuously.  ``--once`` is useful when
validating a mount or running a maintenance sync by hand.
"""
import argparse
import logging
import os
from pathlib import Path

from agh_api.config import Config
from agh_api.image_sync import RemoteImageSync, RemoteImageSyncService, SyncConfigurationError


def _config() -> Config:
    local_dev = os.environ.get("AGH_LOCAL_DEV", "").lower() in {"1", "true", "yes"}
    if local_dev:
        return Config.local_dev(Path(__file__).resolve().parent)
    return Config.from_env()


def main() -> int:
    parser = argparse.ArgumentParser(description="Mirror AGH_REMOTE_DATA_ROOT into AGH_DATA_ROOT")
    parser.add_argument("--once", action="store_true", help="perform one synchronization pass and exit")
    args = parser.parse_args()
    logging.basicConfig(level=os.environ.get("AGH_SYNC_LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    config = _config()
    try:
        if args.once:
            logging.getLogger(__name__).info("Running one image synchronization pass")
            RemoteImageSync(config).sync_once(reason="command")
            logging.getLogger(__name__).info("Image synchronization pass finished successfully")
        else:
            logging.getLogger(__name__).info("Starting image synchronization service")
            RemoteImageSyncService(config).run_forever()
    except SyncConfigurationError as exc:
        logging.getLogger(__name__).error("Image sync is not configured: %s", exc)
        return 2
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
