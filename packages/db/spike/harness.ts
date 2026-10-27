/**
 * Spike harness: the repositories' `Drizzle` (no relations), a second Drizzle handle built with the relations
 * (`Rqb`), both on the one ambient `SqlClient`, and a recorder for every statement Drizzle sends.
 */
import { PgClient } from "@effect/sql-pg";
import { PgliteClient } from "@effect/sql-pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import * as PgliteDrizzle from "drizzle-orm/effect-pglite";
import { migrate as migratePglite } from "drizzle-orm/effect-pglite/migrator";
import { EffectLogger } from "drizzle-orm/effect-core";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { Context, Effect, Layer } from "effect";
import type { Redacted } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { RepositoriesLayer } from "../src/databaseLive.ts";
import { Drizzle } from "../src/internal/drizzle.ts";
import { relations } from "./relations.ts";

export interface Recorded {
  readonly sql: string;
  readonly params: unknown[];
}

export const captured: Recorded[] = [];

const recorder = {
  logQuery: (query: string, params: unknown[]) =>
    Effect.sync(() => {
      captured.push({ params, sql: query });
    }),
};

/** Runs `effect` and returns its result with every statement Drizzle sent meanwhile. */
export const capture = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.suspend(() => {
    captured.length = 0;

    return Effect.map(effect, (value) => ({
      statements: captured.splice(0, captured.length),
      value,
    }));
  });

export class Rqb extends Context.Service<
  Rqb,
  PgDrizzle.EffectPgDatabase<typeof relations>
>()("spike/Rqb") {}

const plainPg = Layer.effect(
  Drizzle,
  PgDrizzle.make().pipe(
    Effect.provideService(EffectLogger, recorder),
    Effect.provide(PgDrizzle.DefaultServices)
  )
);

const rqbPg = Layer.effect(
  Rqb,
  PgDrizzle.make({ relations }).pipe(
    Effect.provideService(EffectLogger, recorder),
    Effect.provide(PgDrizzle.DefaultServices)
  )
);

const migrationsFolder = new URL("../drizzle/", import.meta.url).pathname;

const plainPglite = Layer.effect(
  Drizzle,
  Effect.gen(function* plainPglite() {
    const db = yield* PgliteDrizzle.make().pipe(
      Effect.provideService(EffectLogger, recorder),
      Effect.provide(PgliteDrizzle.DefaultServices)
    );
    yield* Effect.orDie(
      Effect.suspend(() => migratePglite(db, { migrationsFolder }))
    );

    return db;
  })
);

const rqbPglite = Layer.effect(
  Rqb,
  PgliteDrizzle.make({ relations }).pipe(
    Effect.provideService(EffectLogger, recorder),
    Effect.provide(PgliteDrizzle.DefaultServices)
  )
);

/** Everything a scenario needs over a PostgreSQL URL: repositories, `Drizzle`, `Rqb`, `SqlClient`. */
export const postgresEnvironment = (
  url: Redacted.Redacted,
  options?: { readonly maxConnections?: number }
) =>
  RepositoriesLayer.pipe(
    Layer.provideMerge(Layer.mergeAll(plainPg, rqbPg)),
    Layer.provideMerge(
      PgClient.layer({
        maxConnections: options?.maxConnections ?? 4,
        multiplex: false,
        prepare: false,
        url,
      })
    )
  );

/** The same over a fresh in-memory PGlite with the migrations applied. */
export const pgliteEnvironment = RepositoriesLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(plainPglite, rqbPglite)),
  Layer.provideMerge(
    Layer.effect(SqlClient, Effect.service(SqlClient)).pipe(
      Layer.provideMerge(PgliteClient.layer({ extensions: { btree_gist } }))
    )
  )
);
