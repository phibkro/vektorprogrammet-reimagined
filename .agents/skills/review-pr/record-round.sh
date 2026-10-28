#!/usr/bin/env bash
# record-round.sh <pr> <round> <pass|changes> <body-file>
# Posts one review round on the PR as a GitHub review (comment), headed by the marker that merge.sh requires.
# The head is read from GitHub, so a record always names the commit that was reviewed.
set -euo pipefail
[ $# -eq 4 ] || { echo "usage: record-round.sh <pr> <round> <pass|changes> <body-file>" >&2; exit 64; }
n=$1; round=$2; verdict=$3; body=$4
case "$verdict" in pass|changes) ;; *) echo "verdict must be pass or changes" >&2; exit 64 ;; esac
[[ "$round" =~ ^[1-9][0-9]*$ ]] || { echo "round must be a positive integer" >&2; exit 64; }
[ -s "$body" ] || { echo "body file is empty or missing: $body" >&2; exit 64; }
head=$(gh pr view "$n" --json headRefOid --jq .headRefOid)
{
  echo "<!-- review-round n=$round head=$head verdict=$verdict -->"
  echo "## Review round $round on \`${head:0:7}\`: $verdict"
  echo
  cat "$body"
} | gh pr review "$n" --comment --body-file -
echo "#$n round $round recorded on ${head:0:8}: $verdict"
