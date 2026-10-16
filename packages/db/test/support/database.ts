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
import * as PgliteDrizzle from "drizzle-orm/effect-pglite";
import { migrate as migratePglite } from "drizzle-orm/effect-pglite/migrator";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { DatabaseLive, RepositoriesLayer } from "../../src/databaseLive.ts";
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

/** Repositories + `SqlClient` + `Drizzle` on a fresh in-memory PGlite. */
export const pgliteDatabase = Layer.mergeAll(
  RepositoriesLayer,
  Layer.effect(SqlClient, Effect.service(SqlClient))
).pipe(Layer.provideMerge(pgliteDrizzle), Layer.provide(PgliteClient.layer()));

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
  Layer.unwrap(
    Effect.map(Effect.service(TestDatabaseUrl), (url) =>
      Layer.merge(
        DatabaseLive({ maxConnections: options?.maxConnections ?? 25, url }),
        Drizzle.layerPg.pipe(
          Layer.provide(
            PgClient.layer({ maxConnections: 2, prepare: false, url })
          )
        )
      )
    )
  ).pipe(Layer.provideMerge(migratedTestDatabase), Layer.orDie);
