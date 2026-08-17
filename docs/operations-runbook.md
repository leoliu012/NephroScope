# Operations Runbook

## Health

```bash
curl -fsS http://127.0.0.1:5055/agh/api/health
sudo systemctl status agh_backend
sudo journalctl -u agh_backend -f
sudo systemctl status agh_analysis_worker
sudo journalctl -u agh_analysis_worker -f
```

## Restart API

```bash
sudo systemctl restart agh_backend
```

## MorphoGBM Worker

The API queues runs in SQLite; only `agh_analysis_worker` loads PyTorch and the
checkpoint. Restarting the API does not discard queued work. Verify the exact
asset and restart the worker with:

```bash
cd /home/ubuntu/agh-viewer/backend
sha256sum -c models/morphogbm_v10_topology_robust_inference.pt.sha256
sudo systemctl restart agh_analysis_worker
sudo journalctl -u agh_analysis_worker -n 100
```

For a one-job diagnostic outside systemd:

```bash
cd /home/ubuntu/agh-viewer/backend
AGH_STATE_DIR=/home/ubuntu/agh-viewer/state \
  /home/ubuntu/agh-viewer/inference-venv/bin/python worker.py --once
```

Masks and job records live below `$AGH_STATE_DIR/analysis`; source TIFF/ND2
files are read-only. A failed run reports a sanitized error in the viewer while
the worker traceback remains in the system journal.

## Dependency Check

If opening an ND2 file reports `ND2 support is not installed on this server`,
install the locked backend dependencies into the same virtualenv used by the
systemd service, then restart the API:

```bash
cd /home/ubuntu/agh-viewer/backend
/home/ubuntu/agh-viewer/venv/bin/python -m pip install -r requirements.lock.txt
/home/ubuntu/agh-viewer/venv/bin/python -c "import nd2; print(nd2.__version__)"
sudo systemctl restart agh_backend
```

Inference dependencies are intentionally isolated from the web virtualenv:

```bash
cd /home/ubuntu/agh-viewer/backend
/home/ubuntu/agh-viewer/inference-venv/bin/python -m pip install \
  torch==2.12.1 torchvision==0.27.1 \
  --index-url https://download.pytorch.org/whl/cpu
/home/ubuntu/agh-viewer/inference-venv/bin/python -m pip install \
  -r requirements-inference.txt
/home/ubuntu/agh-viewer/inference-venv/bin/python -c \
  "import torch, timm, scipy, skimage; print(torch.__version__, timm.__version__)"
sudo systemctl restart agh_analysis_worker
```

## Apache Check

```bash
sudo apache2ctl configtest
sudo systemctl reload apache2
```

## Annotation Backup

Back up `/data/agh_annotations` before backend upgrades that change annotation behavior:

```bash
sudo tar -C /data -czf /data/agh_annotations-$(date +%Y%m%d-%H%M%S).tgz agh_annotations
```

## Remote Image Sync Recovery

Check that the remote share is mounted on the backend host, then inspect and
restart the cache worker:

```bash
systemctl status agh_image_sync
sudo journalctl -u agh_image_sync -n 100
sudo systemctl restart agh_image_sync
```

The worker runs an initial reconciliation after restart. Admins can also use
**Administration → Image sync → Sync now** after the mount is available.
