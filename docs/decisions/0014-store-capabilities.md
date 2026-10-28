---
status: accepted
---

# Store capabilities are Effect services with named guarantees

Accepted by the operator on 2026-10-28, with the answers below. Evidence: repository at main `f4bfe78`; Alchemy Domain spike at branch `spike/alchemy-domain-postgres` (`eea61b3`; paths starting with `spikes/` are on that branch). This ADR amends the AGENTS.md rule "Database rules for every phase" and spec 0006b R1 item 1: engine features (constraints, `ON CONFLICT`, row locks) implement capabilities inside an adapter; they are no longer the stated guarantee.

## Decision drivers (operator, 2026-10-28)

- **D1.** Modularity, extensibility and free choice of store come before raw performance.
- **D2.** The system is not a high-throughput system. A request is critical in milliseconds. A crucial activity is critical in hours or days.
- **D3.** A latency cost like the Alchemy Domain spike's (about 28% at p50) is acceptable if the guarantees hold.
- **D4.** Correctness is not negotiable. Races are avoided by construction, and invariants hold. Performance is negotiable.

Two earlier operator decisions also apply:

- "Avoid races by construction."
- "Alchemy Domain may be used as a foundation layer, but must not replace the existing kernel or its runtime."

## Context

Today the domain declares services, and `packages/db` implements all of them on PostgreSQL. The domain imports nothing from `db` (`AGENTS.md:42`). But the guarantees are not stated as properties. They are stated as SQL, or they exist only inside the PostgreSQL adapter. A second store cannot be added safely, because nobody can test what it must do.

### 1. Code outside `packages/db` that depends on PostgreSQL or Drizzle

| Location | What it does | Kind |
| --- | --- | --- |
| `apps/web/src/server/auth.ts:15, 444-446` | Better Auth gets its own `pg` Pool on the Hyperdrive connection string. | PostgreSQL |
| `auth.ts:260-262, 319-321, 482, 527, 549-552` | Five hand-written SQL reads of `account`, `person` and `auth_user`. They go around `AccountRepository` and `PersonRepository`. | PostgreSQL, a domain leak |
| `apps/web/src/server/runtime.ts:19-24, 79, 159, 180, 455`; `env.ts:22-23` | The composition root builds `DatabaseLive` from `HYPERDRIVE.connectionString`. `SqlClient` is part of the request services. | Composition (expected), plus generic SQL |
| `apps/web/src/server/transactor.ts:7-35` | `Transactor` is a port declared in the web app. It needs `SqlClient` and calls `db`'s `transactional`. | Generic SQL; a port in the wrong place |
| `apps/web/src/server/accountDelivery.ts:2-3, 18, 77, 90, 160` | Code delivery opens its own `transactional` with a captured `SqlClient`. It imports `OutboxDelivery` from `db`. | Generic SQL; a port imported from the adapter |
| `outboxDelivery.ts:2-3`, `accounts.ts:2`, `senders.ts:17` | Import `OutboxDelivery`, `SessionDirectory` and `CapturedMessageStore` from `@vektorprogrammet/db`. | Ports declared in the adapter |
| `apps/web/alchemy.run.ts:142-147` | A Hyperdrive connection with caching off. | Infrastructure (expected) |
| `tools/import/src/target.ts:15-19, 57-99, 156, 186, 222` | `PgClient` + Drizzle on the exported `schema`, `LOCK TABLE … ACCESS EXCLUSIVE`, `TRUNCATE … RESTART IDENTITY`, `setval(pg_get_serial_sequence…)`. | PostgreSQL; writes around every port |
| `packages/db/src/index.ts:6` | Exports the Drizzle `schema` publicly. | Adapter internals made public |
| `apps/cms/astro.config.ts:21-22`, `apps/cms/db/emdash-role.sql` | EmDash runs on PostgreSQL through Hyperdrive. | Third-party product; out of scope |
| `tools/oxlint/anti-slop/rules/no-owned-table-write.ts:4, 14-15` | The lint rule reads Drizzle calls and imports `packages/db/.../ownership.ts`. | Tooling tied to the adapter |
| `.agents/skills/verify-membership-writes/SKILL.md:51, 159` | The TLA+ model pins PostgreSQL rules: READ COMMITTED, and the exclusion constraint writes its index entry before it checks. | Verification tied to the engine |
| Domain contract text: `shared/aggregate.ts:18, 67`; `organisation/services.ts:43-45`; `files/services.ts:1, 19`; `jobs/runs.ts:6`; `teams/services.ts:142-143`; `personalData/catalog.ts:20`; `personalData/declaration.ts:93, 174`; `shared/ids.ts:4`; `shared/outbox.ts:45`; `domain/src/README.md:7-17, 63-68` | Guarantees are written as SQL, by SQL table name, or as `jsonb` paths. | The domain states mechanisms, not properties |
| Tests: 9 `apps/web/test/*.postgres.test.ts`; `apps/web/e2e/support/probes.ts`, `publicFile.ts` | Seed data and check results with raw SQL on domain tables. | Test leak; acceptable only at adapter level |

