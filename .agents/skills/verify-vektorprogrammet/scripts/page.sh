#!/usr/bin/env bash
# The server-rendered page a given actor gets, as evidence: status, redirect, title, h1 and, for the control panel,
# the sidebar's links. No browser: it shows what the server decided before any client script runs, which is where
# authorisation shows. Usage:
#
#   scripts/page.sh <path> --as "<seeded person>"|anonymous [--name <label>]
#
# Saves pages/<label>.html and pages/<label>.headers in the run directory and prints a summary. The default label is
# the actor and the path. The seeded people: Ada Admin, Lise Leder, Mats Medlem, Sofie Styre, Nora Nybegynner,
# Eva Ekstern (packages/domain/src/localPeople.ts); `anonymous` is nobody.
set -euo pipefail
# shellcheck disable=SC1091
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

path="${1:?usage: page.sh <path> --as <person|anonymous> [--name <label>]}"
shift
actor="" label=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --as) actor="$2"; shift 2 ;;
    --name) label="$2"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ -n "$actor" ]] || die "--as is required: name a seeded person, or 'anonymous' (the default actor is Ada Admin, which would hide a wrong assumption)"

load_state
label="${label:-$(tr -c 'A-Za-z0-9\n' '-' <<<"$actor$path" | tr 'A-Z' 'a-z')}"
body="$RUN_DIR/pages/$label.html"
headers="$RUN_DIR/pages/$label.headers"

status="$(curl -s --max-time 60 -H "Cookie: vp-test-actor=$actor" -D "$headers" -o "$body" -w '%{http_code}' "$E2E_BASE_URL$path")"
echo "GET $path as $actor -> $status"
grep -i '^location:' "$headers" | tr -d '\r' || true
echo "title: $(grep -o '<title>[^<]*' "$body" | head -1 | sed 's/<title>//')"
echo "h1:    $(grep -o '<h1[^>]*>[^<]*' "$body" | head -1 | sed 's/<h1[^>]*>//')"
echo "links: $(grep -o 'href="/kontrollpanel[^"]*"' "$body" | sort -u | sed 's/href=//' | tr '\n' ' ')"
echo "saved: $body (+ .headers)"
