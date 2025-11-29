# Deployment guide

This project ships a helper script (`scripts/deploy.py`) that provisions a Debian host and keeps it updated. Use it from your laptop; it SSHes into the server and applies the steps below.

## Requirements
- Debian 12+ server reachable over SSH with a sudo-enabled user.
- Local machine has Python 3, rsync, and ssh available (the script uses them).
- DNS/SSL can be layered on later; the script only configures HTTP on port 80.

## One-time server bootstrap
Run `init` once on a fresh machine:
```bash
python scripts/deploy.py init \
  --host user@your-server \
  --app-dir /opt/gec-app \
  --frontend-dist-dir /var/www/gec-frontend \
  --service-name gec-backend \
  --db-name gec \
  --db-user gec \
  --db-password 'strong-password' \
  --secret-key 'jwt-secret'        # omit to auto-generate
  # --s3-bucket ...                # optional: enable daily DB backups
```

What it does:
- Installs system packages (git, rsync, Python, Node, nginx, PostgreSQL 15, ufw, awscli).
- Configures PostgreSQL (opens 5432, enables WAL archiving to `/var/lib/postgresql/wal-archive`, creates the DB/user).
- Creates the app home (`APP_DIR`) with a Python venv plus a `backend.env` file holding `DATABASE__URL` and `SECURITY__SECRET_KEY`.
- Prepares an nginx site that serves the built frontend from `FRONTEND_DIST_DIR` and proxies `/api/` to uvicorn on port 8000.
- Registers a systemd service (name = `--service-name`) that will run `uvicorn app.main:app`.
- Optionally sets up a daily cron backup to S3 (`/usr/local/bin/gec-db-backup.sh`, logs at `/var/log/gec-db-backup.log`).

The systemd service is enabled, but the code and dependencies are not synced until you run `deploy`.

## Deploy code updates
Use `deploy` every time you push a new commit:
```bash
python scripts/deploy.py deploy \
  --host user@your-server \
  --app-dir /opt/gec-app \
  --frontend-dist-dir /var/www/gec-frontend \
  --service-name gec-backend \
  --frontend-api-url https://your-domain
```
Pass the base origin for `--frontend-api-url` (no trailing `/api`).

What it does:
- Rsyncs the repository into `$APP_DIR/app`.
- Installs backend dependencies into the remote venv and loads `backend.env`.
- Ensures the `public` schema ownership, then runs `alembic -c alembic.ini upgrade head`.
- Builds the frontend with `VITE_API_URL=$FRONTEND_API_URL` and syncs `frontend/dist` into `FRONTEND_DIST_DIR`.
- Restarts the systemd service and reloads nginx.

## Post-deploy checks and maintenance
- Health check from the server: `curl -f http://localhost:8000/health`
- Service status: `sudo systemctl status gec-backend`
- Run admin CLI remotely (example):  
  `ssh user@your-server "/opt/gec-app/venv/bin/python -m app.cli create-user --username admin --password 'StrongPass123' --admin"`
- If S3 backups are enabled, archives live under `/var/backups/gec` with 7-day retention. Errors are logged to `/var/log/gec-db-backup.log`.
