/**
 * The layers the spike's tests share: a migrated disposable PostgreSQL (the repository's own helper), a `SqlClient`
 * over it with the Hyperdrive settings (`prepare: false`, `multiplex: false`), and the PostgreSQL platform on top.
 */
import { PgClient } from "@effect/sql-pg";
import {
  TestDatabaseUrl,
  migratedTestDatabase,
} from "@vektorprogrammet/db/testing";
import { Effect, Layer } from "effect";

import * as PostgresPlatform from "../../src/postgresPlatform.ts";

/** A pool over the disposable database, with the settings that Hyperdrive needs (packages/db `DatabaseLive`). */
export const sqlOverTestDatabase = (maxConnections = 30) =>
  Layer.unwrap(
    Effect.map(Effect.service(TestDatabaseUrl), (url) =>
      PgClient.layer({ maxConnections, multiplex: false, prepare: false, url })
    )
  );

/** The migrated database and a `SqlClient` over it. `TestDatabaseUrl` stays available for a second, read-only pool. */
export const database = (maxConnections = 30) =>
  sqlOverTestDatabase(maxConnections).pipe(
    Layer.provideMerge(migratedTestDatabase),
    Layer.orDie
  );

/** The platform over `database`, exposing the client too. */
export const postgresPlatform = (
  options?: PostgresPlatform.PostgresPlatformOptions
) => PostgresPlatform.layer(options).pipe(Layer.provideMerge(database()));
