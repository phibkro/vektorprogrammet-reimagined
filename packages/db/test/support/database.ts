/**
 * Test databases.
 *
 * - `pgliteDatabase`: an in-memory PGlite with the generated migrations applied,
 *   behind the same `RepositoriesLayer` as production (fast repository tests).
 * - `postgresDatabase`: `DatabaseLive` on a migrated disposable database on devenv's PostgreSQL
 *   (`disposableDatabase.ts`: the one definition, shared with the importer's round trip and the
 *   browser tests).
 *
 * A missing `TEST_DATABASE_ADMIN_URL` fails the suite; it never skips it.
 */
import { PgClient } from "@effect/sql-pg";
import { PgliteClient } from "@effect/sql-pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import type { RetentionMode } from "@vektorprogrammet/domain";
import { WebCryptoTest } from "@vektorprogrammet/domain/testing/crypto";
import * as PgliteDrizzle from "drizzle-orm/effect-pglite";
import { migrate as migratePglite } from "drizzle-orm/effect-pglite/migrator";
import { Effect, Layer } from "effect";
import type { Redacted } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import {
  DatabaseLive,
  JobDatabaseLive,
  RepositoriesLayer,
} from "../../src/databaseLive.ts";
import { Drizzle } from "../../src/internal/drizzle.ts";
import { TestDatabaseUrl, migratedTestDatabase } from "./disposableDatabase.ts";

export { Drizzle } from "../../src/internal/drizzle.ts";

const migrationsFolder = new URL("../../drizzle/", import.meta.url).pathname;

const pgliteDrizzle = Layer.effect(
  Drizzle,
  Effect.gen(function* pgliteDrizzle() {
    const db = yield* PgliteDrizzle.makeWithDefaults();
    yield* Effect.orDie(
      Effect.suspend(() => migratePglite(db, { migrationsFolder }))
    );

    return db;
  })
);

/** Repositories + `SqlClient` + `Drizzle` on a fresh in-memory PGlite (with `btree_gist`, which a migration creates). */
export const pgliteDatabase = Layer.mergeAll(
  RepositoriesLayer,
  Layer.effect(SqlClient, Effect.service(SqlClient))
).pipe(
  Layer.provideMerge(pgliteDrizzle),
  Layer.provide(PgliteClient.layer({ extensions: { btree_gist } }))
);

/** `database` on a migrated disposable database, plus `TestDatabaseUrl`, `Crypto` and a separate `Drizzle` handle (its own small pool). */
const onDisposableDatabase = <ROut, E, RIn>(
  database: (url: Redacted.Redacted) => Layer.Layer<ROut, E, RIn>
) =>
  Layer.unwrap(
    Effect.map(Effect.service(TestDatabaseUrl), (url) =>
      Layer.mergeAll(
        database(url),
        WebCryptoTest,
        Drizzle.layerPg.pipe(
          Layer.provide(
            PgClient.layer({ maxConnections: 2, prepare: false, url })
          )
        )
      )
    )
  ).pipe(Layer.provideMerge(migratedTestDatabase), Layer.orDie);

/**
 * `DatabaseLive` on a migrated disposable database, plus `TestDatabaseUrl` and
 * a separate `Drizzle` handle (its own small pool) for assertions after commit.
 *
 * Use it with `layer(…, { excludeTestServices: true })`: the pool reads the
 * Clock it was built with for connection ages, so building it on a `TestClock`
 * that a test moves hangs the pool. Tests that need fixed time nest
 * `it.layer(TestClock.layer())`.
 */
export const postgresDatabase = (options?: {
  readonly maxConnections?: number;
}) =>
  onDisposableDatabase((url) =>
    DatabaseLive({ maxConnections: options?.maxConnections ?? 25, url })
  );

/**
 * The same, built as a cron job builds it (`JobDatabaseLive`): it also provides `RetentionRun`, with the nightly retention
 * in `retention` (spec 0007b R4).
 */
export const postgresJobDatabase = (
  retention: RetentionMode,
  options?: { readonly maxConnections?: number }
) =>
  onDisposableDatabase((url) =>
    JobDatabaseLive({
      maxConnections: options?.maxConnections ?? 25,
      retention,
      url,
    })
  );
