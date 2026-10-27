#!/usr/bin/env bash
# One command for the verify-membership-writes skill (read SKILL.md first).
#
#   devenv shell --profile formal -- .agents/skills/verify-membership-writes/run.sh [--quick] [--code] [--list]
#   .agents/skills/verify-membership-writes/run.sh --touched <base-ref>   (no tools needed; used by CI)
#
# It does these things, in this order:
#   1. DRIFT: has covered code changed since the sync commit in SKILL.md, or is there a writer of `membership`
#      that the model does not know? Either one means the model may describe code that no longer exists.
#   2. CURRENT CODE: model-check every property against the code as model/Shapes.tla describes it. Must pass.
#   3. GOALS (reach-*): the model can do what the properties are about: each of these must be reachable.
#   4. BROKEN VARIANTS: model-check each variant (the real code with one edit). Each must fail on its property;
#      a variant that passes means the property cannot fail, which is a defect of the verification.
#   5. WHAT-IFS and DESIGN (whatif-*, design-*): commands and the spec 0006b design that are not code yet.
#   6. With --code: the tests of the real repositories that pin each fact that Shapes.tla takes from the code
#      (needs PostgreSQL: `devenv up -d postgres`).
#
# Exit status: 0 all as expected; 1 an unexpected result (the code breaks a property, a variant is not caught, a
# code test fails); 2 the tool or a file is missing, or the machine has no headroom; 3 only drift (every run was
# as expected, but the coverage in SKILL.md is stale). Output of every TLC run is kept in $VERIFY_OUT (default: a
# new folder under $TMPDIR), one .out and one .cfg each.
#
# --touched <base-ref> answers only "does the diff from <base-ref> to HEAD concern this verification?": a covered
# file, this skill, the formal profile, or a writer of `membership` that is not in the coverage list. It prints
# `touched` or `untouched` and exits 0, so CI runs the model exactly when the coverage block says it must.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
model="$here/model"
skill="$here/SKILL.md"
root=$(git -C "$here" rev-parse --show-toplevel)
workers=${TLC_WORKERS:-8}
heap=${TLC_HEAP:-2g}
quick=0
code=0

# name | module | code | transactions | invariants | expected result
# `pass` or `fails:<Invariant>`. Every name is also in SKILL.md (checked below).
matrix=(
  "current-code|Race|CurrentCode|3|NoDeadlockAbort NoOverlapCommitted RefusalsAreTrue LegalAtApply|pass"
  "reach-overlap-loser|Race|CurrentCode|2|NeverAlreadyExists|fails:NeverAlreadyExists"
  "reach-lost-transition|Race|CurrentCode|2|NeverConflict|fails:NeverConflict"
  "reach-lock-wait|Race|CurrentCode|2|NeverWaitsForLock|fails:NeverWaitsForLock"
  "reach-check-wait-on-unlocked-remove|Race|CurrentCode|2|NeverWaitsInCheck|fails:NeverWaitsInCheck"
  "reach-change-commits|Race|CurrentCode|2|NeverChangeCommits|fails:NeverChangeCommits"
  "reach-all-commit|Race|CurrentCode|2|NeverAllCommit|fails:NeverAllCommit"
  "insert-without-lock|Race|InsertWithoutLock|2|NoDeadlockAbort|fails:NoDeadlockAbort"
  "setend-without-lock|Race|SetEndWithoutLock|2|NoDeadlockAbort|fails:NoDeadlockAbort"
  "insert-locks-after-write|Race|InsertLocksAfterWrite|2|NoDeadlockAbort|fails:NoDeadlockAbort"
  "setend-without-observed-end|Race|SetEndWithoutObservedEnd|2|LegalAtApply|fails:LegalAtApply"
  "setend-unconditional|Race|SetEndUnconditional|2|LegalAtApply|fails:LegalAtApply"
  "no-exclusion-constraint|Race|NoExclusionConstraint|2|NoOverlapCommitted|fails:NoOverlapCommitted"
  "deadlock-mapped-to-already-exists|Race|DeadlockMappedToAlreadyExists|2|RefusalsAreTrue|fails:RefusalsAreTrue"
  "story-r6-deadlock|Story|InsertWithoutLock|2|NoDeadlockAbort|fails:NoDeadlockAbort"
  "story-r6-fixed|Story|CurrentCode|2|NoDeadlockAbort NoOverlapCommitted RefusalsAreTrue LegalAtApply|pass"
  "whatif-replace-without-lock|WhatIf|WithReplace|2|NoDeadlockAbort|fails:NoDeadlockAbort"
  "whatif-replace-locked-first|WhatIf|WithReplaceLockedFirst|2|NoDeadlockAbort|pass"
  "whatif-all-writes-locked|WhatIf|WithReplaceAllWritesLocked|3|NoDeadlockAbort|pass"
  "design-two-persons-call-order|Pair|LocksInCallOrder|2|NoDeadlockAbort|fails:NoDeadlockAbort"
  "design-two-persons-id-order|Pair|LocksInIdOrder|3|NoDeadlockAbort|pass"
)
# The slowest runs; --quick leaves them out and checks the current code with two transactions instead of three.
quick_skip='^whatif-all-writes-locked$'

