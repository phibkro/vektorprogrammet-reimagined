#!/usr/bin/env bash
# Read-only: is this instance worth driving? Usage: scripts/doctor.sh
# Exit 0 and "DOCTOR OK" only when every check holds. Run it before the first drive, after any failed drive, and
# whenever a page looks wrong. It changes nothing (database reads run with default_transaction_read_only=on).
set -uo pipefail
# shellcheck disable=SC1091
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

load_state

failed=0
check() { # description, command...
  local description="$1"
  shift
  if "$@" >/dev/null 2>&1; then echo "ok    $description"; else echo "FAIL  $description"; failed=1; fi
}
http_status() { curl -s -o /dev/null -w '%{http_code}' --max-time 30 "${@:2}" "$1"; }
status_is() { [[ "$(http_status "${@:2}" "$1")" == "$expected" ]]; }
descends_from() { # pid, ancestor
  local pid="$1"
  while [[ "$pid" -gt 1 ]]; do
    [[ "$pid" == "$2" ]] && return 0
    pid="$(awk '{print $4}' "/proc/$pid/stat" 2>/dev/null)" || return 1
    [[ -n "$pid" ]] || return 1
  done
  return 1
}
owned_by_us() { # port: some listener on it descends from serve.ts
  local pid
  for pid in $(listeners_on "$1"); do descends_from "$pid" "$VERIFY_PID" && return 0; done
  return 1
}
actor_sees() { # actor, path, text: the page the actor gets contains the text
  curl -s --max-time 30 -H "Cookie: vp-test-actor=$1" "$E2E_BASE_URL$2" | grep -qF "$3"
}

echo "run:       $RUN_DIR"
echo "tree:      $VERIFY_TREE @ ${REVISION:0:9} ($BRANCH)"
echo "origin:    $E2E_BASE_URL   cms: $E2E_CMS_URL   database: $(database_of "$E2E_DATABASE_URL")"

check "serve.ts is alive (pid $VERIFY_PID)" serve_alive "$VERIFY_PID"
check "the tree is still at the launched revision" test "$(git -C "$VERIFY_TREE" rev-parse HEAD)" = "$REVISION"
check "vp dev port $(port_of "$E2E_BASE_URL") is owned by this run" owned_by_us "$(port_of "$E2E_BASE_URL")"
check "CMS port $(port_of "$E2E_CMS_URL") is owned by this run" owned_by_us "$(port_of "$E2E_CMS_URL")"

expected=200
check "GET / answers 200" status_is "$E2E_BASE_URL/"
check "GET /kontakt answers 200" status_is "$E2E_BASE_URL/kontakt"
check "the CMS answers 200 on /_emdash/api/setup/status" status_is "$E2E_CMS_URL/_emdash/api/setup/status"
check "the CMS has no pending setup" bash -c "curl -s --max-time 30 '$E2E_CMS_URL/_emdash/api/setup/status' | grep -q '\"needsSetup\":false'"

# The local test actor: a seeded person by name in the vp-test-actor cookie (DEPLOYMENT=local only).
check "Ada Admin opens the control panel" actor_sees "Ada Admin" /kontrollpanel "Oversikt"
check "an anonymous visitor gets the not-signed-in page" actor_sees anonymous /kontrollpanel "Ikke innlogget"
check "Nora Nybegynner (no team) gets 'Ingen tilgang'" actor_sees "Nora Nybegynner" /kontrollpanel "Ingen tilgang"

# Usable data: migrated, imported and seeded, not merely connectable.
data="$(E2E_DATABASE_URL="$E2E_DATABASE_URL" in_devenv bash -c '
  PGOPTIONS="-c default_transaction_read_only=on" psql -X -At "$E2E_DATABASE_URL" -c "
    select (select count(*) from department where active),
           (select count(*) from semester),
           (select count(*) from person),
           (select count(*) from membership),
           (select count(*) from admin_grant)"' 2>/dev/null | tail -1)"
IFS='|' read -r departments semesters people memberships grants <<<"$data"
echo "data:      departments=${departments:-?} semesters=${semesters:-?} people=${people:-?} memberships=${memberships:-?} admin_grants=${grants:-?}"
check "active departments are imported" test "${departments:-0}" -ge 1
check "the cron's semester job ran (current and next semester exist)" test "${semesters:-0}" -ge 2
check "the six local people are seeded" test "${people:-0}" -ge 6
check "the seed gave people memberships and an admin place" test "${memberships:-0}" -ge 1 -a "${grants:-0}" -ge 1

if [[ "$failed" == 0 ]]; then echo "DOCTOR OK"; else echo "DOCTOR FAILED: do not drive this instance; read $RUN_DIR/serve.log, then scripts/cleanup.sh and relaunch" >&2; exit 1; fi
