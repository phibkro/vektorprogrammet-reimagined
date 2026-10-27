#!/bin/sh
# Rebuilds the scratch copy of packages/db on final drizzle-orm 1.0.0-rc.5 (the catalog stays on the pinned build).
# Run from the repository root inside `devenv shell`; then run the probes from packages/db-rc5:
#   SPIKE_TARGET=postgres SPIKE_SCENARIO=report|behaviour|readonly|strategy bun spike/run.ts
# Do not commit packages/db-rc5 or the bun.lock change it causes.
set -eu
rm -rf packages/db-rc5
mkdir packages/db-rc5
(cd packages/db && tar cf - --exclude=node_modules .) | (cd packages/db-rc5 && tar xf -)
cd packages/db-rc5
jq '.name="@vektorprogrammet/db-rc5" | .dependencies["drizzle-orm"]="1.0.0-rc.5" | .devDependencies["drizzle-kit"]="1.0.0-rc.5" | del(.exports)' package.json > package.json.new
mv package.json.new package.json
sed -i 's#@vektorprogrammet/db/testing/read-only-role#../test/support/readOnlyRole.ts#; s#@vektorprogrammet/db/testing#../test/support/disposableDatabase.ts#' spike/run.ts
cd ../..
bun install
