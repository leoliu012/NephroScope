# Operations Runbook

## Health

```bash
curl -fsS http://127.0.0.1:5055/agh/api/health
sudo systemctl status agh_backend
sudo journalctl -u agh_backend -f
```

## Restart API

```bash
sudo systemctl restart agh_backend
```

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
