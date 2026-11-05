import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { PgClient } from "@effect/sql-pg";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { migrate } from "drizzle-orm/effect-postgres/migrator";
import { Effect, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";

import { DatabaseLive } from "../../apps/web/src/adapters/db/databaseLive.ts";
import {
  probeRuntimeLogin,
  provisionRuntimeAccess,
  runtimeRoleExists,
} from "../../apps/web/src/adapters/db/runtimeAccess.ts";
import { runtimeDatabaseUrl } from "../../apps/web/src/adapters/db/runtimeUrl.ts";
import { seedLocal } from "../../apps/web/test/db/support/localSeed.ts";
import { seedProvider } from "../prototype/seedProvider.ts";
import { readReceipt } from "./contracts.ts";
import { preflight } from "./supabase.ts";

const migrationsFolder = new URL("../../apps/web/drizzle/", import.meta.url)
  .pathname;

const program = Effect.gen(function* bootstrap() {
  const receipt = yield* readReceipt();
  // A local receipt is not authority: check live branch ownership and SMTP capture again.
  yield* preflight(receipt);
  const admin = receipt.migrationDatabaseUrl;
  const secret = receipt.secretKey;
  const publishable = receipt.publishableKey;

  const runtime = runtimeDatabaseUrl(
    Redacted.value(receipt.runtimeDatabaseUrl)
  );

  const { password } = new URL(Redacted.value(receipt.runtimeDatabaseUrl));

  if (!/^[a-f0-9]{64}$/u.test(password)) {
    return yield* Effect.die("Invalid preview runtime credential");
  }

  yield* Effect.gen(function* applyMigrations() {
    const db = yield* PgDrizzle.makeWithDefaults();
    yield* Effect.suspend(() => migrate(db, { migrationsFolder }));
  }).pipe(
    Effect.provide(
      PgClient.layer({ maxConnections: 1, prepare: false, url: admin })
    )
  );
  yield* seedLocal.pipe(
    Effect.provide(DatabaseLive({ maxConnections: 2, url: admin }))
  );
  yield* seedProvider(receipt.supabaseUrl, secret, publishable, admin);
  const exists = yield* runtimeRoleExists(admin);

  if (exists) {
    yield* probeRuntimeLogin(runtime);
  }

  yield* provisionRuntimeAccess(admin, password);

  return yield* probeRuntimeLogin(runtime);
});

NodeRuntime.runMain(
  program.pipe(
    Effect.provide([NodeServices.layer, FetchHttpClient.layer]),
    Effect.catchCause(() =>
      Effect.die(
        "Preview bootstrap failed; inspect the private configuration and provider state without exposing credentials."
      )
    ),
    Effect.orDie
  )
);
