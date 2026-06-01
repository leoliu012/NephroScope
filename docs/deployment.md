# Deployment

Deployment and image synchronization are separate flows.

## Application Deployment

Set:

```bash
export AGH_DEPLOY_REMOTE=ubuntu@example.org
export AGH_SSH_KEY_PATH=$HOME/.ssh/agh-deploy.pem
export AGH_STRICT_HOST_KEY_CHECKING=yes
export AGH_BASIC_AUTH_USER=agh-lab
export AGH_BASIC_AUTH_PASSWORD='choose-a-real-password'
```

Replace every placeholder with real values before deploying. `deploy.py` refuses to run without Basic Auth credentials.

Then run:

```bash
python deploy.py
```

The script:

1. uploads frontend source;
2. runs `npm ci` or `npm install` on the server;
3. copies the Vite build to `/var/www/html/agh`;
4. uploads backend code;
5. installs locked Python dependencies into `/home/ubuntu/agh-viewer/venv`;
6. restarts `agh_backend`;
7. installs the Basic Auth password file;
8. installs `infra/apache/agh-viewer.conf`;
9. runs `apache2ctl configtest`;
10. reloads Apache.

## Data Sync

Use `agh_watcher.py` or another dedicated sync process for NAS data. Application deploys must not upload `/data/AGH_APP`.

## Production Process

The API should run as:

```text
Apache -> Gunicorn on 127.0.0.1:5055 -> Flask agh_api
```

Do not expose port `5055` directly to the public internet.

Apache protects `/agh` and `/agh/api` with Basic Auth. It also forwards the authenticated username to Flask as `X-Remote-User`, which is used for annotation `updatedBy` in production.
