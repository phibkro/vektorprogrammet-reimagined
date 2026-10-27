#!/usr/bin/env bash
# A read-only second view of what the app stored: runs one SQL statement against this run's disposable database and
# records the statement and its result in the run directory. Usage:
#
#   scripts/probe.sh "<select ...>" [--name <label>]
#
# The session is read-only (default_transaction_read_only=on), so a probe can never be the cause of the state it
# reports. Tables worth knowing: outbox (queued mail and Slack: kind, status, created_at, delivered_at, attempts),
# audit_log, membership, person, team, position, department, semester, admin_grant (packages/db/src/schema.ts).
set -euo pipefail
# shellcheck disable=SC1091
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

sql="${1:?usage: probe.sh \"<select ...>\" [--name <label>]}"
shift
label=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) label="$2"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done

load_state
mkdir -p "$RUN_DIR/probes"
label="${label:-$(printf '%03d' "$(find "$RUN_DIR/probes" -type f | wc -l)")}"
out="$RUN_DIR/probes/$label.txt"

result="$(SQL="$sql" E2E_DATABASE_URL="$E2E_DATABASE_URL" in_devenv bash -c \
  'PGOPTIONS="-c default_transaction_read_only=on" psql -X -v ON_ERROR_STOP=1 "$E2E_DATABASE_URL" -c "$SQL"' 2>&1 | grep -v '^[•✓✖] Running devenv:')"
{
  echo "-- $(date -u +%Y-%m-%dT%H:%M:%SZ) database $(database_of "$E2E_DATABASE_URL") @ ${REVISION:0:9}"
  echo "$sql"
  echo
  echo "$result"
} | tee "$out"
echo "saved: $out"
