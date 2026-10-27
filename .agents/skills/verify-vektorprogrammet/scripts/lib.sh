#!/usr/bin/env bash
# Shared by the other scripts here; source it, do not run it.
#
# Where things are:
#   TREE      the worktree under verification: $VERIFY_TREE, else the git toplevel of the current directory.
#   RUN_DIR   this run's directory, in the evidence root, outside every path a worktree cleanup removes:
#             $VERIFY_RUN_DIR, else the one the tree's pointer names (written by launch.sh, removed by cleanup.sh).
#   EVIDENCE_ROOT  $VERIFY_EVIDENCE_ROOT, else ~/.local/state/vektorprogrammet-verify.

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The checkout this skill itself sits in (<tree>/.agents/skills/verify-vektorprogrammet): the source of the harness
# files that an older worktree may lack (see launch.sh, "overlay").
SKILL_TREE="$(cd "$SKILL_DIR/../../.." && pwd)"

EVIDENCE_ROOT="${VERIFY_EVIDENCE_ROOT:-$HOME/.local/state/vektorprogrammet-verify}"

TREE="${VERIFY_TREE:-$(git rev-parse --show-toplevel)}"
TREE="$(cd "$TREE" && pwd)"

# One pointer per worktree, inside that worktree's private git directory: not tracked, not touched by git clean.
POINTER="$(git -C "$TREE" rev-parse --absolute-git-dir)/verify-run"

die() { echo "error: $*" >&2; exit 1; }

# Runs a command inside the tree's devenv shell (Bun, Node, psql and Playwright's Chromium come from there). devenv's own
# "Running devenv:..." task lines are dropped from stderr; the command's output is untouched.
in_devenv() { (cd "$TREE" && devenv shell -- "$@") 2> >(grep --line-buffered -v -E '^[•✓✖] Running devenv:' >&2); }

resolve_run_dir() {
  if [[ -n "${VERIFY_RUN_DIR:-}" ]]; then
    RUN_DIR="$VERIFY_RUN_DIR"
  elif [[ -f "$POINTER" ]]; then
    RUN_DIR="$(<"$POINTER")"
  else
    die "no run for $TREE: start one with scripts/launch.sh (or set VERIFY_RUN_DIR)"
  fi
  [[ -d "$RUN_DIR" ]] || die "run directory $RUN_DIR does not exist"
}

# Reads state.env (origins, database URL, pid; no secrets) and meta.env (what launch.sh decided) of the run.
load_state() {
  resolve_run_dir
  [[ -f "$RUN_DIR/state.env" ]] || die "$RUN_DIR/state.env missing: the stack never became ready (see $RUN_DIR/serve.log)"
  set -a
  # shellcheck disable=SC1091
  . "$RUN_DIR/state.env"
  # shellcheck disable=SC1091
  . "$RUN_DIR/meta.env"
  set +a
}

# True when the pid is alive and is the serve.ts this run started (not a recycled pid).
serve_alive() {
  local pid="${1:-}"
  [[ -n "$pid" && -r "/proc/$pid/cmdline" ]] && tr '\0' ' ' <"/proc/$pid/cmdline" | grep -q 'e2e/serve.ts'
}

# The port of an http://host:port origin.
port_of() { sed -E 's#^[a-z]+://[^:/]+:([0-9]+).*#\1#' <<<"$1"; }

# The pids listening on a TCP port (ours: the ports are random and recorded in state.env).
listeners_on() { ss -Htlnp "sport = :$1" 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u; }

# The name of the disposable database in a postgres:// URL.
database_of() { sed -E 's#^[a-z]+://[^/]+/([^?]+).*#\1#' <<<"$1"; }