### 2. Guarantees that rest on PostgreSQL features

| # | Guarantee the domain relies on | PostgreSQL feature | Evidence |
| --- | --- | --- | --- |
| 1 | Domain, audit and outbox rows commit together or not at all. | `SqlClient.withTransaction` | `packages/db/src/transactional.ts:1-15, 43-58`; `AGENTS.md:41` |
| 2 | A nested transaction is a savepoint. A failed savepoint releases its locks. | `SAVEPOINT`; row locks released on rollback | `transactional.ts:5-6`; `aggregate/lockScope.ts:6-7` |
| 3 | One writer per aggregate root until commit. | `SELECT … FOR NO KEY UPDATE` | `aggregate/locks.ts:105-117` |
| 4 | Many roots lock in one global order, with no deadlock. | One ordered `SELECT … ORDER BY id FOR NO KEY UPDATE` | `locks.ts:105-117`; `lockScope.ts:36-50` |
| 5 | A merged person (tombstone) cannot be locked. A waiting lock sees the merge. | `merged_into IS NULL` in the lock; READ COMMITTED re-check on commit | `locks.ts:107-112`; `SKILL.md:68` |
| 6 | One person's memberships in one team never overlap. | `EXCLUDE USING gist` + `btree_gist`; SQLSTATE `23P01` | `drizzle/20261026221817_membership_no_overlap/migration.sql:5-10`; `classifySqlFailure.ts:98-110` |
| 7 | Overlapping writes fail as `AlreadyExists`, never as a deadlock. | Exclusion index written before the check, plus the person lock | `packages/db/README.md:38`; `SKILL.md:159` |
| 8 | Term order and ordinals. | Generated columns, `CHECK membership_term_order` | `schema.ts:529-554`; `drizzle/20261026221802_people_and_teams/migration.sql:19, 26` |
| 9 | Unique natural keys map to `AlreadyExists`. | Unique constraints and partial unique indexes | `schema.ts:208-213, 274, 467-470`; `classifySqlFailure.ts:39-69`; `drizzle/20261027005012_accounts_and_sessions/migration.sql:86-87` |
| 10 | A state transition never loses an update. | `UPDATE … WHERE state = ANY(from) RETURNING`; zero rows is `Conflict` | `aggregate/aggregates.ts:230-300` |
| 11 | A membership end moves only from the value that was read. | Conditional `UPDATE` / `DELETE … RETURNING` | `repositories/teams.ts:591-655` |
| 12 | Find-or-create returns the one row. | `INSERT … ON CONFLICT DO UPDATE … RETURNING` | `repositories/organisation.ts:138-152`; `files.ts:83-86` |
| 13 | A claim has exactly one winner. | `INSERT … ON CONFLICT DO NOTHING RETURNING` | `teams.ts:785-802`; `jobRuns.ts:72-73, 166-167`; `companyAddresses.ts:86-87`; `capturedMessages.ts:51, 65` |
| 14 | An upsert never rewrites another owner's row. | `ON CONFLICT DO UPDATE … WHERE owner = $token` | `aggregates.ts:320-337` |
| 15 | Outbox: two claimers never get the same row, and acks are fenced. | `FOR UPDATE SKIP LOCKED` in `UPDATE … RETURNING`; `gen_random_uuid()` | `repositories/outbox.ts:8-18, 179-192` |
| 16 | A job period has one runner, and a stale runner writes nothing. | PK claim plus `WHERE attempt = $held` | `jobRuns.ts:1-12, 72-101` |
| 17 | Admin list: one lockable row. | Singleton row with `CHECK id = 1`, seeded by migration | `drizzle/20261027051931_admin_list/migration.sql:1-4`; `drizzle/20261027051936_admin_list_seeded/migration.sql` |
| 18 | The export is one consistent snapshot. The principal is one read. | One statement with `jsonb_build_object` / `json_agg` | `personalData/export.ts:33-42`; `teams.ts:857-874` |
| 19 | Retention periods use Oslo calendar time, and a second run changes nothing. | `make_interval`, `AT TIME ZONE`, `make_timestamptz`, function `semester_end`, view `person_last_activity_end`, chunks of 1000 by `ctid` | `personalData/sql.ts:47-53, 109`; `drizzle/20261027111351_person_last_activity_end/migration.sql:7-33`; `personalData/retention.ts:433` |
| 20 | Reads never write. | A role that holds only `SELECT` | `packages/db/README.md` § Tests; `apps/web/test/readsNeverWrite.postgres.test.ts` |

