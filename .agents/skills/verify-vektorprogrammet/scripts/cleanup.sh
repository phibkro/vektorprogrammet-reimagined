#!/usr/bin/env bash
# Tears down what scripts/launch.sh started, and nothing else. Usage: scripts/cleanup.sh
# Safe to run after a failed launch, after the supervisor stopped the stack, or twice.
#
# Removes: the stack (if still alive), listeners on this run's own recorded ports, the run's disposable database,
# the overlay files launch.sh copied in, secrets.env, the tree's pointer, and PostgreSQL if launch.sh started it.
# Keeps: the whole run directory (screenshots, pages, playwright traces, serve.log, results, probes). That is the
# evidence; its path is printed last.
set -euo pipefail
# shellcheck disable=SC1091
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

if [[ -z "${VERIFY_RUN_DIR:-}" && ! -f "$POINTER" ]]; then
  echo "nothing to clean"
  exit 0
fi

resolve_run_dir
set -a
[[ -f "$RUN_DIR/state.env" ]] && . "$RUN_DIR/state.env"
# shellcheck disable=SC1091
[[ -f "$RUN_DIR/meta.env" ]] && . "$RUN_DIR/meta.env"
set +a

wait_gone() { # pid, seconds
  local pid="$1" waited=0
  while [[ -r "/proc/$pid/cmdline" && "$waited" -lt "$2" ]]; do sleep 1; waited=$((waited + 1)); done
  [[ ! -r "/proc/$pid/cmdline" ]]
}

# 1. Signal the serve.ts process if it is still ours. SIGTERM may exit it with status 143 without closing its scope;
#    the recorded-port and database cleanup below handles resources left behind. Only our process is signalled.
if serve_alive "${VERIFY_PID:-}"; then
  echo "stopping serve.ts (pid $VERIFY_PID)"
  kill -TERM "$VERIFY_PID"
  wait_gone "$VERIFY_PID" 90 || { echo "serve.ts did not exit in 90 s; killing it" >&2; kill -KILL "$VERIFY_PID" 2>/dev/null || true; }
fi

# 2. Anything still listening on this run's two random ports is ours (they are recorded); nothing else is touched.
for origin in "${E2E_BASE_URL:-}" "${E2E_CMS_URL:-}"; do
  [[ -n "$origin" ]] || continue
  port="$(port_of "$origin")"
  for pid in $(listeners_on "$port"); do
    echo "stranded listener on :$port (pid $pid): stopping it"
    kill -TERM "$pid" 2>/dev/null || true
    wait_gone "$pid" 15 || kill -KILL "$pid" 2>/dev/null || true
  done
done

# 3. The disposable database goes with serve.ts's scope; after a hard kill it is still there. Only the database this
#    run recorded, and only when its name is the harness's `vp_db_test_*`, is ever dropped.
database_left=no
if [[ -n "${E2E_DATABASE_URL:-}" ]]; then
  database="$(database_of "$E2E_DATABASE_URL")"
  if [[ "$database" == vp_db_test_* ]]; then
    database_left="$(DATABASE_NAME="$database" in_devenv bash -c '
      exists() { psql -X -At "$TEST_DATABASE_ADMIN_URL" -c "select 1 from pg_database where datname = '\''$DATABASE_NAME'\''"; }
      if [[ -n "$(exists)" ]]; then
        psql -X -q "$TEST_DATABASE_ADMIN_URL" -c "drop database \"$DATABASE_NAME\" with (force)" >&2
        echo dropped
      else
        echo gone
      fi')"
  fi
fi
if [[ -n "${E2E_DATABASE_URL:-}" ]]; then
  echo "database $database: $database_left"
fi

rm -rf "$TREE"/apps/web/e2e/.r2-seed-*
rm -rf "$RUN_DIR"/tmp/vk-r2-seed-*

# 4. Overlay files, secrets, the pointer.
if [[ -f "$RUN_DIR/overlay.list" ]]; then
  while IFS= read -r file; do
    [[ -n "$file" ]] && rm -f "$TREE/$file" && echo "removed overlay $file"
  done <"$RUN_DIR/overlay.list"
  : >"$RUN_DIR/overlay.list"
fi
rm -f "$RUN_DIR/secrets.env"
[[ -f "$POINTER" && "$(<"$POINTER")" == "$RUN_DIR" ]] && rm -f "$POINTER"

# 5. devenv's PostgreSQL and MySQL, only when this run's launch started them.
if [[ "${STARTED_SERVICES:-0}" == 1 ]]; then
  (cd "$TREE" && devenv processes down >/dev/null 2>&1) && echo "stopped devenv PostgreSQL and MySQL (launch.sh had started them)"
fi

echo "CLEANED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$RUN_DIR/meta.env"
VERIFY_RUN_DIR="$RUN_DIR" "$SKILL_DIR/scripts/report.sh"
echo "evidence kept in: $RUN_DIR"
ls -1 "$RUN_DIR"
