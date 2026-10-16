/**
 * Test databases.
 *
 * - `pgliteDatabase`: an in-memory PGlite with the generated migrations applied,
 *   behind the same `RepositoriesLayer` as production (fast repository tests).
 * - `postgresDatabase`: a uniquely named database on devenv's PostgreSQL
 *   (`TEST_DATABASE_ADMIN_URL`), created per Layer build and dropped on release,
 *   with the migrations applied, then `DatabaseLive` on top of it.
 *
 * A missing `TEST_DATABASE_ADMIN_URL` fails the suite; it never skips it.
 */
import { PgClient } from "@effect/sql-pg";
import { PgliteClient } from "@effect/sql-pglite";
import * as PgliteDrizzle from "drizzle-orm/effect-pglite";
import { migrate as migratePglite } from "drizzle-orm/effect-pglite/migrator";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { migrate as migratePg } from "drizzle-orm/effect-postgres/migrator";
import { Config, Context, Effect, Layer, Random, Redacted } from "effect";
import * as Reactivity from "effect/reactivity/Reactivity";
import { SqlClient } from "effect/sql/SqlClient";

import { DatabaseLive, RepositoriesLayer } from "../../src/databaseLive.ts";
import { Drizzle } from "../../src/internal/drizzle.ts";

export { Drizzle } from "../../src/internal/drizzle.ts";

const migrationsFolder = new URL("../../drizzle/", import.meta.url).pathname;

/** The URL of this suite's disposable database (for raw SQL and schema surgery in tests). */
export class TestDatabaseUrl extends Context.Service<
  TestDatabaseUrl,
  Redacted.Redacted
>()("test/TestDatabaseUrl") {}

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

const adminUrl = Config.Redacted("TEST_DATABASE_ADMIN_URL");

/** Creates `vp_db_test_<random>` through the admin URL; drops it (forcibly) on release. */
const disposableDatabase = Layer.effect(
  TestDatabaseUrl,
  Effect.gen(function* disposableDatabase() {
    const admin = yield* adminUrl;
    const adminClient = yield* PgClient.make({ maxConnections: 1, url: admin });
    const suffix = (yield* Random.nextIntBetween(0, 2 ** 31)).toString(36);
    const name = `vp_db_test_${suffix}`;
    yield* Effect.acquireRelease(
      adminClient.unsafe(`create database "${name}"`),
      () =>
        adminClient
          .unsafe(`drop database if exists "${name}" with (force)`)
          .pipe(Effect.orDie)
    );
    const url = new URL(Redacted.value(admin));
    url.pathname = `/${name}`;

    return Redacted.make(url.toString());
  }).pipe(Effect.orDie)
).pipe(Layer.provide(Reactivity.layer));

/** Applies `drizzle/` to the database through its own short-lived client. */
const migrated = Layer.effectDiscard(
  Effect.gen(function* migrated() {
    const url = yield* TestDatabaseUrl;
    yield* Effect.gen(function* applyMigrations() {
      const db = yield* PgDrizzle.makeWithDefaults();
      yield* Effect.suspend(() => migratePg(db, { migrationsFolder }));
    }).pipe(
      Effect.provide(PgClient.layer({ maxConnections: 1, prepare: false, url }))
    );
  }).pipe(Effect.orDie)
);

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
  ).pipe(
    Layer.provide(migrated),
    Layer.provideMerge(disposableDatabase),
    Layer.orDie
  );