# The tests of the real code that pin what Shapes.tla takes from it (SKILL.md, "What pins the model to the code").
code_tests=(
  test/membershipWriteModel.postgres.test.ts
  test/teams.postgres.test.ts
  test/classifySqlFailure.test.ts
)

touched_base=""
while [ $# -gt 0 ]; do
  case "$1" in
    --quick) quick=1 ;;
    --code) code=1 ;;
    --list) printf '%s\n' "${matrix[@]}" | awk -F'|' '{printf "%-36s %-6s %-30s N=%s  %s -> %s\n", $1, $2, $3, $4, $5, $6}'; exit 0 ;;
    --touched) shift; touched_base=${1:-}; [ -n "$touched_base" ] || { echo "usage: run.sh --touched <base-ref>" >&2; exit 2; } ;;
    *) echo "usage: run.sh [--quick] [--code] [--list] | --touched <base-ref>" >&2; exit 2 ;;
  esac
  shift
done

coverage=$(awk '/^```coverage$/{f=1;next} /^```$/{f=0} f' "$skill")
sync=$(printf '%s\n' "$coverage" | sed -n 's/^sync-commit: *//p' | head -n 1)
mapfile -t covered < <(printf '%s\n' "$coverage" | grep -vE '^(sync-commit:|#|$)')
if [ -z "$sync" ] || [ "${#covered[@]}" -eq 0 ]; then
  echo "SKILL.md has no coverage block (sync-commit and covered paths)." >&2
  exit 2
fi
membership_writers() {
  git -C "$root" grep -lE '(insert|update|delete)\((schema\.)?membership\)|(insert into|update|delete from) +"?membership"?[ (]' \
    -- packages apps tools ':(exclude).agents' ':(exclude)*/test/*' ':(exclude)*/e2e/*' ':(exclude)*.md' || true
}

if [ -n "$touched_base" ]; then
  skill_dir=${here#"$root"/}
  changed=$(git -C "$root" diff --name-only "$touched_base"...HEAD -- "${covered[@]}" "$skill_dir" devenv.nix devenv.lock)
  unknown=$(membership_writers | grep -vxF -f <(printf '%s\n' "${covered[@]}") | grep -v '^$' || true)
  if [ -n "$changed" ] || [ -n "$unknown" ]; then
    echo "touched"
    printf '%s\n' "$changed" "$unknown" | grep -v '^$' | sed 's/^/  /' >&2
  else
    echo "untouched"
  fi
  exit 0
fi

if ! command -v tlc >/dev/null 2>&1; then
  echo "tlc is not on PATH. Run this inside the formal profile of devenv:" >&2
  echo "  devenv shell --profile formal -- .agents/skills/verify-membership-writes/run.sh" >&2
  exit 2
fi

out=${VERIFY_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/verify-membership-writes.XXXXXX")}
mkdir -p "$out"
status=0
drift=0

# ---------------------------------------------------------------- 1. drift
if ! git -C "$root" cat-file -e "$sync^{commit}" 2>/dev/null; then
  echo "DRIFT  the sync commit $sync is not in this repository: fetch it, or confirm the model against HEAD and move the sync commit."
  drift=1
else
  changed=$(git -C "$root" diff --name-only "$sync" -- "${covered[@]}")
  if [ -n "$changed" ]; then
    echo "DRIFT  covered code changed since the sync commit ${sync:0:9}. Read each change, update model/Shapes.tla from the code,"
    echo "       run again, then move the sync commit (SKILL.md, \"Update the model after a change\"):"
    while IFS= read -r file; do echo "         git diff ${sync:0:9} -- $file"; done <<<"$changed"
    drift=1
  else
    echo "ok     covered code is unchanged since the sync commit ${sync:0:9}"
  fi
fi

writers=$(membership_writers)
unknown=$(printf '%s\n' "$writers" | grep -vxF -f <(printf '%s\n' "${covered[@]}") | grep -v '^$' || true)
if [ -n "$unknown" ]; then
  echo "DRIFT  a writer of the membership table is not in the coverage list. Add its statements to model/Shapes.tla (a repository"
  echo "       method and the commands that call it), then list the file in SKILL.md:"
  while IFS= read -r file; do echo "         $file"; done <<<"$unknown"
  drift=1
else
  echo "ok     every writer of the membership table is covered: $(printf '%s' "$writers" | tr '\n' ' ')"
fi

for entry in "${matrix[@]}"; do
  name=${entry%%|*}
  grep -q -- "$name" "$skill" || echo "warn   SKILL.md does not mention the run $name"
done

# ---------------------------------------------------------------- headroom (the machine is shared)
if [ -r /proc/loadavg ] && [ -r /proc/meminfo ]; then
  cpus=$(nproc)
  load=$(cut -d' ' -f1 /proc/loadavg)
  avail_mb=$(awk '/MemAvailable/{printf "%d", $2/1024}' /proc/meminfo)
  echo "load   $load on $cpus CPUs, ${avail_mb} MB available; TLC takes $workers workers and up to $heap of heap (about 1.6 GB resident)"
  if awk -v l="$load" -v c="$cpus" 'BEGIN{exit !(l > 0.8*c)}' || [ "$avail_mb" -lt 4096 ]; then
    echo "stop   the machine has no headroom (load above 80% of the CPUs, or under 4 GB free). Wait, or set TLC_WORKERS lower and FORCE=1." >&2
    [ "${FORCE:-0}" = 1 ] || exit 2
  fi
fi

# ---------------------------------------------------------------- 2-5. model checking
write_cfg() { # module code transactions invariants... > cfg
  local module=$1 code=$2 n=$3
  shift 3
  echo "SPECIFICATION Spec"
  echo "CONSTANTS"
  case "$n" in
    2) echo "    Txns = {t1, t2}" ;;
    3) echo "    Txns = {t1, t2, t3}" ;;
    *) echo "unsupported transaction count $n" >&2; exit 2 ;;
  esac
  echo "    NoTxn = NoTxn"
  echo "    Genesis = Genesis"
  echo "    NoRow = NoRow"
  echo "    Current = 2"
  case "$module" in
    Pair)
      echo "    Persons = {1, 2}"
      echo "    InitRows <- PairRows"
      echo "    Plans <- PairPlans" ;;
    Race | WhatIf | Story)
      echo "    Persons = {1}"
      echo "    r0 = r0"
      echo "    r1 = r1"
      case "$module" in
        Race) echo "    InitRows <- RaceRows"; echo "    Plans <- RacePlans" ;;
        WhatIf) echo "    InitRows <- RaceRows"; echo "    Plans <- WhatIfPlans" ;;
        Story) echo "    InitRows <- StoryRows"; echo "    Plans <- StoryPlans" ;;
      esac ;;
  esac
  echo "    Code <- $code"
  echo "SYMMETRY TxnSymmetry"
  echo "INVARIANTS"
  echo "    TypeOK"
  for invariant in "$@"; do echo "    $invariant"; done
}

