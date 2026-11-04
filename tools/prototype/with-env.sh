#!/usr/bin/env bash
# Provider status and runtime URL files are private and never sent to the Worker.
set -euo pipefail
: "${SUPABASE_ENV_FILE:?Set SUPABASE_ENV_FILE to a private local Supabase status file}"
unset DATABASE_URL MIGRATION_DATABASE_URL
: "${RUNTIME_DATABASE_URL_FILE:?Set RUNTIME_DATABASE_URL_FILE to the private runtime URL file}"
set -a
# shellcheck disable=SC1090
source "$SUPABASE_ENV_FILE"
set +a
unset DATABASE_URL MIGRATION_DATABASE_URL
: "${API_URL:?Missing API_URL}" "${DB_URL:?Missing DB_URL}" "${PUBLISHABLE_KEY:?Missing PUBLISHABLE_KEY}" "${SECRET_KEY:?Missing SECRET_KEY}"
export SUPABASE_URL="$API_URL" SUPABASE_PUBLISHABLE_KEY="$PUBLISHABLE_KEY" SUPABASE_SECRET_KEY="$SECRET_KEY"
export DEPLOYMENT=local
# Bootstrap invokes this explicit mode only; ordinary processes never inherit admin credentials.
if [[ "${1:-}" == --bootstrap ]]; then
  shift
  export MIGRATION_DATABASE_URL="$DB_URL"
else
  [[ -f "$RUNTIME_DATABASE_URL_FILE" ]] || { echo 'Runtime URL missing; provision the owned synthetic target first' >&2; exit 1; }
  DATABASE_URL="$(<"$RUNTIME_DATABASE_URL_FILE")"
  export DATABASE_URL
fi
bun -e '
for (const [name, protocols] of [["API_URL", ["http:"]], ["DB_URL", ["postgres:", "postgresql:"]]]) {
  const u = new URL(process.env[name]);
  if (!protocols.includes(u.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) || u.search || u.hash) throw new Error(`${name} must be a direct localhost URL`);
}
if (process.env.DATABASE_URL) {
  const u = new URL(process.env.DATABASE_URL), admin = new URL(process.env.DB_URL);
  if (u.username !== "vektor_runtime" || u.hostname !== admin.hostname || u.port !== admin.port || u.pathname !== admin.pathname || u.search || u.hash) throw new Error("Runtime URL does not match target");
}
' || { echo 'Refusing invalid prototype target' >&2; exit 1; }
unset DB_URL API_URL SECRET_KEY PUBLISHABLE_KEY SUPABASE_ENV_FILE PGHOST PGPORT PGDATA PGUSER PGPASSWORD PGSERVICE PGOPTIONS
if [[ -z "${MIGRATION_DATABASE_URL:-}" ]]; then unset MIGRATION_DATABASE_URL; fi
exec "$@"
