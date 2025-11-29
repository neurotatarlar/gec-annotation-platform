#!/usr/bin/env python3
from __future__ import annotations

import argparse
import secrets
import shlex
import subprocess
import textwrap
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def run_local_command(cmd: list[str], **kwargs) -> None:
    printable = " ".join(shlex.quote(part) for part in cmd)
    print(f"$ {printable}")
    subprocess.run(cmd, check=True, **kwargs)


def run_remote_script(host: str, env: dict[str, str], script: str) -> None:
    env_prefix = " ".join(f"{key}={shlex.quote(value)}" for key, value in env.items() if value is not None)
    remote_cmd = f"{env_prefix} bash -s" if env_prefix else "bash -s"
    print(f"$ ssh {host} {remote_cmd}")
    subprocess.run(
        ["ssh", host, remote_cmd],
        check=True,
        input=script.encode("utf-8"),
    )


def ensure_secret(secret: str | None) -> str:
    return secret or secrets.token_hex(32)


def init_command(args: argparse.Namespace) -> None:
    secret_key = ensure_secret(args.secret_key)
    database_url = f"postgresql+psycopg://{args.db_user}:{args.db_password}@localhost:5432/{args.db_name}"

    env = {
        "APP_DIR": args.app_dir,
        "FRONTEND_DIST_DIR": args.frontend_dist_dir,
        "SERVICE_NAME": args.service_name,
        "DB_NAME": args.db_name,
        "DB_USER": args.db_user,
        "DB_PASSWORD": args.db_password,
        "DATABASE_URL": database_url,
        "SECRET_KEY": secret_key,
        "S3_BUCKET": args.s3_bucket or "",
        "S3_PREFIX": args.s3_prefix or "gec-backups",
        "S3_REGION": args.s3_region or "",
        "AWS_ACCESS_KEY_ID": args.aws_access_key_id or "",
        "AWS_SECRET_ACCESS_KEY": args.aws_secret_access_key or "",
    }

    script = textwrap.dedent(
        r"""
        set -euo pipefail

        # Normalize locale to avoid Perl/Pg warnings.
        export LANG=en_US.UTF-8
        export LC_ALL=en_US.UTF-8
        sudo locale-gen en_US.UTF-8 ru_RU.UTF-8 >/dev/null 2>&1 || true
        sudo update-locale LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 >/dev/null 2>&1 || true

        REMOTE_USER=$(whoami)

        sudo apt update
        sudo apt install -y git rsync python3 python3-venv python3-pip nodejs npm nginx postgresql postgresql-contrib ufw awscli

        PG_CONF="/etc/postgresql/15/main/postgresql.conf"
        PG_HBA=$(sudo -u postgres -H sh -c "cd / && psql -qtAc 'SHOW hba_file;'" | tr -d '[:space:]')

        if [[ -n "$PG_CONF" && -f "$PG_CONF" ]]; then
          ARCHIVE_CMD="test -f /var/lib/postgresql/wal-archive/%f || cp %p /var/lib/postgresql/wal-archive/%f"
          WAL_SNIPPET="/etc/postgresql/15/main/conf.d/gec-wal.conf"
          sudo mkdir -p /etc/postgresql/15/main/conf.d
          sudo tee "$WAL_SNIPPET" >/dev/null <<SNIPPET
listen_addresses = '*'
wal_level = replica
archive_mode = on
archive_command = '$ARCHIVE_CMD'
SNIPPET
          sudo mkdir -p /var/lib/postgresql/wal-archive
          sudo chown -R postgres:postgres /var/lib/postgresql/wal-archive
          sudo chmod 700 /var/lib/postgresql/wal-archive
        fi
        if [[ -n "$PG_HBA" && -f "$PG_HBA" ]]; then
          if ! sudo grep -q "0.0.0.0/0" "$PG_HBA"; then
            echo "host all all 0.0.0.0/0 md5" | sudo tee -a "$PG_HBA" >/dev/null
          fi
        fi
        sudo systemctl restart postgresql

        sudo mkdir -p "$APP_DIR"
        sudo chown "$REMOTE_USER":"$REMOTE_USER" "$APP_DIR"
        mkdir -p "$APP_DIR/app" "$APP_DIR/logs"
        if [[ ! -d "$APP_DIR/venv" ]]; then
          python3 -m venv "$APP_DIR/venv"
        fi

        sudo mkdir -p "$FRONTEND_DIST_DIR"
        sudo chown "$REMOTE_USER":"$REMOTE_USER" "$FRONTEND_DIST_DIR"

        sudo -u postgres psql <<'SQL'
DO $$
BEGIN
   IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${DB_USER}' ) THEN
      EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L', '${DB_USER}', '${DB_PASSWORD}');
   END IF;
END$$;
SQL

if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1; then
  sudo -u postgres createdb "${DB_NAME}" -O "${DB_USER}"
fi

        sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE \"${DB_NAME}\" TO \"${DB_USER}\";"
        sudo -u postgres psql -d "${DB_NAME}" <<SQL
DO \$\$
BEGIN
   IF NOT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'public') THEN
      EXECUTE 'CREATE SCHEMA public AUTHORIZATION ' || quote_ident('${DB_USER}') || ';';
   END IF;
END
\$\$;
ALTER DATABASE "${DB_NAME}" SET search_path = public;
ALTER ROLE "${DB_USER}" IN DATABASE "${DB_NAME}" SET search_path = public;
SQL

        if [[ -n "${S3_BUCKET}" ]]; then
          echo "Configuring S3 backups..."
          sudo mkdir -p /var/backups/gec
          sudo chown "$REMOTE_USER":"$REMOTE_USER" /var/backups/gec
          sudo tee /usr/local/bin/gec-db-backup.sh >/dev/null <<'BACKUP'
#!/usr/bin/env bash
set -euo pipefail
STAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR=/var/backups/gec
mkdir -p "$BACKUP_DIR"
FILE="$BACKUP_DIR/db_${STAMP}.sql.gz"
export PGPASSWORD="${DB_PASSWORD}"
pg_dump -U "${DB_USER}" -d "${DB_NAME}" | gzip > "$FILE"
aws s3 cp "$FILE" "s3://${S3_BUCKET}/${S3_PREFIX:-gec-backups}/$(basename "$FILE")"
find "$BACKUP_DIR" -type f -mtime +7 -delete
BACKUP
          sudo chmod +x /usr/local/bin/gec-db-backup.sh

          CRON_FILE=/etc/cron.d/gec-db-backup
          sudo tee "$CRON_FILE" >/dev/null <<CRON
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID}
AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY}
AWS_DEFAULT_REGION=${S3_REGION}
DB_NAME=${DB_NAME}
DB_USER=${DB_USER}
DB_PASSWORD=${DB_PASSWORD}
S3_BUCKET=${S3_BUCKET}
S3_PREFIX=${S3_PREFIX}
0 3 * * * root /usr/local/bin/gec-db-backup.sh >> /var/log/gec-db-backup.log 2>&1
CRON
          sudo chmod 600 "$CRON_FILE"
        else
          echo "S3_BUCKET not set; skipping backup cron setup."
        fi

        cat <<ENV > "$APP_DIR/backend.env"
DATABASE__URL=$DATABASE_URL
SECURITY__SECRET_KEY=$SECRET_KEY
ENV

        sudo tee /etc/systemd/system/"$SERVICE_NAME".service >/dev/null <<SERVICE
[Unit]
Description=GEC Annotation Backend
After=network.target postgresql.service

[Service]
User=$REMOTE_USER
WorkingDirectory=$APP_DIR/app/backend
EnvironmentFile=$APP_DIR/backend.env
ExecStart=$APP_DIR/venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SERVICE

        sudo tee /etc/nginx/sites-available/gec-annotation.conf >/dev/null <<NGINX
server {
    listen 80;
    server_name _;

    root $FRONTEND_DIST_DIR;
    index index.html;

    location /api/ {
        proxy_pass http://127.0.0.1:8000/api/;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location / {
        try_files \$uri \$uri/ /index.html;
    }
}
NGINX

        sudo ln -sf /etc/nginx/sites-available/gec-annotation.conf /etc/nginx/sites-enabled/gec-annotation.conf
        sudo rm -f /etc/nginx/sites-enabled/default

        # Open firewall ports for HTTP (80) and PostgreSQL (5432)
        sudo ufw allow 80/tcp
        sudo ufw allow 5432/tcp || true

        sudo systemctl daemon-reload
        sudo systemctl enable "$SERVICE_NAME"
        sudo systemctl reload nginx

        echo "Cloud initialization complete."
        """
    )

    run_remote_script(args.host, env, script)


