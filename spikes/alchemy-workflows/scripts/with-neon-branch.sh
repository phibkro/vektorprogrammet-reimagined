#!/usr/bin/env bash
# The throwaway Neon branch of the workflows spike's cloud run: create it, delete it, and run a command with the values
# for it. Derived from tools/with-neon-env.sh (same repository), which is hard-wired to the branch `dev`; this one takes
# the branch as an argument, so that the spike never has to touch `dev`.
#
# Run it under `secretspec run --` (it needs NEON_API_KEY, and NEON_APP_PASSWORD for `app`/`both`), with a
# SECRETSPEC_REASON:
#
#   create <branch>            fork the branch from `dev` (the migrated, fake-data branch), expiring in three hours
#   delete <branch>            drop the branch
#   list                       the branch names of the project
#   app <branch> <command...>  NEON_HOST, NEON_DATABASE, NEON_USER: what alchemy.cloud.ts reads (the Hyperdrive origin,
#                              role vp_app; its password is NEON_APP_PASSWORD, which stays in the environment)
#   owner <branch> <command...> DATABASE_URL: `neondb_owner` over a direct connection (tables, grants, fixtures)
#   both <branch> <command...> both
#
# Nothing is printed or written but the fields of `create` and `list` named below: the URLs hold passwords and live only
# in the command's environment. `neonctl`'s JSON for a created branch includes connection URIs, so it is never shown.
set -euo pipefail

: "${NEON_API_KEY:?run this under: secretspec run --}"
mode="${1:?usage: with-neon-branch.sh <create|delete|list|app|owner|both> [<branch> [command...]]}"
branch="${2:-}"
project=bold-poetry-64036846
database=vektorprogrammet

# Only a spike-workflows-* branch is ever the target: `dev`, the shared data, is the parent and nothing else.
if [ "$mode" != list ]; then
  case "$branch" in
    spike-workflows-?*) ;;
    *) echo "refusing branch '${branch}': this script only handles spike-workflows-* branches" >&2; exit 2 ;;
  esac
fi

# Neon rejects a connection that inherits the devenv PostgreSQL's PGHOST.
unset PGHOST PGPORT PGDATA

# neonctl reads NEON_API_KEY from the environment: the key is never an argument, so it is not in a process listing.
neon() { bunx --bun neonctl@8.7.2 --project-id "$project" "$@"; }

connection_string() { neon connection-string "$branch" --role-name "$1" --database-name "$database"; }

case "$mode" in
  create)
    : "${branch:?create needs a branch name}"
    expires="$(date -u -d '+3 hours' +%Y-%m-%dT%H:%M:%SZ)"
    neon branches create --name "$branch" --parent dev --expires-at "$expires" --output json |
      bun -e 'const r = JSON.parse(await Bun.stdin.text()); console.log(JSON.stringify({ branch: r.branch?.name, id: r.branch?.id, expiresAt: r.branch?.expires_at, endpoints: (r.endpoints ?? []).length }))'
    ;;
  delete)
    : "${branch:?delete needs a branch name}"
    neon branches delete "$branch"
    ;;
  list)
    neon branches list --output json |
      bun -e 'const r = JSON.parse(await Bun.stdin.text()); for (const b of r) console.log(b.name)'
    ;;
  app | owner | both)
    : "${branch:?$mode needs a branch name}"
    shift 2
    [ "$#" -gt 0 ] || { echo "$mode needs a command to run" >&2; exit 2; }

    if [ "$mode" != owner ]; then
      NEON_HOST="$(connection_string vp_app | bun -e 'console.log(new URL((await Bun.stdin.text()).trim()).hostname)')"
      export NEON_HOST NEON_DATABASE="$database" NEON_USER=vp_app
    fi

    if [ "$mode" != app ]; then
      DATABASE_URL="$(connection_string neondb_owner)"
      export DATABASE_URL
    fi

    unset NEON_API_KEY
    exec "$@"
    ;;
  *)
    echo "unknown mode: $mode" >&2
    exit 2
    ;;
esac
