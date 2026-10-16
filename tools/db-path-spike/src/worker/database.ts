import type { Hyperdrive } from "@cloudflare/workers-types";
/**
 * The per-request database stack, exactly as production builds it (architecture §3):
 * `@vektorprogrammet/db`'s real `DatabaseLive` over Hyperdrive, plus Drizzle
 * `effect-postgres` on the very client `DatabaseLive` built. One pool, one client:
 * a Drizzle statement inside `transactional` joins the transaction, as the repositories'
 * statements do. A Worker cannot reuse I/O objects across requests, so every request builds its own.
 */
import { PgClient } from "@effect/sql-pg";
import { DatabaseLive } from "@vektorprogrammet/db";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { Context, Effect, Layer, Predicate, Redacted } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/** The Worker's only database address is Hyperdrive. There is no direct URL binding to fall back on. */
export interface SpikeEnv {
  readonly HYPERDRIVE: Pick<Hyperdrive, "connectionString">;
}

/** Hyperdrive pools connections itself; one request needs very few (as `apps/web`). */
const MAX_CONNECTIONS_PER_REQUEST = 2;

/** `DatabaseLive` hands out its client typed as `SqlClient`; the Drizzle driver needs the `PgClient` it is. */
const isPgClient = (client: SqlClient): client is PgClient.PgClient =>
  Predicate.hasProperty(client, PgClient.TypeId);

export class SpikeDb extends Context.Service<
  SpikeDb,
  PgDrizzle.EffectPgDatabase
>()("@vektorprogrammet/db-path-spike/SpikeDb") {
  /** Drizzle over the client in context; a client that is not a `PgClient` is a broken composition (defect). */
  static readonly layer = Layer.effect(
    SpikeDb,
    Effect.gen(function* spikeDb() {
      const client = yield* SqlClient;

      if (!isPgClient(client)) {
        return yield* Effect.die(
          "DatabaseLive's SqlClient is not the PgClient the Drizzle driver needs"
        );
      }

      return yield* PgDrizzle.makeWithDefaults().pipe(
        Effect.provideService(PgClient.PgClient, client)
      );
    })
  );
}

/** `SqlClient` and `SpikeDb` over one Hyperdrive-backed pool; the pool closes when the request ends. */
export const requestDatabase = (env: SpikeEnv) =>
  SpikeDb.layer.pipe(
    Layer.provideMerge(
      DatabaseLive({
        maxConnections: MAX_CONNECTIONS_PER_REQUEST,
        url: Redacted.make(env.HYPERDRIVE.connectionString),
      })
    )
  );
