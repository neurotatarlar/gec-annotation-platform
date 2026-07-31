#!/usr/bin/env bash

set -euo pipefail

: "${DEPLOY_APP_DIR:=/opt/gec-app}"
: "${DEPLOY_FRONTEND_DIST_DIR:=/var/www/gec-frontend}"
: "${DEPLOY_SERVICE_NAME:=gec-backend}"
DEPLOY_GIT_SHA="${DEPLOY_GIT_SHA:-${GITHUB_SHA:-}}"

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

require_value() {
  local name=$1
  if [[ -z "${!name:-}" ]]; then
    echo "Missing deployment value: $name" >&2
    return 1
  fi
}

validate_config() {
  local failed=0
  local name
  for name in DEPLOY_SSH_HOST DEPLOY_SSH_USER DEPLOY_PUBLIC_ORIGIN; do
    require_value "$name" || failed=1
  done

  if [[ -n "${DEPLOY_PUBLIC_ORIGIN:-}" ]]; then
    if [[ "$DEPLOY_PUBLIC_ORIGIN" != http://* && "$DEPLOY_PUBLIC_ORIGIN" != https://* ]]; then
      echo "DEPLOY_PUBLIC_ORIGIN must start with http:// or https://" >&2
      failed=1
    fi
    if [[ "$DEPLOY_PUBLIC_ORIGIN" == */ ]]; then
      echo "DEPLOY_PUBLIC_ORIGIN must not have a trailing slash" >&2
      failed=1
    fi
    if [[ "$DEPLOY_PUBLIC_ORIGIN" == */api ]]; then
      echo "DEPLOY_PUBLIC_ORIGIN must not include the /api suffix" >&2
      failed=1
    fi
  fi

  for name in DEPLOY_APP_DIR DEPLOY_FRONTEND_DIST_DIR; do
    if [[ "${!name}" != /* ]]; then
      echo "$name must be an absolute path" >&2
      failed=1
    fi
  done

  return "$failed"
}

deploy_target() {
  printf '%s@%s' "$DEPLOY_SSH_USER" "$DEPLOY_SSH_HOST"
}

ssh_args() {
  if [[ -n "${DEPLOY_SSH_KEY:-}" ]]; then
    printf '%s\n' -o IdentitiesOnly=yes -i "$DEPLOY_SSH_KEY"
  fi
}

preflight_server() {
  validate_config
  local target
  local -a options=()
  target=$(deploy_target)
  readarray -t options < <(ssh_args)
  ssh "${options[@]}" -o BatchMode=yes "$target" \
    "set -eu
     sudo -n true
     test -d '$DEPLOY_APP_DIR/app'
     test -x '$DEPLOY_APP_DIR/venv/bin/python'
     test -f '$DEPLOY_APP_DIR/backend.env'
     test -d '$DEPLOY_FRONTEND_DIST_DIR'
     node -e 'const [major, minor] = process.versions.node.split(\".\").map(Number); process.exit((major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major >= 24 ? 0 : 1)'
     sudo systemctl is-enabled '$DEPLOY_SERVICE_NAME' >/dev/null
     df -h '$DEPLOY_APP_DIR' '$DEPLOY_FRONTEND_DIST_DIR'"
}

backup_database() {
  validate_config
  local target
  local -a options=()
  target=$(deploy_target)
  readarray -t options < <(ssh_args)
  ssh "${options[@]}" -o BatchMode=yes "$target" \
    "set -eu
     if command -v pgbackrest >/dev/null 2>&1 &&
        sudo -u postgres pgbackrest --stanza=gec --type=incr backup; then
       echo 'pgBackRest incremental backup created.'
     else
       echo 'pgBackRest stanza gec is unavailable; creating a local pg_dump backup.' >&2
       set -a
       . '$DEPLOY_APP_DIR/backend.env'
       set +a
       DB_NAME=\$(python3 -c 'import os; from urllib.parse import urlparse; print(urlparse(os.environ[\"DATABASE__URL\"].replace(\"+psycopg\", \"\", 1)).path.lstrip(\"/\"))')
       test -n \"\$DB_NAME\"
       BACKUP_DIR=/var/backups/gec
       BACKUP_FILE=\$BACKUP_DIR/pre-deploy-\$(date -u +%Y%m%dT%H%M%SZ).dump
       cd /
       sudo install -d -o postgres -g postgres -m 700 \"\$BACKUP_DIR\"
       sudo -u postgres pg_dump --format=custom --file=\"\$BACKUP_FILE\" \"\$DB_NAME\"
       sudo -u postgres find \"\$BACKUP_DIR\" -type f -name 'pre-deploy-*.dump' -mtime +30 -delete
       echo \"Database backup created: \$BACKUP_FILE\"
     fi"
}

deploy_commit() {
  validate_config
  local target
  local -a deploy_args=()
  target=$(deploy_target)
  if [[ -n "${DEPLOY_SSH_KEY:-}" ]]; then
    deploy_args+=(--ssh-key "$DEPLOY_SSH_KEY")
  fi
  python3 "$SCRIPT_DIR/deploy.py" deploy \
    --host "$target" \
    "${deploy_args[@]}" \
    --app-dir "$DEPLOY_APP_DIR" \
    --frontend-dist-dir "$DEPLOY_FRONTEND_DIST_DIR" \
    --service-name "$DEPLOY_SERVICE_NAME" \
    --frontend-api-url "$DEPLOY_PUBLIC_ORIGIN"
}

verify_deployment() {
  validate_config
  require_value DEPLOY_GIT_SHA
  local target
  local -a options=()
  target=$(deploy_target)
  readarray -t options < <(ssh_args)
  ssh "${options[@]}" -o BatchMode=yes "$target" \
    "set -eu
     sudo systemctl is-active --quiet '$DEPLOY_SERVICE_NAME'
     curl --fail --silent --show-error --retry 10 --retry-delay 2 http://127.0.0.1:8000/health >/dev/null
     printf '%s\n' '$DEPLOY_GIT_SHA' > '$DEPLOY_APP_DIR/deployed-commit'"
  curl --fail --silent --show-error --retry 10 --retry-delay 2 \
    "$DEPLOY_PUBLIC_ORIGIN/" >/dev/null
}

usage() {
  echo "Usage: $0 {validate|preflight|backup|deploy|verify|all}" >&2
}

case "${1:-}" in
  validate)
    validate_config
    ;;
  preflight)
    preflight_server
    ;;
  backup)
    backup_database
    ;;
  deploy)
    deploy_commit
    ;;
  verify)
    verify_deployment
    ;;
  all)
    preflight_server
    backup_database
    deploy_commit
    verify_deployment
    ;;
  *)
    usage
    exit 2
    ;;
esac