def deploy_command(args: argparse.Namespace) -> None:
    rsync_excludes = [
        "--exclude=.git",
        "--exclude=.DS_Store",
        "--exclude=__pycache__",
        "--exclude=frontend/node_modules",
        "--exclude=frontend/dist",
        "--exclude=backend/.venv",
    ]

    target_path = f"{args.host}:{args.app_dir}/app/"
    rsync_cmd = ["rsync", "-az", "--delete", *rsync_excludes, f"{REPO_ROOT}/", target_path]
    run_local_command(rsync_cmd)

    env = {
        "APP_DIR": args.app_dir,
        "FRONTEND_DIST_DIR": args.frontend_dist_dir,
        "SERVICE_NAME": args.service_name,
        "FRONTEND_API_URL": args.frontend_api_url,
    }

    script = textwrap.dedent(
        """
        set -euo pipefail

        if [[ ! -d "$APP_DIR/venv" ]]; then
          echo "Python venv missing at $APP_DIR/venv" >&2
          exit 1
        fi

        echo "Installing backend dependencies..."
        "$APP_DIR/venv/bin/pip" install --upgrade pip
        "$APP_DIR/venv/bin/pip" install -r "$APP_DIR/app/backend/requirements.txt"

        if [[ -f "$APP_DIR/backend.env" ]]; then
          set -a
          source "$APP_DIR/backend.env"
          set +a
        fi

        PY_BIN="$APP_DIR/venv/bin/python"
        if [[ ! -x "$PY_BIN" ]]; then
          if command -v python3 >/dev/null 2>&1; then
            PY_BIN=$(command -v python3)
          else
            PY_BIN=$(command -v python)
          fi
        fi

        # Extract DB name/user from DATABASE__URL for privilege fixes.
        readarray -t DB_INFO <<< "$("$PY_BIN" - <<'PY'
import os
from urllib.parse import urlparse
url = os.environ.get("DATABASE__URL")
if not url:
    raise SystemExit("")
parsed = urlparse(url.replace("+psycopg", "", 1))
db = parsed.path.lstrip("/")
user = parsed.username or ""
print(db)
print(user)
PY
)"
        DB_NAME_P="${DB_INFO[0]:-}"
        DB_USER_P="${DB_INFO[1]:-}"

        # Derive a psql-friendly URL (strip driver suffix like +psycopg) to fix missing public schema.
        PSQL_URL=$("$PY_BIN" - <<'PY'
import os
url = os.environ.get("DATABASE__URL")
if not url:
    raise SystemExit("")
print(url.replace("+psycopg", ""))
PY
)
        if [[ -n "${DB_NAME_P:-}" && -n "${DB_USER_P:-}" ]]; then
          echo "Ensuring public schema exists and is usable..."
          sudo -u postgres psql -d "$DB_NAME_P" -c "CREATE SCHEMA IF NOT EXISTS public;" || true
          sudo -u postgres psql -d "$DB_NAME_P" -c "ALTER SCHEMA public OWNER TO \"$DB_USER_P\";" || true
          sudo -u postgres psql -d "$DB_NAME_P" -c "GRANT USAGE, CREATE ON SCHEMA public TO \"$DB_USER_P\";" || true
        fi
        if [[ -n "${PSQL_URL:-}" ]]; then
          export PGOPTIONS='-c search_path=public'
        fi

        echo "Applying database schema..."
        cd "$APP_DIR/app/backend"
        "$APP_DIR/venv/bin/alembic" -c alembic.ini upgrade head
        cd "$APP_DIR"

        echo "Building frontend..."
        cd "$APP_DIR/app/frontend"
        npm install --no-fund --no-audit
        VITE_API_URL="$FRONTEND_API_URL" npm run build

        echo "Publishing frontend assets..."
        sudo rsync -az --delete "$APP_DIR/app/frontend/dist/" "$FRONTEND_DIST_DIR/"

        echo "Restarting services..."
        sudo systemctl restart "$SERVICE_NAME"
        sudo systemctl reload nginx

        echo "Deployment complete."
        """
    )

    run_remote_script(args.host, env, script)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Deploy helper for the GEC annotation platform.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    common_init = {
        "app_dir": ("/opt/gec-app", "Remote application root"),
        "frontend_dist_dir": ("/var/www/gec-frontend", "Directory served by nginx"),
        "service_name": ("gec-backend", "systemd service name"),
    }

    init_parser = subparsers.add_parser("init", help="Provision a fresh Debian server.")
    init_parser.add_argument("--host", required=True, help="SSH target (e.g. user@server)")
    init_parser.add_argument("--app-dir", default=common_init["app_dir"][0], help=common_init["app_dir"][1])
    init_parser.add_argument(
        "--frontend-dist-dir",
        default=common_init["frontend_dist_dir"][0],
        help=common_init["frontend_dist_dir"][1],
    )
    init_parser.add_argument(
        "--service-name",
        default=common_init["service_name"][0],
        help=common_init["service_name"][1],
    )
    init_parser.add_argument("--db-name", default="gec", help="PostgreSQL database name")
    init_parser.add_argument("--db-user", default="gec", help="PostgreSQL user")
    init_parser.add_argument("--db-password", default="change-me", help="PostgreSQL password")
    init_parser.add_argument("--secret-key", default=None, help="JWT secret (auto-generated if omitted)")
    init_parser.add_argument("--s3-bucket", default=None, help="S3 bucket for backups (optional)")
    init_parser.add_argument("--s3-prefix", default="gec-backups", help="S3 key prefix for backups")
    init_parser.add_argument("--s3-region", default=None, help="AWS region for backups (optional)")
    init_parser.add_argument("--aws-access-key-id", default=None, help="AWS access key for backups (optional)")
    init_parser.add_argument("--aws-secret-access-key", default=None, help="AWS secret key for backups (optional)")
    init_parser.set_defaults(func=init_command)

    deploy_parser = subparsers.add_parser("deploy", help="Sync code and restart services.")
    deploy_parser.add_argument("--host", required=True, help="SSH target (e.g. user@server)")
    deploy_parser.add_argument("--app-dir", default=common_init["app_dir"][0], help=common_init["app_dir"][1])
    deploy_parser.add_argument(
        "--frontend-dist-dir",
        default=common_init["frontend_dist_dir"][0],
        help=common_init["frontend_dist_dir"][1],
    )
    deploy_parser.add_argument(
        "--service-name",
        default=common_init["service_name"][0],
        help=common_init["service_name"][1],
    )
    deploy_parser.add_argument(
        "--frontend-api-url",
        default="http://127.0.0.1:8000",
        help="API URL baked into the frontend build",
    )
    deploy_parser.set_defaults(func=deploy_command)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
