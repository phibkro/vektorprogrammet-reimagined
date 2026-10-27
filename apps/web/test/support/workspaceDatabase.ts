import { DatabaseLive } from "@vektorprogrammet/db";
import {
  TestDatabaseUrl,
  migratedTestDatabase,
} from "@vektorprogrammet/db/testing";
import { Effect, Layer } from "effect";

import { transactorLayer } from "../../src/server/transactor";

/** The real PostgreSQL repositories and transactor for Workspace tests. */
export const workspaceDatabase = Layer.unwrap(
  Effect.map(Effect.service(TestDatabaseUrl), (url) =>
    transactorLayer.pipe(
      Layer.provideMerge(DatabaseLive({ maxConnections: 10, url }))
    )
  )
).pipe(Layer.provideMerge(migratedTestDatabase), Layer.orDie);
