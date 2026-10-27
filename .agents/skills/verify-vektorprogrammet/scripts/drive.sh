#!/usr/bin/env bash
# Runs the repository's own Playwright specs (apps/web/e2e) against THIS run's stack, so the journey is the one CI
# runs and the evidence lands in the run directory. Usage (from anywhere in the tree):
#
#   scripts/drive.sh <spec file regex> [-g "<title regex>"] [other playwright test options]
#   scripts/drive.sh public.spec.ts -g "RULE-167"
#
# Adds: --trace on (every action, DOM snapshot and network call of each test: playwright/<test>/trace.zip, open it with
# `bunx playwright show-trace`), --output <run>/playwright, a JSON result at results-<n>.json, the harness's own
# screenshots in screenshots/ (E2E_SCREENSHOT_DIRECTORY), and the test log at drive-<n>.log. Exit code is Playwright's.
#
# The specs change the database. Several are one serial story (journey, shell, teams); a second run of a spec that
# creates a department or team by name collides with its first run. Relaunch (cleanup, launch) for a clean story.
set -euo pipefail
# shellcheck disable=SC1091
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

[[ $# -gt 0 ]] || die "usage: drive.sh <spec file regex> [playwright test options]"
load_state
[[ -f "$RUN_DIR/secrets.env" ]] || die "$RUN_DIR/secrets.env missing: this run was cleaned up"
set -a
# shellcheck disable=SC1091
. "$RUN_DIR/secrets.env"
set +a
serve_alive "$VERIFY_PID" || die "the stack of this run is not alive: run scripts/doctor.sh"

n="$(find "$RUN_DIR" -maxdepth 1 -name 'drive-*.log' | wc -l)"
export E2E_SCREENSHOT_DIRECTORY="$RUN_DIR/screenshots"
export PLAYWRIGHT_JSON_OUTPUT_NAME="$RUN_DIR/results-$n.json"
echo "driving: $* (log $RUN_DIR/drive-$n.log)"
set +e
in_devenv bash -c 'cd apps/web && exec bunx playwright test --config e2e/playwright.config.ts --reporter=list,json --trace on --output "$1" "${@:2}"' _ "$RUN_DIR/playwright" "$@" 2>&1 | tee "$RUN_DIR/drive-$n.log"
code="${PIPESTATUS[0]}"
set -e
echo "playwright exit code: $code" | tee -a "$RUN_DIR/drive-$n.log"
exit "$code"