The system also assumes the isolation level READ COMMITTED (`SKILL.md:51, 159`), but `InTransaction` does not state it. The Hyperdrive rules (`databaseLive.ts:3-8`; `AGENTS.md:52`) belong to the PostgreSQL adapter, not to the domain.

### 3. Ports, and whether each states its guarantee

| Port | Declared in | Guarantee stated as a property? | What it silently assumes |
| --- | --- | --- | --- |
| `InTransaction` | `domain/shared/transaction.ts:19-22` | Partly. It is a proof value, `kind: "database-transaction"`. | Atomicity, savepoints and READ COMMITTED are not stated. Only the SQL `transactional` provides it. |
| `AggregateLocks`, `Locked` | `domain/shared/aggregate.ts:57-87` | Yes: exclusion, order, `NotFound`, held-check. | Stated through `FOR NO KEY UPDATE`. The held-check and the order check are in the adapter (`lockScope.ts`), so the fakes skip them. |
| `Aggregates` (the writer) | `packages/db/src/aggregate/aggregates.ts:164` | Yes, inside the adapter. | Drizzle `PgTable` types. Not a domain port. |
| `Outbox.enqueue` | `domain/shared/outbox.ts:80-87` | "In the current transaction". | The type does not require `InTransaction`. |
| `AuditLog.record` | `domain/audit/auditLog.ts:75-83` | "In the current transaction". | The type does not require `InTransaction`. |
| `OutboxDelivery` | `packages/db/src/repositories/outbox.ts:73` | Yes: at least once, fencing, no ordering. | Declared in the adapter, and phrased as `SKIP LOCKED`. |
| `JobRuns` | `domain/jobs/runs.ts:5-14, 71-128` | Yes: claim never waits, one winner, fencing. | Phrased as `ON CONFLICT`. |
| `MembershipRepository` | `domain/teams/services.ts:114-178` | Yes: `Conflict` on a lost race, `AlreadyExists` on overlap. | "The database's exclusion constraint" (`:142-143`). |
| `AdminGrantRepository`, `AccountRepository` | `teams/services.ts:180-211`; `accounts/services.ts:20-74` | Yes: decisions read through tokens. | `transition` is described as SQL. |
| `CodeRepository` | `accounts/codeRepository.ts:11-35` | Yes: a conditional consume. | — |
| `DigestLedger.claim` | `teams/services.ts:214-223` | One winner. | Commits with the outbox (`domain/src/README.md:68`), but the type has no `InTransaction`. |
| `WelcomeLedger.claim` | `teams/services.ts:226-233` | One winner, `InTransaction`. | — |
| `AlumniRequests.claim` | `personalData/services.ts:69-87` | One winner. | No `InTransaction`. |
| `SemesterRepository.ensure` | `organisation/services.ts:34-50` | Yes. | Phrased as SQL. |
| `PublicFileRepository.register` | `files/services.ts:9-24` | Idempotent. | "(Postgres)", `ON CONFLICT`. |
| `PersonalDataStore.exportOf` | `personalData/services.ts:115-150` | "One snapshot". | That one statement is a snapshot. |
| `PrincipalDirectory` | `teams/services.ts:236-250` | "One read". | Snapshot consistency. |
| `RetentionRun` | `personalData/services.ts:152-175` | Yes: the layer fixes the mode. | The catalog is compiled to PostgreSQL SQL. |
| Catalog declarations | `personalData/catalog.ts:20`; `declaration.ts:93, 174` | Yes, as data. | Keys are SQL table names; addresses are `jsonb` paths. |
| `SessionDirectory`, `CapturedMessageStore` | `packages/db/src/repositories/sessions.ts:18`; `capturedMessages.ts:15` | Partly. | Declared in the adapter. |
| `Transactor` | `apps/web/src/server/transactor.ts:12-19` | No. | Declared in the web app, and needs `SqlClient`. |
| `FileStore` (R2) | `domain/files/services.ts:36-49` | Yes: idempotent `put`; never inside a transaction. | — This port already follows the decision below. |

