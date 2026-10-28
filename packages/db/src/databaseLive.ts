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
import type { RetentionMode } from "@vektorprogrammet/domain";
import { Effect, Layer } from "effect";
import type { Redacted } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { Aggregates } from "./aggregate/aggregates.ts";
import { roots } from "./aggregate/declaration.ts";
import { aggregateLocksLayer } from "./aggregate/locks.ts";
import { Drizzle } from "./internal/drizzle.ts";
import { AccountRepositoryLive } from "./repositories/accounts.ts";
import { CapturedMessageStoreLive } from "./repositories/capturedMessages.ts";
import { CodeRepositoryLive } from "./repositories/codes.ts";
import { PublicFileRepositoryLive } from "./repositories/files.ts";
import { JobRunsLive } from "./repositories/jobRuns.ts";
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
  OutboxReportsLive,
} from "./repositories/outbox.ts";
import {
  AlumniRequestsLive,
  ConsentRepositoryLive,
  LegalHoldsLive,
  PersonalDataStoreLive,
  RetentionRunReportLive,
  retentionRunLayer,
} from "./repositories/personalData.ts";
import { SessionDirectoryLive } from "./repositories/sessions.ts";
import { SignInDirectoryLive } from "./repositories/signIn.ts";
import { SocialEventRepositoryLive } from "./repositories/socialEvents.ts";
import {
  AdminGrantRepositoryLive,
  DigestLedgerLive,
  MembershipRepositoryLive,
  PersonRepositoryLive,
  PositionRepositoryLive,
  PrincipalDirectoryLive,
  TeamRepositoryLive,
  WelcomeLedgerLive,
} from "./repositories/teams.ts";
import {
  WorkspaceAssignmentsLive,
  WorkspaceFactsLive,
  WorkspaceReportsLive,
} from "./repositories/workspace.ts";
import { TransactorLive } from "./transactional.ts";

/**
 * The aggregate construct (spec 0006b) that the repositories write through: the domain's `AggregateLocks` over the
 * roots of the schema, and the writer of the tables that they own.
 */
const AggregatesLayer = Layer.mergeAll(
  aggregateLocksLayer(roots),
  Aggregates.layer
);

/**
 * Every repository Layer over an abstract `Drizzle` and `SqlClient`, the domain's `Transactor` over that `SqlClient`,
 * and the aggregate locks that commands take (`AggregateLocks`) and the writer that the repositories use
 * (`Aggregates`). It has no nightly retention run: each layer below adds one.
 */
const Repositories = Layer.mergeAll(
  DepartmentRepositoryLive,
  AdmissionPeriodRepositoryLive,
  SemesterRepositoryLive,
  FieldOfStudyRepositoryLive,
  SocialEventRepositoryLive,
  PublicFileRepositoryLive,
  AccountRepositoryLive,
  CodeRepositoryLive,
  CapturedMessageStoreLive,
  SessionDirectoryLive,
  SignInDirectoryLive,
  PersonRepositoryLive,
  TeamRepositoryLive,
  PositionRepositoryLive,
  MembershipRepositoryLive,
  AdminGrantRepositoryLive,
  DigestLedgerLive,
  WelcomeLedgerLive,
  PrincipalDirectoryLive,
  OutboxLive,
  OutboxReportsLive,
  OutboxDeliveryLive,
  AuditLogLive,
  ConsentRepositoryLive,
  AlumniRequestsLive,
  LegalHoldsLive,
  PersonalDataStoreLive,
  JobRunsLive,
  WorkspaceAssignmentsLive,
  WorkspaceFactsLive,
  WorkspaceReportsLive,
  TransactorLive
).pipe(Layer.provideMerge(AggregatesLayer));

/**
 * The repositories and a nightly retention run that only counts (spec 0007b R4): what a request, and a test on PGlite,
 * gets. A run that changes rows is asked for explicitly, with `JobDatabaseLive`. Internal: tests build it on PGlite;
 * `DatabaseLive` builds it on `@effect/sql-pg`.
 */
export const RepositoriesLayer = Layer.mergeAll(
  Repositories,
  RetentionRunReportLive
);

export interface DatabaseConfig {
  readonly url: Redacted.Redacted;
  /** Pool size; keep it small behind Hyperdrive. */
  readonly maxConnections?: number | undefined;
}

/**
 * One pool per Layer build, under the Hyperdrive rules above, with `services` over it. Exposes `SqlClient` for
 * `transactional`, but not `PgClient`, whose LISTEN/NOTIFY helpers Hyperdrive does not support.
 */
const databaseOver = <ROut, E, RIn>(
  config: DatabaseConfig,
  services: Layer.Layer<ROut, E, RIn>
) =>
  Layer.mergeAll(
    services.pipe(Layer.provide(Drizzle.layerPg)),
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

/** Builds one pool per Layer build (a Worker builds it per request). */
export const DatabaseLive = (config: DatabaseConfig) =>
  databaseOver(config, RepositoriesLayer);

/**
 * `DatabaseLive` for the cron job that runs the nightly retention, in the mode that the composition root decided (spec
 * 0007b R4). It is the only constructor that can provide a `RetentionRun` that changes rows: every other layer counts. The
 * mode is fixed here, so a program that runs the retention cannot change it.
 */
export const JobDatabaseLive = (
  config: DatabaseConfig & { readonly retention: RetentionMode }
) =>
  databaseOver(
    config,
    Layer.mergeAll(
      Repositories,
      retentionRunLayer(config.retention).pipe(Layer.provide(AggregatesLayer))
    )
  );
