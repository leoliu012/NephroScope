"""
AGH Viewer Backend entrypoint.

The production service should run this app through Gunicorn:
    gunicorn --bind 127.0.0.1:5055 "agh_api:create_app()"
"""
import os
from pathlib import Path

from agh_api import create_app
from agh_api.config import Config


def _entrypoint_config():
    local_dev = os.environ.get("AGH_LOCAL_DEV", "").lower() in {"1", "true", "yes"}
    if local_dev or (__name__ == "__main__" and "AGH_DATA_ROOT" not in os.environ):
        return Config.local_dev(Path(__file__).resolve().parent)
    return Config.from_env()


config = _entrypoint_config()
app = create_app(config)


if __name__ == "__main__":
    app.run(host=config.host, port=config.port, debug=False)
