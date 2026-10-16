#!/usr/bin/env bash
# Runs a command with the Neon values slice 0000 needs, derived from SecretSpec's NEON_API_KEY.
# Run it under `secretspec run --` (it needs NEON_API_KEY, and NEON_APP_PASSWORD for a deploy).
#
#   app    NEON_HOST, NEON_DATABASE, NEON_USER: what the Alchemy stack declaration reads
#   owner  DATABASE_URL: `neondb_owner` over a direct connection (migrations, dropping the tables)
#   both   both of the above
#
# Nothing is printed or written: the URL holds a password and lives only in the command's environment.
set -euo pipefail

: "${NEON_API_KEY:?run this under: secretspec run --}"
mode="${1:?usage: with-neon-env.sh <app|owner|both> <command...>}"
shift

project=bold-poetry-64036846
branch=dev
database=vektorprogrammet

# Neon rejects a connection that inherits the devenv PostgreSQL's PGHOST.
unset PGHOST PGPORT PGDATA

connection_string() {
  bunx --bun neonctl@8.7.2 --api-key "$NEON_API_KEY" --project-id "$project" \
    connection-string "$branch" --role-name "$1" --database-name "$database"
}

case "$mode" in
  app | both)
    NEON_HOST="$(connection_string vp_app | bun -e 'console.log(new URL((await Bun.stdin.text()).trim()).hostname)')"
    export NEON_HOST NEON_DATABASE="$database" NEON_USER=vp_app
    ;;
esac

case "$mode" in
  owner | both)
    DATABASE_URL="$(connection_string neondb_owner)"
    export DATABASE_URL
    ;;
esac

unset NEON_API_KEY
exec "$@"
