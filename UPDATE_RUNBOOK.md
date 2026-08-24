# App Update Runbook

Use this when the app code changes and you want the most complete restart/reload path for an Apache-gated local setup.

## 1. Backend

From the project root:

```bash
cd ~/NephroScope
pkill -f "python app.py" || true
cd backend
AGH_LOCAL_DEV=1 \
AGH_BASIC_AUTH_USER=agh-lab \
AGH_BASIC_AUTH_PASSWORD='choose-a-real-password' \
../.venv/bin/python app.py
```

Keep this terminal open while using the app.

Use the real local username/password you want for the app. The backend rejects
all logins if no credentials are configured.

If this machine later has the production systemd service installed, use this instead:

```bash
sudo systemctl restart agh_backend
```

## 2. Frontend Served By Apache

Use this when users access the app through Apache at `/agh/`.

```bash
cd ~/NephroScope/frontend
npm run build
sudo rsync -a --delete dist/ /var/www/html/agh/
sudo apache2ctl configtest
sudo systemctl reload apache2
```

## 3. Browser Hard Refresh

After the backend restart and frontend rebuild, hard refresh the browser:

```text
Ctrl+Shift+R
```

If the browser still shows old frontend behavior, open DevTools, right-click the reload button, and choose:

```text
Empty Cache and Hard Reload
```

## Quick Full Sequence

Run the backend command in one terminal:

```bash
cd ~/NephroScope
pkill -f "python app.py" || true
cd backend
AGH_LOCAL_DEV=1 \
AGH_BASIC_AUTH_USER=agh-lab \
AGH_BASIC_AUTH_PASSWORD='choose-a-real-password' \
../.venv/bin/python app.py
```

Run the frontend/Apache command in another terminal:

```bash
cd ~/NephroScope/frontend
npm run build
sudo rsync -a --delete dist/ /var/www/html/agh/
sudo apache2ctl configtest
sudo systemctl reload apache2
```
