#!/usr/bin/env bash
# SUPABASE_ENV_FILE is a private `supabase status -o env` file, never a hosted project's credentials.
set -euo pipefail
: "${SUPABASE_ENV_FILE:?Set SUPABASE_ENV_FILE to a private local supabase status -o env file}"
set -a
# shellcheck disable=SC1090
source "$SUPABASE_ENV_FILE"
set +a
: "${API_URL:?Missing API_URL}" "${DB_URL:?Missing DB_URL}" "${PUBLISHABLE_KEY:?Missing PUBLISHABLE_KEY}" "${SECRET_KEY:?Missing SECRET_KEY}"
# Reject remote hosts, alternate URL hosts, proxies and socket options before any write.
bun -e '
for (const [name, protocols] of [["API_URL", ["http:"]], ["DB_URL", ["postgres:", "postgresql:"]]]) {
  const u = new URL(process.env[name]);
  if (!protocols.includes(u.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) || u.search || u.hash) {
    throw new Error(`${name} must be a direct localhost URL without query parameters`);
  }
}
' || { echo 'Refusing non-local prototype target' >&2; exit 1; }
export DATABASE_URL="$DB_URL" SUPABASE_URL="$API_URL" SUPABASE_PUBLISHABLE_KEY="$PUBLISHABLE_KEY" SUPABASE_SECRET_KEY="$SECRET_KEY"
export DEPLOYMENT=local
unset PGHOST PGPORT PGDATA
exec "$@"
