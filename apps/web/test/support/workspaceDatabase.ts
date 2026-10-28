import { DatabaseLive } from "@vektorprogrammet/db";
import {
  TestDatabaseUrl,
  migratedTestDatabase,
} from "@vektorprogrammet/db/testing";
import { Effect, Layer } from "effect";

import { recordingPublisher } from "./publications";

/** The real PostgreSQL repositories and transactor for Workspace tests, with a publisher that records what a chunk published. */
export const workspaceDatabase = Layer.unwrap(
  Effect.map(Effect.service(TestDatabaseUrl), (url) =>
    DatabaseLive({ maxConnections: 10, url })
  )
).pipe(
  Layer.provideMerge(recordingPublisher),
  Layer.provideMerge(migratedTestDatabase),
  Layer.orDie
);
