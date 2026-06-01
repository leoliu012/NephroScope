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

## Cache Cleanup

The cache can be rebuilt from raw TIFF files. If disk pressure is high:

```bash
sudo systemctl stop agh_backend
sudo find /data/agh_cache -mindepth 1 -maxdepth 2 -type d -mtime +30 -print
sudo systemctl start agh_backend
```

Review the printed paths before deleting. The application will regenerate missing channel PNGs on demand.

## Watcher Recovery

If the Windows watcher was stopped or the NAS was unavailable, restart it. Startup reconciliation compares local TIFF signatures against `.agh_watcher_state.json` and queues changed files automatically.
