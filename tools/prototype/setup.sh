#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
exec bash tools/prototype/with-env.sh bash -c '
  set -euo pipefail
  (cd packages/db && bun run db:migrate && bun run db:seed:local)
  bun tools/prototype/seed.ts
'
