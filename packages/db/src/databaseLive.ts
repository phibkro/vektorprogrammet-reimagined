/**
 * The composition the apps select: every domain repository, `Outbox`,
 * `AuditLog`, `OutboxDelivery` and the `SqlClient` that `transactional` uses,
 * over `@effect/sql-pg` and Drizzle `effect-postgres`.
 *
 * Hyperdrive rules (architecture §3, §4): `prepare: false` (Hyperdrive pools
 * in transaction mode), `multiplex: false`, a small pool, and no advisory
 * locks, LISTEN/NOTIFY or session `SET` anywhere in this package.
 */
import { PgClient } from "@effect/sql-pg";
import { Effect, Layer } from "effect";
import type { Redacted } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { Drizzle } from "./internal/drizzle.ts";
import { PublicFileRepositoryLive } from "./repositories/files.ts";
import {
  AdmissionPeriodRepositoryLive,
  DepartmentRepositoryLive,
  FieldOfStudyRepositoryLive,
  SemesterRepositoryLive,
} from "./repositories/organisation.ts";
import {
  AuditLogLive,
  OutboxDeliveryLive,
  OutboxLive,
} from "./repositories/outbox.ts";
import { SocialEventRepositoryLive } from "./repositories/socialEvents.ts";

/**
 * Every repository Layer over an abstract `Drizzle` and `SqlClient`. Internal:
 * tests build it on PGlite; `DatabaseLive` builds it on `@effect/sql-pg`.
 */
export const RepositoriesLayer = Layer.mergeAll(
  DepartmentRepositoryLive,
  AdmissionPeriodRepositoryLive,
  SemesterRepositoryLive,
  FieldOfStudyRepositoryLive,
  SocialEventRepositoryLive,
  PublicFileRepositoryLive,
  OutboxLive,
  OutboxDeliveryLive,
  AuditLogLive
);

export interface DatabaseConfig {
  readonly url: Redacted.Redacted;
  /** Pool size; keep it small behind Hyperdrive. */
  readonly maxConnections?: number | undefined;
}

/**
 * Builds one pool per Layer build (a Worker builds it per request). Exposes
 * `SqlClient` for `transactional`, but not `PgClient`, whose LISTEN/NOTIFY
 * helpers Hyperdrive does not support.
 */
export const DatabaseLive = (config: DatabaseConfig) =>
  Layer.mergeAll(
    RepositoriesLayer.pipe(Layer.provide(Drizzle.layerPg)),
    Layer.effect(SqlClient, Effect.service(SqlClient))
  ).pipe(
    Layer.provide(
      PgClient.layer({
        maxConnections: config.maxConnections,
        multiplex: false,
        prepare: false,
        url: config.url,
      })
    )
  );
