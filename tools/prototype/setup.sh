#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
: "${SYNTHETIC_SUPABASE_OWNED:?Set SYNTHETIC_SUPABASE_OWNED=1 only for your isolated synthetic target}"
[[ "$SYNTHETIC_SUPABASE_OWNED" == 1 ]] || { echo 'Refusing unowned target' >&2; exit 1; }
bash tools/prototype/with-env.sh --bootstrap bash -c '
  set -euo pipefail
  (cd apps/web && bun run db:migrate && SEED_TARGET_DATABASE_URL="$MIGRATION_DATABASE_URL" bun run db:seed:local)
  DATABASE_URL="$MIGRATION_DATABASE_URL" bun tools/prototype/seed.ts
  bun tools/prototype/provisionRuntime.ts
'