### 4. Tests that become contract suites

| Capability | Existing tests (PostgreSQL unless marked) | Negative control |
| --- | --- | --- |
| Transactions | `packages/db/test/transactions.postgres.test.ts:93-160` (commit, typed failure, defect, interruption, savepoint) | `jobRuns.postgres.test.ts:252` (cursor committed apart from its chunk) |
| Aggregate locks | `aggregates.postgres.test.ts:111-140` (300 rounds of opposite-order `lockAll`), `:302-570` (order, roots, `NotFound`, outside a transaction, token registry, savepoints); `accounts.postgres.test.ts:100`; `adminList.postgres.test.ts:374` (300 rounds) | `aggregates.postgres.test.ts:142-180` (hand-written lock order deadlocks); `adminList` control (30 forced rounds) |
| Conditional writes | `aggregates.postgres.test.ts:182-253` (300 rounds); `teams.postgres.test.ts:380-415` | `aggregates.postgres.test.ts:255-300`; `teams.postgres.test.ts:416-450` |
| Non-overlap | `teams.postgres.test.ts:453-487` (300-round guards) | `teams.postgres.test.ts:625-667` (constraint dropped) |
| Unique claims | `concurrency.postgres.test.ts:60`; `commands.postgres.test.ts:138`; `teams.postgres.test.ts:578`; `accounts.postgres.test.ts:169` (300 × 20); `jobRuns.postgres.test.ts:59, 106` | `concurrency.postgres.test.ts:87`; `jobRuns.postgres.test.ts:365`; `welcome.postgres.test.ts:235`; `apps/web/test/workspaceNamespace.postgres.test.ts:218-226` |
| Leases and queue | `outbox.postgres.test.ts:32` and later tests; `jobRuns.postgres.test.ts` | the fencing cases in the same files |
| Locked merges and writes | `personalDataMerge.postgres.test.ts:381` (20 × 300); `personalDataMergeRace.postgres.test.ts:203` (300 rounds); `retentionPeople.postgres.test.ts` (20 × 50) | `personalDataMerge.postgres.test.ts:418`; `personalDataMergeRace.postgres.test.ts:333`; `retentionPeople.postgres.test.ts:290, 374` |
| Snapshot export | `personalDataExport.postgres.test.ts` | `:193` |
| Read-only reads | `readOnlyRole.postgres.test.ts`; `apps/web/test/readsNeverWrite.postgres.test.ts` | `readOnlyRole.postgres.test.ts:71` |
| Retention | `retention.postgres.test.ts`, `retentionGate.postgres.test.ts` | one control per rule: `retention.postgres.test.ts:263, 302`; `retentionGate.postgres.test.ts:177, 236, 319` |

These stay PostgreSQL-only, as tests of the adapter:

- `membershipWriteModel.postgres.test.ts`
- the `pg_stat_activity` / `pg_locks` probe `meetsHeldLock` (`test/support/race.ts:109-115`)
- the schema closure tests (`personalDataClosure.postgres.test.ts`, `ownership.test.ts`)

Two facts favour the decision:

- Three PGlite tests (`repositories.pglite.test.ts`, `teams.pglite.test.ts`, `localSeed.pglite.test.ts`) already run the production Layer on a second engine.
- 2,023 lines of in-memory fakes (`packages/domain/test/support/inMemory.ts`, `teamsInMemory.ts`; `apps/web/test/support/memory.ts`) have no contract. The fake lock checks neither the order nor the held lock, and it does not exclude a second writer (`teamsInMemory.ts:658-713`).

### 5. Prior evidence: the Alchemy Domain spike

Source: `spikes/alchemy-domain/REPORT.md`.

- **Size:** a 930-line PostgreSQL platform, 1,155 lines with its support files (line 15). The platform contract suite passed 24/24, twice (line 7).
- **The #17 race passed:** 300 rounds of the deactivate-against-revoke race (line 9).
- **Its control proved less than it should.** With the platform lock and the version guard removed, the event primary key kept the invariant, but the loser got a PostgreSQL `UniqueViolation` instead of a typed rejection (line 70).
- **The overlap guarantee came from the repository's `membership_no_overlap`, not from the platform** (falsifier ledger, lines 37-50).
- **Latency, local only:** repository path p50 3.319 ms, p95 3.941 ms. Spike path p50 4.253 ms, p95 5.001 ms. p50 was 28.1% slower (line 68).
- **Blockers:** event-sourced aggregates start empty and have no bootstrap from existing rows (line 35); re-identification risk remains after erasure (line 3); a projection defect blocks the command.
- **Verdict:** "partly; do not adopt as the production runtime" (line 3).

## Decision

