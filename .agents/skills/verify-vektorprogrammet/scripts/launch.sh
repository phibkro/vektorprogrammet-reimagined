#!/usr/bin/env bash
# Starts the stack to verify and stays in the foreground until it is interrupted. Usage (from anywhere in the tree):
#
#   scripts/launch.sh
#
# Run it under a supervisor that keeps custody of the process and can wait for its ready line (OMP: the bash tool with a
# `name` and `ready.log` of `VERIFY READY`; Herdr/hub: `hub start` then `hub wait`). Never background it with
# nohup/setsid/&: custody of the process is what makes the cleanup reliable.
#
# It: refuses to double-drive, checks headroom, makes sure devenv's PostgreSQL runs, adds the harness files an older
# worktree lacks (the "overlay"), then execs `bun e2e/serve.ts` (apps/web), which owns a disposable migrated and
# seeded database, the CMS and `vp dev` and prints `VERIFY READY ...` when the instance is usable.
# SIGTERM may end serve.ts with status 143 before scoped processes exit; run cleanup.sh to sweep recorded resources.
set -euo pipefail
# shellcheck disable=SC1091
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# 1. One instance per worktree: a second launch would corrupt the first one's database, ports and evidence.
if [[ -f "$POINTER" ]]; then
  previous="$(<"$POINTER")"
  pid_of_previous="$(sed -n 's/^VERIFY_PID=//p' "$previous/state.env" 2>/dev/null || true)"
  if serve_alive "$pid_of_previous"; then
    die "run $previous is still alive (pid $pid_of_previous). Drive it, or stop it (scripts/cleanup.sh) first; refusing to start a second one in $TREE"
  fi
  echo "note: stale run $previous (its stack is gone); running its cleanup first" >&2
  VERIFY_RUN_DIR="$previous" "$SKILL_DIR/scripts/cleanup.sh" >&2
fi

# 2. Heavy job: admit it only with headroom.
if [[ "${VERIFY_FORCE:-0}" == 1 ]]; then
  echo "warning: VERIFY_FORCE=1, headroom was not checked; say so in the review" >&2
else
  "$SKILL_DIR/scripts/headroom.sh"
fi

# 2b. Install exactly what the lockfile says, inside devenv (the system Bun hangs on `bun install`). Always, not only in a
#     fresh worktree: a checkout of another commit (a rebase, a PR head) may have new dependencies, and a stale
#     node_modules fails late (the first run after the rebase onto spec 0007 died on a missing `bcryptjs` during the
#     seed). With nothing to change it takes a few seconds. The root `prepare` script runs too, as for any checkout.
in_devenv bun install --frozen-lockfile
run_id="$(date -u +%Y%m%dT%H%M%SZ)-$(git -C "$TREE" rev-parse --short HEAD)"
RUN_DIR="$EVIDENCE_ROOT/$run_id"
mkdir -p "$RUN_DIR/screenshots" "$RUN_DIR/pages" "$RUN_DIR/playwright"
: >"$RUN_DIR/overlay.list"
{
  echo "VERIFY_TREE=$TREE"
  echo "REVISION=$(git -C "$TREE" rev-parse HEAD)"
  echo "BRANCH=$(git -C "$TREE" rev-parse --abbrev-ref HEAD)"
  echo "STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "STARTED_SERVICES=0"
  echo "FORCED=${VERIFY_FORCE:-0}"
} >"$RUN_DIR/meta.env"
git -C "$TREE" status --porcelain >"$RUN_DIR/git-status.txt"
echo "$RUN_DIR" >"$POINTER"
echo "run directory: $RUN_DIR (evidence goes here and survives cleanup)"
# 3. devenv's PostgreSQL (the disposable database is created in it) and MySQL (the importer loads its fake legacy
#    fixture into a throwaway MySQL database first). Ready means usable, not just that a port answers: PostgreSQL
#    accepts connections and MySQL has finished its init scripts (the SELECT-only `legacy_reader` user exists).
#    Start both together with `devenv up -d`: starting PostgreSQL alone and adding MySQL later starts MySQL without
#    its configure task, so `legacy_reader` and `legacy` never appear and the importer fails. Hence the bounded wait.
services_usable='pg_isready -q -d "$TEST_DATABASE_ADMIN_URL" && mysql -uroot --socket="$MYSQL_UNIX_PORT" -Nse "select 1 from mysql.user where user = '\''legacy_reader'\''" | grep -q 1'
if [[ "${VERIFY_FORCE_SERVICE_READINESS_FAILURE:-0}" == 1 ]]; then
  services_usable=false
fi
if ! in_devenv bash -c "$services_usable" >/dev/null 2>&1; then
  # Mark ownership before startup so cleanup handles a partially successful devenv up.
  sed -i 's/^STARTED_SERVICES=.*/STARTED_SERVICES=1/' "$RUN_DIR/meta.env"
   (cd "$TREE" && devenv up -d)
  wait_seconds="${VERIFY_SERVICES_WAIT_SECONDS:-120}"
  [[ "$wait_seconds" =~ ^[0-9]+$ ]] || die "VERIFY_SERVICES_WAIT_SECONDS must be a non-negative integer"
  in_devenv bash -c "for _ in \$(seq $wait_seconds); do $services_usable && exit 0; sleep 1; done; exit 1" >/dev/null \
    || die "devenv's PostgreSQL and MySQL are not usable after $wait_seconds s (legacy_reader missing?). Run scripts/cleanup.sh to stop services started by this launch."
fi

# 4. Overlay: a worktree older than this skill lacks the harness's keep-alive entry point. Copy it in as untracked
#    verification scaffolding and record it; cleanup.sh removes exactly what is listed.
# Continue using the run directory and overlay ledger created before service startup.
for file in apps/web/e2e/serve.ts apps/web/e2e/support/stack.ts; do
  if [[ ! -e "$TREE/$file" ]]; then
    [[ "$SKILL_TREE" != "$TREE" && -e "$SKILL_TREE/$file" ]] || die "$TREE lacks $file and the skill's own tree cannot supply it"
    cp "$SKILL_TREE/$file" "$TREE/$file"
    echo "$file" >>"$RUN_DIR/overlay.list"
    echo "overlay: copied $file into $TREE (untracked; cleanup.sh removes it)" >&2
  fi
done

# Run metadata and pointer already exist, including service ownership if startup was attempted.
echo "run directory: $RUN_DIR (evidence goes here and survives cleanup)"

# Everything the stack prints (vp dev, the CMS, the capture sink's "outbox message captured" lines) is evidence too.
exec > >(tee -a "$RUN_DIR/serve.log") 2>&1
cd "$TREE"
export VERIFY_RUN_DIR="$RUN_DIR"
exec devenv shell -- bash -c 'cd apps/web && exec bun e2e/serve.ts'
