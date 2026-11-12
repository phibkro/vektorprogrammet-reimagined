#!/usr/bin/env bash
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(git -C "$here" rev-parse --show-toplevel)
skill="$here/SKILL.md"
coverage=$(awk '/^```coverage$/{f=1;next} /^```$/{f=0} f' "$skill")
sync_digest=$(printf '%s\n' "$coverage" | sed -n 's/^sync-digest: *//p' | head -n 1)
mapfile -t covered < <(printf '%s\n' "$coverage" | grep -vE '^(sync-digest:|confirmed-at:|#|$)')
[ -n "$sync_digest" ] && [ "${#covered[@]}" -gt 0 ] || { echo 'missing coverage record' >&2; exit 2; }
digest() { local tree; tree=$(git -C "$root" ls-tree -r "$1" -- "${covered[@]}"); [ -n "$tree" ] || return 1; printf '%s\n' "$tree" | git -C "$root" hash-object --stdin; }
case "${1:-}" in
 --digest) [ $# -eq 1 ] || exit 2; digest HEAD; exit ;;
 --touched)
   [ $# -eq 2 ] || { echo 'usage: run.sh --touched <base>' >&2; exit 2; }
   changed=$(git -C "$root" diff --name-only "$2"...HEAD -- "${covered[@]}" "${here#"$root"/}" devenv.nix devenv.lock)
   if [ "$(digest HEAD)" != "$sync_digest" ]; then echo "coverage digest drift" >&2; exit 3; fi
   if [ -n "$changed" ]; then echo touched; printf '%s\n' "$changed" >&2; else echo untouched; fi
   exit ;;
 '') ;;
 *) echo 'usage: run.sh [--digest | --touched <base>]' >&2; exit 2 ;;
esac
command -v tlc >/dev/null || { echo 'tlc missing; use the formal devenv profile' >&2; exit 2; }
out=${VERIFY_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/verify-job-runs.XXXXXX")}
mkdir -p "$out"
status=0
if [ "$(digest HEAD)" != "$sync_digest" ]; then echo 'coverage digest drift' >&2; status=3; fi
if [ -n "$(git -C "$root" status --porcelain -- "${covered[@]}")" ]; then echo 'warning: coverage digest compares HEAD, not working tree' >&2; fi
matrix=(
 'current|current|Spec|NoTwoLive NoStaleWrite AtMostOnce TerminalStable HonestReports DoneHasEnd|pass'
 'holders|holders|Spec|NoTwoLive|NoTwoLive'
 'fence|fence|Spec|NoStaleWrite|NoStaleWrite'
 'atomic|atomic|Spec|AtMostOnce|AtMostOnce'
 'terminal|terminal|Spec|TerminalStable|TerminalStable'
 'progress|current|ProgressSpec|EventuallyTerminal|pass'
 'crashes|current|CrashSpec|EventuallyTerminal|pass'
 'legacy-crash|legacy|CrashSpec|EventuallyTerminal|liveness'
 'legacy-report|legacy|Spec|HonestReports|HonestReports'
 'legacy-check|legacy|Spec|DoneHasEnd|DoneHasEnd'
 'unbounded|unbounded|CrashSpec|EventuallyTerminal|liveness'
 'reports|reports|Spec|HonestReports|HonestReports'
 'check|check|Spec|DoneHasEnd|DoneHasEnd'
)
for entry in "${matrix[@]}"; do
 IFS='|' read -r name variant spec properties expected <<<"$entry"
 {
  printf 'SPECIFICATION %s\nCONSTANTS\n Workers = {w1, w2}\n MaxAttempts = 2\n Chunks = 2\n Variant = "%s"\n' "$spec" "$variant"
  if [[ "$properties" == EventuallyTerminal ]]; then printf 'PROPERTY %s\n' "$properties"; else printf 'INVARIANTS\n'; for p in $properties; do printf ' %s\n' "$p"; done; fi
 } > "$out/$name.cfg"
 start=$SECONDS
 (cd "$here/model" && JAVA_TOOL_OPTIONS="-Xmx${TLC_HEAP:-1g}" tlc -deadlock -workers "${TLC_WORKERS:-2}" -metadir "$out/$name.states" -config "$out/$name.cfg" JobRuns.tla) > "$out/$name.out" 2>&1 || true
 got=error
 if grep -q '^Model checking completed. No error has been found.' "$out/$name.out"; then got=pass
 elif grep -q '^Error: Temporal properties were violated\.' "$out/$name.out"; then got=liveness
 else got=$(sed -n 's/^Error: Invariant \(.*\) is violated\.$/\1/p' "$out/$name.out" | head -n 1); got=${got:-error}; fi
 printf '%-12s expected=%-16s got=%-16s %ss\n' "$name" "$expected" "$got" "$((SECONDS-start))"
 if [ "$got" != "$expected" ]; then status=1; fi
done
printf 'TLC output and configs: %s\n' "$out"
exit "$status"
