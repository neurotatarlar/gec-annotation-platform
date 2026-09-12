#!/usr/bin/env bash

set -euo pipefail

: "${DEPLOY_APP_DIR:=/opt/gec-app}"
: "${REPAIR_CATEGORY_ID:=3}"

require_value() {
  local name=$1
  if [[ -z "${!name:-}" ]]; then
    echo "Missing repair workflow value: $name" >&2
    exit 1
  fi
}

target() {
  printf '%s@%s' "$DEPLOY_SSH_USER" "$DEPLOY_SSH_HOST"
}

ssh_options=()
if [[ -n "${DEPLOY_SSH_KEY:-}" ]]; then
  ssh_options=(-o IdentitiesOnly=yes -i "$DEPLOY_SSH_KEY")
fi

remote_cli() {
  local command=$1
  ssh "${ssh_options[@]}" -o BatchMode=yes "$(target)" \
    "set -a; . '$DEPLOY_APP_DIR/backend.env'; set +a; cd '$DEPLOY_APP_DIR/app/backend'; '$DEPLOY_APP_DIR/venv/bin/python' -m app.cli $command"
}

upload_manifest() {
  local manifest=$1
  local remote_path=$2
  scp "${ssh_options[@]}" "$manifest" "$(target):$remote_path"
}

for name in DEPLOY_SSH_HOST DEPLOY_SSH_USER; do
  require_value "$name"
done

case "${1:-}" in
  snapshot)
    output=${2:-output/category-${REPAIR_CATEGORY_ID}-repair-snapshot.json}
    mkdir -p "$(dirname "$output")"
    remote_path="/tmp/gec-repair-snapshot-$$.json"
    remote_cli "export-repair-snapshot --category-id '$REPAIR_CATEGORY_ID' --output '$remote_path'" >/dev/null
    scp "${ssh_options[@]}" "$(target):$remote_path" "$output"
    ssh "${ssh_options[@]}" "$(target)" "rm -f '$remote_path'"
    echo "Downloaded repair snapshot: $output"
    ;;
  dry-run)
    manifest=${2:?Usage: scripts/repair_workflow.sh dry-run MANIFEST}
    remote_path="/tmp/gec-repair-manifest-$$.json"
    upload_manifest "$manifest" "$remote_path"
    remote_cli "apply-repair-manifest '$remote_path' --dry-run"
    ssh "${ssh_options[@]}" "$(target)" "rm -f '$remote_path'"
    ;;
  apply)
    manifest=${2:?Usage: scripts/repair_workflow.sh apply MANIFEST}
    require_value REPAIR_CONFIRM_HASH
    "$(dirname "$0")/deploy_workflow.sh" backup
    remote_path="/tmp/gec-repair-manifest-$$.json"
    upload_manifest "$manifest" "$remote_path"
    remote_cli "apply-repair-manifest '$remote_path' --apply --confirm-hash '$REPAIR_CONFIRM_HASH' --receipt-output '/tmp/gec-repair-receipt.json'"
    scp "${ssh_options[@]}" "$(target):/tmp/gec-repair-receipt.json" "${manifest%.json}.receipt.json"
    ssh "${ssh_options[@]}" "$(target)" "rm -f '$remote_path' /tmp/gec-repair-receipt.json"
    ;;
  *)
    echo "Usage: scripts/repair_workflow.sh {snapshot [OUTPUT]|dry-run MANIFEST|apply MANIFEST}" >&2
    exit 2
    ;;
esac
