/**
 * Where each capability of the domain is shown on the platforms of this adapter, and where it is not (spec 0025).
 *
 * The domain says what a platform must show and, for a capability that a deployed probe cannot show, why
 * (`PlatformRequirements`). What was measured, where and on which platform names the engine and its tests, so it is the
 * adapter's to say: one sentence for every capability, and a sentence that is not "measured" says so. `Hyperdrive` is the
 * deployed platform; "on PostgreSQL" is the contract tests on the test server.
 */
import type { Capability } from "@vektorprogrammet/domain";

export const evidence: Readonly<Record<Capability, string>> = {
  AggregateLocks:
    "Through Hyperdrive: `GET /api/platform` on every Preview (two transactions on two pooled connections). On PostgreSQL: `aggregates.postgres.test.ts`, 300 rounds, with its controls.",
  AnalyticsReads: "No adapter yet (ADR 0014, stage 6).",
  Claims:
    "Through Hyperdrive: spec 0000 results, checks 5 and 8 (2026-10-16): an `ON CONFLICT … RETURNING` statement, and 20 concurrent upserts of one key that all returned the same row. A concurrent claim with exactly one winner (`DO NOTHING`) was **not** run through Hyperdrive. On PostgreSQL: `concurrency.postgres.test.ts` and the claim tests of each repository.",
  ConditionalWrites:
    "On PostgreSQL: `aggregates.postgres.test.ts` (300 rounds) and `teams.postgres.test.ts`. Through Hyperdrive: not measured.",
  Leases:
    "As `Claims` and `ConditionalWrites` (neither is measured through Hyperdrive for one winner or for a conditional write); on PostgreSQL also `jobRuns.postgres.test.ts`.",
  NonOverlap:
    "On PostgreSQL: `teams.postgres.test.ts`, falsifier 4, with its control. Through Hyperdrive: not measured (the SQLSTATE of the exclusion constraint reaching the client is not in spec 0000's results).",
  ObjectStore: "`FileStore` is the R2 binding, not a database.",
  ReadOnlyReads:
    "On PostgreSQL: `readOnlyRole.postgres.test.ts` and `readsNeverWrite.postgres.test.ts`. Through Hyperdrive: not measured. Query caching is off (`alchemy.run.ts`), so a read reaches the database.",
  Snapshots:
    "On PostgreSQL: `personalDataExport.postgres.test.ts`. Through Hyperdrive: not measured.",
  Transactions:
    "Through Hyperdrive: spec 0000 results (commit, rollback on a typed failure, rollback on interruption, a nested savepoint, 2026-10-16), `GET /api/isolation` (TX3) and `GET /api/platform` (TX1, TX2) on every Preview. On PostgreSQL: `transactions.postgres.test.ts`.",
  UniqueKeys:
    "Through Hyperdrive: spec 0000 results (a unique violation classified, PASS, 2026-10-16). On PostgreSQL: the unique-key tests of each repository.",
  WorkQueue:
    "Through Hyperdrive: `GET /api/platform` on every Preview (a held record is skipped). On PostgreSQL: `outbox.postgres.test.ts`, with its controls.",
};
