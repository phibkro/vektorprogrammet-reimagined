#!/usr/bin/env bash
# A screenshot of one page as one actor, in the devenv's Chromium (Playwright's own `screenshot` command). Usage:
#
#   scripts/shot.sh <path> <name> --as "<seeded person>"|anonymous [--phone]
#
# Writes screenshots/<name>.png in the run directory (full page, 1280x900; --phone is 390x844) after the page's
# scripts had 2 s to hydrate. It only loads the page. A click-through needs a spec (scripts/drive.sh) or your own
# browser driver pointed at the origin in state.env, with the actor cookie set.
set -euo pipefail
# shellcheck disable=SC1091
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

path="${1:?usage: shot.sh <path> <name> --as <person|anonymous> [--phone]}"
name="${2:?usage: shot.sh <path> <name> --as <person|anonymous> [--phone]}"
shift 2
actor="" viewport="1280,900"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --as) actor="$2"; shift 2 ;;
    --phone) viewport="390,844"; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ -n "$actor" ]] || die "--as is required: name a seeded person, or 'anonymous'"

load_state
storage="$RUN_DIR/pages/.storage-$name.json"
printf '{"cookies":[{"name":"vp-test-actor","value":"%s","domain":"localhost","path":"/","expires":-1,"httpOnly":false,"secure":false,"sameSite":"Lax"}],"origins":[]}\n' "$actor" >"$storage"
trap 'rm -f "$storage"' EXIT

STORAGE="$storage" VIEWPORT="$viewport" URL="$E2E_BASE_URL$path" OUT="$RUN_DIR/screenshots/$name.png" \
  in_devenv bash -c 'cd apps/web && bunx playwright screenshot --browser chromium --load-storage "$STORAGE" --viewport-size "$VIEWPORT" --full-page --wait-for-timeout 2000 "$URL" "$OUT"' >/dev/null
echo "saved: $RUN_DIR/screenshots/$name.png ($path as $actor, ${viewport/,/x})"
