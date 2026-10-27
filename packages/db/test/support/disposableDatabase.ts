/**
 * The one definition of "a migrated disposable PostgreSQL database", shared by `packages/db`'s tests,
 * `tools/import`'s round trip and the `apps/web` browser tests (through the `@vektorprogrammet/db/testing`
 * export).
 *
 * `migratedTestDatabase` creates a uniquely named `vp_db_test_<random>` database on devenv's PostgreSQL
 * (`TEST_DATABASE_ADMIN_URL`) per Layer build, applies the generated `drizzle/` migrations to it, provides
 * its URL as `TestDatabaseUrl`, and drops it (forcibly) when the Layer's scope closes. A missing
 * `TEST_DATABASE_ADMIN_URL` fails; it never skips. `readOnlyRole.ts` adds a SELECT-only login role on it.
 */
import { PgClient } from "@effect/sql-pg";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { migrate } from "drizzle-orm/effect-postgres/migrator";
import { Config, Context, Effect, Layer, Random, Redacted } from "effect";
import * as Reactivity from "effect/reactivity/Reactivity";

const migrationsFolder = new URL("../../drizzle/", import.meta.url).pathname;

/** The URL of the disposable database (for raw SQL, schema surgery and the code under test). */
export class TestDatabaseUrl extends Context.Service<
  TestDatabaseUrl,
  Redacted.Redacted
>()("test/TestDatabaseUrl") {}

const adminUrl = Config.Redacted("TEST_DATABASE_ADMIN_URL");

/**
 * Runs `use` on a client (a pool of one connection) that lives only that long: built for the statements,
 * closed after them. A release must never wait on a client built earlier in its own scope. A pool retires a
 * connection it finds idle for 60 to 120 seconds and replaces it from a fibre forked into the scope the pool
 * was built in; that scope is already closed while its finalizers run, so the fibre is interrupted at once and
 * the release waits for ever (Effect 4.0.5 and 4.0.6, `Pool.get`). The browser tests hit it as a CI step that never
 * ended, on the first run longer than two minutes. Here the pool's scope is open for as long as `use` runs.
 */
export const withClient = <A, E, R>(
  url: Redacted.Redacted,
  use: (client: PgClient.PgClient) => Effect.Effect<A, E, R>
) =>
  PgClient.make({ maxConnections: 1, url }).pipe(
    Effect.flatMap(use),
    Effect.scoped,
    Effect.provide(Reactivity.layer)
  );

/** Creates `vp_db_test_<random>` through the admin URL; drops it (forcibly) on release. */
const disposableDatabase = Layer.effect(
  TestDatabaseUrl,
  Effect.gen(function* disposableDatabase() {
    const admin = yield* adminUrl;
    const suffix = (yield* Random.nextIntBetween(0, 2 ** 31)).toString(36);
    const name = `vp_db_test_${suffix}`;
    yield* Effect.acquireRelease(
      withClient(admin, (client) => client.unsafe(`create database "${name}"`)),
      () =>
        withClient(admin, (client) =>
          client.unsafe(`drop database if exists "${name}" with (force)`)
        ).pipe(Effect.orDie)
    );
    const url = new URL(Redacted.value(admin));
    url.pathname = `/${name}`;

    return Redacted.make(url.toString());
  }).pipe(Effect.orDie)
);

/** Applies `drizzle/` to the database through its own short-lived client. */
const migrated = Layer.effectDiscard(
  Effect.gen(function* migrated() {
    const url = yield* TestDatabaseUrl;
    yield* Effect.gen(function* applyMigrations() {
      const db = yield* PgDrizzle.makeWithDefaults();
      yield* Effect.suspend(() => migrate(db, { migrationsFolder }));
    }).pipe(
      Effect.provide(PgClient.layer({ maxConnections: 1, prepare: false, url }))
    );
  }).pipe(Effect.orDie)
);

/** A migrated disposable database; `TestDatabaseUrl` is its URL. */
export const migratedTestDatabase = migrated.pipe(
  Layer.provideMerge(disposableDatabase)
);