printf '%-36s %-30s %s\n' "RUN" "EXPECTED" "RESULT"
for entry in "${matrix[@]}"; do
  IFS='|' read -r name module code_name n invariants expected <<<"$entry"
  if [ "$quick" = 1 ] && [[ "$name" =~ $quick_skip ]]; then continue; fi
  if [ "$quick" = 1 ] && [ "$name" = current-code ]; then n=2; fi
  # shellcheck disable=SC2086
  write_cfg "$module" "$code_name" "$n" $invariants >"$out/$name.cfg"
  started=$SECONDS
  (cd "$model" && JAVA_TOOL_OPTIONS="-Xmx$heap" tlc -workers "$workers" -metadir "$out/$name.states" -config "$out/$name.cfg" "$module.tla") >"$out/$name.out" 2>&1 || true
  rm -rf "$out/$name.states"
  took=$((SECONDS - started))
  violated=$(sed -n 's/^Error: Invariant \(.*\) is violated\.$/\1/p' "$out/$name.out" | head -n 1)
  states=""
  if grep -q '^Model checking completed. No error has been found.' "$out/$name.out"; then
    got=pass
    states=$(sed -n 's/^\([0-9,]*\) states generated, \([0-9,]*\) distinct states found.*/\2 states/p' "$out/$name.out" | head -n 1)
  elif [ -n "$violated" ]; then
    got="fails:$violated"
  else
    got="error"
  fi
  mark=""
  if [ "$got" != "$expected" ]; then
    mark="<<< UNEXPECTED (see $out/$name.out)"
    status=1
  fi
  printf '%-36s %-30s %-30s %4ss  %s %s\n' "$name" "$expected" "$got" "$took" "$states" "$mark"
done

# ---------------------------------------------------------------- 6. the code's own tests
if [ "$code" = 1 ]; then
  echo
  echo "CODE TESTS (real repositories on PostgreSQL): ${code_tests[*]}"
  if ! pg_isready -h 127.0.0.1 -p "${PGPORT:-54321}" >/dev/null 2>&1; then
    echo "stop   PostgreSQL is not running: devenv up -d postgres" >&2
    exit 2
  fi
  started=$SECONDS
  if (cd "$root/packages/db" && bunx vp test run "${code_tests[@]}") >"$out/code-tests.out" 2>&1; then
    echo "ok     $(grep -E '^ +Tests ' "$out/code-tests.out" | tr -s ' ') in $((SECONDS - started))s"
  else
    echo "FAIL   a test of the real code failed (see $out/code-tests.out). If the change that broke it is intended, the model's fact is stale: update model/Shapes.tla."
    grep -E '^ (FAIL|×)|AssertionError' "$out/code-tests.out" | head -n 10
    status=1
  fi
fi

echo
echo "TLC output and configs: $out"
if [ "$status" -ne 0 ]; then
  echo "RESULT: unexpected. Read each run marked <<< with the /statechart skill (SKILL.md, \"Read a result\")."
  exit 1
fi
if [ "$drift" -ne 0 ]; then
  echo "RESULT: every run was as expected, but the coverage is stale (DRIFT above). The pass describes the code at the sync commit, not at HEAD."
  exit 3
fi
echo "RESULT: ok. The current code keeps every property, and every broken variant is caught."
