#!/usr/bin/env bash

set -euo pipefail

REPO_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
WORK_DIR=$(mktemp -d)
MOCK_BIN="$WORK_DIR/bin"
COMMAND_LOG="$WORK_DIR/commands.log"
REAL_PYTHON=$(command -v python3)

cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

mkdir -p "$MOCK_BIN"
: > "$COMMAND_LOG"

for command_name in ssh curl python3; do
  cat > "$MOCK_BIN/$command_name" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
{
  printf '%s' "$(basename "$0")"
  for argument in "$@"; do
    printf ' <%s>' "$argument"
  done
  printf '\n'
} >> "$DEPLOY_TEST_COMMAND_LOG"
MOCK
  chmod +x "$MOCK_BIN/$command_name"
done

export PATH="$MOCK_BIN:$PATH"
export DEPLOY_TEST_COMMAND_LOG="$COMMAND_LOG"

ORCHESTRATOR="$REPO_DIR/scripts/deploy_workflow.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_log_contains() {
  local expected=$1
  grep -F -- "$expected" "$COMMAND_LOG" >/dev/null || fail "command log is missing: $expected"
}

if env -u DEPLOY_SSH_HOST -u DEPLOY_SSH_USER -u DEPLOY_PUBLIC_ORIGIN \
  "$ORCHESTRATOR" validate >/dev/null 2>&1; then
  fail "validation accepted missing required values"
fi

if DEPLOY_SSH_HOST=vps.example DEPLOY_SSH_USER=deploy \
  DEPLOY_PUBLIC_ORIGIN=https://annotations.example/api \
  "$ORCHESTRATOR" validate >/dev/null 2>&1; then
  fail "validation accepted an API-suffixed public origin"
fi

export DEPLOY_SSH_HOST=vps.example
export DEPLOY_SSH_USER=deploy
export DEPLOY_PUBLIC_ORIGIN=https://annotations.example
export DEPLOY_APP_DIR=/srv/gec
export DEPLOY_FRONTEND_DIST_DIR=/srv/www/gec
export DEPLOY_SERVICE_NAME=gec-api
export DEPLOY_GIT_SHA=0123456789abcdef
export DEPLOY_SSH_KEY=/tmp/deploy-test-key

"$ORCHESTRATOR" all

[[ $(grep -c '^ssh ' "$COMMAND_LOG") -eq 3 ]] || fail "expected three SSH calls"
assert_log_contains "<deploy@vps.example>"
assert_log_contains "<-i> </tmp/deploy-test-key>"
assert_log_contains "test -d '/srv/gec/app'"
assert_log_contains "process.versions.node"
assert_log_contains "pgbackrest --stanza=gec --type=incr backup"
assert_log_contains "pg_dump --format=custom"
assert_log_contains "deploy.py> <deploy> <--host> <deploy@vps.example>"
assert_log_contains "<--ssh-key> </tmp/deploy-test-key>"
assert_log_contains "<--app-dir> </srv/gec>"
assert_log_contains "<--frontend-dist-dir> </srv/www/gec>"
assert_log_contains "<--service-name> <gec-api>"
assert_log_contains "<--frontend-api-url> <https://annotations.example>"
assert_log_contains "0123456789abcdef"
assert_log_contains "curl <--fail> <--silent> <--show-error> <--retry> <10> <--retry-delay> <2> <https://annotations.example/>"

"$REAL_PYTHON" "$REPO_DIR/scripts/deploy.py" deploy --help >/dev/null
bash -n "$ORCHESTRATOR"

echo "Deployment workflow orchestration test passed."