1. **A store guarantee is an Effect service that the domain declares, with a named guarantee.**
   - The capabilities are:
     - `Transactions` (replaces `transactional`, `Transactor` and `SqlClient` in the apps)
     - `AggregateLocks` (kept)
     - `UniqueKeys`
     - `NonOverlap`
     - `ConditionalWrites`
     - `Claims`
     - `Leases` and `WorkQueue` (the outbox and job runs)
     - `Snapshots`
     - `ReadOnlyReads`
     - `ObjectStore` (today's `FileStore`)
     - `AnalyticsReads` (read-only projections)
   - Each guarantee is written as a property, not as SQL.
   - Each guarantee names its strength:
     - **store-enforced:** it holds against every writer, including the importer and migrations;
     - **port-enforced:** it holds only against writers that use the port.
   - `InTransaction` states its isolation. The minimum is: a read under a lock sees the latest committed state.
2. **One contract suite per capability. Every adapter passes it.**
   - The suites come from the tests in Context section 4.
   - Each race keeps its round count and fresh state, and prints each loser's Cause.
   - Every adapter supplies a broken variant for each negative control. For example: the same adapter with the lock taken out, or with the constraint dropped.
   - A control must fail every time, as `AGENTS.md:128` already requires. An adapter whose control cannot fail does not pass.
3. **An adapter may use engine features to implement a capability.** Examples: `EXCLUDE`, `FOR NO KEY UPDATE`, `SKIP LOCKED`, a SQLite write lock. Tests of those engine features stay with the adapter. No adapter implements a capability with a retry loop, because spec 0006b rejected retries (`docs/specs/0006b-races-by-construction.md:48`).
4. **Data ownership is declared once per domain, in the domain.**
   - The per-domain `personalData.ts` declarations (`personalData/catalog.ts`) gain, for each table:
     - the owning domain
     - the aggregate root that owns it (this moves `packages/db/src/aggregate/ownership.ts` into the domain)
     - its transaction group
     - the capabilities it needs
   - The lint rule and the closure tests read that declaration.
5. **One store per transaction group.**
   - A command's writes stay in one transaction group.
   - Facts move between groups only through the outbox.
   - The composition root picks one adapter Layer for each group.
6. **The adapters own no ports.**
   - `OutboxDelivery`, `SessionDirectory`, `CapturedMessageStore` and `Transactor` move to `packages/domain`.
   - `packages/db` becomes the PostgreSQL adapter and stops exporting `schema`.
   - The importer and Better Auth's domain reads use ports.
7. **Types refuse a missing capability.** A Layer that does not provide a capability cannot satisfy a program that needs it. Example: a program that needs `AggregateLocks` does not type-check against an object-store Layer.

## Considered options

| Option | D1 modularity and store choice | D4 correctness | D3 latency | Verdict |
| --- | --- | --- | --- | --- |
| **A. Status quo** | Low. One engine; ports are partly in the adapter; the fakes have no contract. | Strong on PostgreSQL. The guarantees are tied to the engine and are not stated. | Best | Rejected by D1 |
| **B. Generic repository** (CRUD + optimistic version) | High | Weak. It loses the lock token, ordered locking and decision reads. Contention becomes retries, which spec 0006b rejected. Guarantees are implicit. | Good | Rejected by D4 |
| **C. Alchemy Domain platform** | Medium. One platform contract; the store under it can be swapped. | Not shown. Typed rejection was lost in the control. The overlap guarantee was PostgreSQL's. There is no bootstrap from existing rows, and erasure leaves a residual. It also replaces the kernel's runtime, which an operator decision forbids. | +28.1% p50, acceptable under D3 | Rejected by D4 and by the kernel decision. Its patterns (Story tests, command-id receipts, checkpoints) stay usable. |
| **D. Capability ports** | High. Each capability is a seam; each group picks its store. | Kept, if every adapter passes the suite with its controls. | No statement is added on PostgreSQL [INFERENCE; to be measured] | **Chosen** |

## Consequences and costs

### Migration effort per domain

Effort is the size of a second adapter. Moving the PostgreSQL adapter is mostly renaming.

| Domain | Adapter code today | PostgreSQL mechanisms | Effort |
| --- | --- | --- | --- |
| Organisation | `organisation.ts` (285 lines) | unique keys, find-or-create | S |
| Content | `socialEvents.ts` (80) | none special | S |
| Files | `files.ts` (101); R2 is already a port | idempotent revive | S |
| Audit and outbox | `outbox.ts` (363) | `SKIP LOCKED`, leases, `jsonb_set` | M |
| Jobs | `jobRuns.ts` (277) | claims, fenced lease | M |
| Workspace | `workspace.ts` (496), `companyAddresses.ts` (123) | shared unique namespace, locks | M |
| Aggregate construct | `aggregates.ts` (411), `locks.ts` (158), `lockScope.ts` (79), `model.ts` (189) | row locks, savepoints | M per adapter |
| Teams | `teams.ts` (925), `adminPlaces.ts` (29) | exclusion constraint, locks, conditional writes, `json_agg`; the TLA+ model | L |
| Accounts | `accounts.ts` (272), `codes.ts` (100), `sessions.ts` (64), plus Better Auth and `auth.ts` | Better Auth's own adapter and tables | L |
| Personal data | `personalData.ts` (281), `retention.ts` (545), `merge.ts` (328), `sql.ts` (145), `export.ts` (58), `photos.ts` (49), `tables.ts` (67) | the catalog compiled to SQL, Oslo time in SQL, a view and a function, `ctid` chunks | L, the largest |

### Transaction groups limit store choice

Today every staff write records audit in the command's transaction (`audit/auditLog.ts:78`; `AGENTS.md:41`). Merge, erasure and retention span teams, accounts and personal data. So today the transactional core is one group, and D1's freedom applies per group, not per table. To gain more freedom, each group must get its own audit and outbox. Those groups are then linked by the outbox, and they lose shared atomicity.

### Risks to races by construction, and what removes each

- **A weaker guarantee in a new adapter.** Example: non-overlap by a check under the lock instead of by a constraint. The strength field makes this visible. The domain names the strength it needs.
- **Fakes that disagree with the real store.** The in-memory adapter must pass the same suite.
- **A model pinned to one engine.** The TLA+ model describes PostgreSQL. A second adapter for teams or accounts needs its own facts pinned, or a model written against the capability.
- **Emergent engine behaviour.** Examples: the exclusion index written before its check, and READ COMMITTED re-checking a row. These become explicit contract cases.
- **Loss of atomicity across stores.** This is removed by construction: one store per group, and the outbox between groups.

### Latency

- A capability port over the same SQL adds a Layer call, not a statement [INFERENCE].
- Measure it with the spike's harness: 100 timed commands after 20 warmups, interleaved.
- Under D3, a cost up to the spike's +28% at p50 is acceptable. Report it; do not gate on it.

### Other

- Better Auth stays on its own adapter. Its reads of domain tables move to ports.
- EmDash is out of scope.
- The `apps/web` raw-SQL tests become adapter tests or use the ports.

## Staged migration plan

| Stage | Change | Done when (falsifier) |
| --- | --- | --- |
| 0 | Accept this ADR. Record the drivers. | Done: accepted 2026-10-28. |
| 1 | Move `OutboxDelivery`, `SessionDirectory`, `CapturedMessageStore` and `Transactor` to the domain. Stop exporting `schema`. Put Better Auth's domain reads and the importer behind ports. | No `@vektorprogrammet/db` import outside composition roots and adapter tests. An import-boundary lint fails otherwise. Done by spec 0017 (`docs/specs/0017-store-ports.md`): `bun run check:store-boundary` and the lint in `vp check`. |
| 2 | Write each guarantee as a property. Add `InTransaction` to `Outbox.enqueue`, `AuditLog.record`, `DigestLedger.claim` and `AlumniRequests.claim`. State the isolation level. | Type tests fail when one of them is called outside a transaction. |
| 3 | Extract the contract suites from the PostgreSQL tests. Make them take an adapter Layer and its broken variants. Run them on PostgreSQL and PGlite. | Every control fails five times out of five without its mechanism. |
| 4 | Build the in-memory adapter that passes the suites. Delete the ad-hoc fakes. | Domain and web tests use it, and the suites pass. |
| 5 | Declare data ownership, transaction groups and capabilities in the per-domain `personalData.ts`. The lint rule and the closure tests read it. | A table without a group or capability fails the closure test. |
| 6 | Pilot a second real store, chosen after stage 4 (candidates: DuckDB for read-only analytics projections; SQLite / D1 for a non-transactional group, `@effect/sql-d1` is already in the lockfile, `AGENTS.md:121`). | The pilot passes every suite it needs. Latency is reported. |

## Decisions on the open questions (operator, 2026-10-28)

These answers are part of the decision.

1. **Transaction groups: one transactional core now.** All transactional domains share one group, one store, and the audit row stays in the same transaction as the write. Per-domain store choice applies only to non-transactional data (analytics projections, files, CMS). Ports are designed so a later split (one audit and outbox per group) stays possible; that split needs its own ADR.
2. **Non-overlap strength: store-enforced for invariants.** An invariant such as non-overlapping memberships must hold against every writer, including the importer and migrations. An adapter that cannot enforce it in the store cannot host that table. Port-enforced strength is allowed only for guarantees that are not invariants.
3. **Retention arithmetic: in Effect, one implementation.** The domain computes the thresholds (Oslo calendar, last activity); adapters only filter by them. During migration, a property test uses today's PostgreSQL view (`person_last_activity_end`) as the oracle, because month arithmetic does not reverse exactly.
4. **Better Auth: stays on PostgreSQL; its domain reads go through ports.** It keeps its own adapter and tables. Its 5 raw reads of domain tables are replaced by domain ports, and its separate `pg` pool reads no domain table.
5. **Formal model: model the capabilities.** One TLA+ model of the abstract guarantees (locks, ordering, conditional writes). Each adapter's contract suite pins that it provides them.
6. **Latency: report, plus a loose alarm.** Each change reports per-command latency. A command whose p95 exceeds a generous ceiling (initially 500 ms) is flagged, not failed.
7. **Isolation: minimum READ COMMITTED plus aggregate locks; stronger is allowed.** The contract suite tests the minimum. An adapter may be stronger, for example SQLite serializing all writers. Serializable-with-retries stays rejected (0006b).
8. **Pilot: the in-memory adapter, contract-tested.** Stage 4 is the pilot. It turns the 2,023 lines of untested fakes into an adapter that passes the suites, and proves the suites before any second real store.

Evidence limits (from the analysis): file:line references were read at `f4bfe78`; effort sizes (S/M/L) are estimates; the capability ports' latency cost is not measured (the +28.1% at p50 is the Alchemy Domain spike's own measurement).
