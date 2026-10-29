# Database platforms

What the domain asks of the platform that its database sits behind, how the PostgreSQL adapter answers on Cloudflare Hyperdrive, and what only a direct connection has. Hyperdrive is a transaction pooler between the Worker and the database: a server connection belongs to a client for one transaction, so anything that lives in a session (advisory locks, `LISTEN`, a session `SET`, SQL `PREPARE`, a `WITH HOLD` cursor) belongs to nobody, and nothing reports the mistake.

The page is generated from two declarations: `packages/domain/src/shared/platformRequirements.ts` (what the domain asks) and `packages/db/src/platform/` (the constructs, the recipes and the connection profiles of the adapter; spec 0025). Run `bun run docs` after changing either, and `bun run check:docs` fails when the page is not what they render.

## How to read it

- **A claim about Hyperdrive says how it is known.** `hyperdrive-docs` and `postgres-docs`: a primary source says so (the sources are in `packages/db/src/platform/constructs.ts`). `spec-0000`: the deployed Worker of slice 0000 measured it through Hyperdrive on 2026-10-16 (`docs/specs/0000-results.md`). `preview-route`: `GET /api/isolation` measures it on every pull request's Preview. `platform-probe`: `GET /api/platform` measures it there. `unverified`: nobody measured it, and the cell says what is claimed.
- **`works`** is as on PostgreSQL; **`scoped`** holds only for the transaction or the statement (the connection is reset when it goes back to the pool); **`unsupported`** is listed as unsupported; **`unknown`** is not documented either way.
- **The `pg-txmode` column is a pointer, not evidence.** The catalogue of `/srv/share/projects/pg-txmode` (pull requests 1, 3 and 4 of `phibkro/pg-txmode`, head `afc310d`) is unmerged and unpublished. No cell here rests on it alone, and nothing imports it.
- **`GET /api/platform` runs on a Preview and under `vp dev`, never on production** (an empty 404). Under `vp dev` the connection is direct: the report names the profile the adapter ran with and the deployment, and cannot tell a pooler from none.

## What the domain asks of a platform

<!-- docgen:begin asks -->

### Shown on every Preview by `GET /api/platform`

| Capability | Guarantee | Check | The platform must show | Evidence |
| --- | --- | --- | --- | --- |
| AggregateLocks | LK1 | `lock-excludes-second-holder` | While one transaction holds a record's lock, a second request for the same lock does not get it. | Through Hyperdrive: `GET /api/platform` on every Preview (two transactions on two pooled connections). On PostgreSQL: `aggregates.postgres.test.ts`, 300 rounds, with its controls. |
| AggregateLocks | LK1 | `lock-ends-with-its-transaction` | When the holder's transaction ends, the lock is free for the next request, on whichever connection that request comes. | Through Hyperdrive: `GET /api/platform` on every Preview (two transactions on two pooled connections). On PostgreSQL: `aggregates.postgres.test.ts`, 300 rounds, with its controls. |
| Transactions | TX1 | `rollback-leaves-nothing` | A transaction that is rolled back leaves none of its writes visible, to the connection that wrote them or to another. | Through Hyperdrive: spec 0000 results (commit, rollback on a typed failure, rollback on interruption, a nested savepoint, 2026-10-16), `GET /api/isolation` (TX3) and `GET /api/platform` (TX1, TX2) on every Preview. On PostgreSQL: `transactions.postgres.test.ts`. |
| Transactions | TX2 | `nested-scope-undoes-alone` | A nested scope that fails undoes its own writes, and the enclosing scope keeps what it wrote. | Through Hyperdrive: spec 0000 results (commit, rollback on a typed failure, rollback on interruption, a nested savepoint, 2026-10-16), `GET /api/isolation` (TX3) and `GET /api/platform` (TX1, TX2) on every Preview. On PostgreSQL: `transactions.postgres.test.ts`. |
| WorkQueue | LS1 | `held-record-is-not-handed-on` | A record that one transaction holds is skipped by a second claimer: it is not waited for and not handed out again while the first transaction holds it. | Through Hyperdrive: `GET /api/platform` on every Preview (a held record is skipped). On PostgreSQL: `outbox.postgres.test.ts`, with its controls. |

### Shown by another port

| Capability | Where |
| --- | --- |
| Transactions | TX3, the isolation floor, is shown by `IsolationProbe` (spec 0018 R10). |

### Not shown by a deployed probe

| Capability | Why not | Evidence |
| --- | --- | --- |
| AnalyticsReads | No store serves it yet. | No adapter yet (ADR 0014, stage 6). |
| Claims | Showing one winner takes a committed record, and a probe on a Preview leaves none. | Through Hyperdrive: spec 0000 results (20 concurrent claims of one key, one winner, PASS, 2026-10-16). On PostgreSQL: `concurrency.postgres.test.ts` and the claim tests of each repository. |
| ConditionalWrites | A conditional write is one step that the store judges at its newest committed state, and a probe needs a committed record to show it. | On PostgreSQL: `aggregates.postgres.test.ts` (300 rounds) and `teams.postgres.test.ts`. Through Hyperdrive: not measured. |
| Leases | It is made of claims and conditional writes. | As `Claims` and `ConditionalWrites`; on PostgreSQL also `jobRuns.postgres.test.ts`. |
| NonOverlap | The store's own constraint decides it, and a probe needs a committed record to show it. | On PostgreSQL: `teams.postgres.test.ts`, falsifier 4, with its control. Through Hyperdrive: not measured (the SQLSTATE of the exclusion constraint reaching the client is not in spec 0000's results). |
| ObjectStore | No pooler sits between the Worker and the object store. | `FileStore` is the R2 binding, not a database. |
| ReadOnlyReads | It is a property of the role and of the reads, shown by a role that can only read. | On PostgreSQL: `readOnlyRole.postgres.test.ts` and `readsNeverWrite.postgres.test.ts`. Through Hyperdrive: not measured. Query caching is off (`alchemy.run.ts`), so a read reaches the database. |
| Snapshots | A snapshot is one read, and a probe cannot tell it from another read on one connection. | On PostgreSQL: `personalDataExport.postgres.test.ts`. Through Hyperdrive: not measured. |
| UniqueKeys | The store's own key constraints decide it, and a probe needs a committed record to show it. | Through Hyperdrive: spec 0000 results (a unique violation classified, PASS, 2026-10-16). On PostgreSQL: the unique-key tests of each repository. |

<!-- docgen:end asks -->

## How the adapter answers

The constructs that a capability uses, and what each is on a direct connection and on Hyperdrive. A recipe is typed `PooledSafeConstruct`: it cannot name a construct of the next section.

<!-- docgen:begin recipes -->

| Capability | Constructs of the adapter |
| --- | --- |
| AggregateLocks | `row-lock` |
| AnalyticsReads | none of its own |
| Claims | `on-conflict-returning` |
| ConditionalWrites | `conditional-update-returning` |
| Leases | `on-conflict-returning`, `conditional-update-returning` |
| NonOverlap | `exclusion-constraint` |
| ObjectStore | none of its own |
| ReadOnlyReads | none of its own |
| Snapshots | none of its own |
| Transactions | `transaction-block`, `begin-isolation-level`, `savepoint` |
| UniqueKeys | `unique-constraint` |
| WorkQueue | `row-lock-skip-locked`, `conditional-update-returning` |

| Construct | What | Direct | Hyperdrive | `pg-txmode` row (unmerged) |
| --- | --- | --- | --- | --- |
| `row-lock` | `SELECT … FOR NO KEY UPDATE`: the aggregate lock; one writer per root until the transaction ends (LK1). | works (postgres-docs): Held until the transaction ends; a second request waits. | works (platform-probe): `lock-excludes-second-holder` and `lock-ends-with-its-transaction`: two transactions on two pooled connections (`GET /api/platform`). | `row-locks` |
| `on-conflict-returning` | `INSERT … ON CONFLICT … RETURNING`: a claim with one winner, find-or-create (CL2, UK3). | works (postgres-docs): One caller inserts; the others see the conflict. | works (spec-0000): `INSERT … ON CONFLICT … RETURNING` and 20 concurrent upserts of one key passed through Hyperdrive (checks 5 and 8, 2026-10-16). | `on-conflict` |
| `conditional-update-returning` | `UPDATE … WHERE <expected state> RETURNING …`: a write that depends on the state it read (CW1). | works (postgres-docs): Judged at the newest committed state of the row. | works (unverified): One statement and its row count; nothing in the platform's documents changes it. No check of this repository isolates it on Hyperdrive. | none |
| `exclusion-constraint` | `EXCLUDE USING gist`: memberships of one person in one team never overlap (NO1). | works (postgres-docs): Refused with SQLSTATE 23P01. | works (unverified): The constraint is the engine's. That SQLSTATE 23P01 reaches the client through Hyperdrive is not in spec 0000's results (23505 is). | `sqlstate-passthrough` |
| `transaction-block` | `BEGIN … COMMIT` and `ROLLBACK`: the atomic unit of every command (TX1). | works (postgres-docs): BEGIN to COMMIT or ROLLBACK. | works (spec-0000): Commit, rollback on a typed failure and rollback on interruption passed through Hyperdrive (checks 2, 3a, 3b, 2026-10-16); `rollback-leaves-nothing` repeats the rollback on every Preview. | none |
| `begin-isolation-level` | `BEGIN ISOLATION LEVEL …`: the isolation floor stated by the transaction itself (TX3). | works (postgres-docs): The level of the transaction, set by its own BEGIN. | works (preview-route): The clause arrives: a transaction begun at SERIALIZABLE reads `serializable` on every Preview (`GET /api/isolation`, spec 0018 R10). | `isolation-level` |
| `savepoint` | `SAVEPOINT`, `RELEASE`, `ROLLBACK TO`: a nested `Transactor.run` (TX2). | works (postgres-docs): A nested scope that fails rolls back to its savepoint. | works (spec-0000): A nested savepoint, inner failure and outer commit, passed through Hyperdrive (check 4, 2026-10-16); `nested-scope-undoes-alone` repeats it on every Preview. | `savepoints` |
| `unique-constraint` | `UNIQUE` and unique indexes: a natural key has one record (UK1). | works (postgres-docs): Refused with SQLSTATE 23505. | works (spec-0000): A unique violation reached `classifySqlFailure` through Hyperdrive (check 6, 2026-10-16). | `sqlstate-passthrough` |
| `row-lock-skip-locked` | `FOR UPDATE SKIP LOCKED`: the outbox claim never takes a row that another claimer holds (LS1). | works (postgres-docs): A row that another transaction holds is left out. | works (platform-probe): `held-record-is-not-handed-on` (`GET /api/platform`). | `skip-locked` |

<!-- docgen:end recipes -->

## What only a direct connection has

The subset of PostgreSQL that Hyperdrive does not take. No recipe, repository or server file uses any of it, and `packages/db/test/platformConstructs.test.ts` reads the SQL of the adapter, the Worker and the migrations to see that none does.

<!-- docgen:begin direct-only -->

| Construct | What | Direct | Hyperdrive | `pg-txmode` row (unmerged) |
| --- | --- | --- | --- | --- |
| `advisory-lock-session` | `pg_advisory_lock`, `pg_try_advisory_lock` and the `_shared` forms: a lock that the session holds. | works (postgres-docs): Held by the session until released. | unsupported (hyperdrive-docs): Listed as unsupported. Behind a pooler the lock stays on a server connection that the next client of the pool gets, so a second client finds a lock it believes it holds (reproduced on PgBouncer in the research report, M1). | `advisory-session` |
| `advisory-lock-transaction` | `pg_advisory_xact_lock` and `pg_try_advisory_xact_lock`: a lock that the transaction holds. | works (postgres-docs): Held until the transaction ends. | unknown (unverified): Neither listed nor excluded: the documents say nothing about the transaction-level form. This adapter does not use it, so that nothing depends on the answer. | `advisory-xact` |
| `listen` | `LISTEN` and `UNLISTEN`. | works (postgres-docs): The session receives notifications. | unsupported (hyperdrive-docs): Listed as unsupported. The channel belongs to a session, and a pooler gives the session to someone else. | `listen` |
| `notify` | `NOTIFY` and `pg_notify`. | works (postgres-docs): Delivered to the listeners. | unsupported (hyperdrive-docs): Listed as unsupported. | `notify` |
| `set-session` | `SET`, `RESET`, `SET SESSION` and `set_config(…, false)`: a setting for the session. | works (postgres-docs): Lasts for the session. | scoped (hyperdrive-docs): The connection is RESET when it is returned to the pool, so the setting vanishes with no error, and on a pooler that does not reset it leaks to the next client (reproduced on PgBouncer, research report M1). | `set-session` |
| `sql-prepare` | `PREPARE`, `EXECUTE`, `DEALLOCATE`, `DISCARD`. | works (postgres-docs): A statement kept by name in the session. | unsupported (hyperdrive-docs): Listed as unsupported: `PREPARE`, `EXECUTE`, `DEALLOCATE` and `DISCARD` at the SQL level. (Protocol-level named statements are another matter, and `prepare: false` is about those: see the README.) | `sql-prepare` |
| `with-hold-cursor` | `DECLARE … WITH HOLD`. | works (postgres-docs): The cursor outlives the transaction. | unknown (unverified): Not documented either way; a cursor that outlives its transaction belongs to a session that a pooler hands on. | `with-hold-cursor` |
| `temporary-table` | `CREATE TEMP TABLE`. | works (postgres-docs): Lives in the session (`ON COMMIT` says when its rows go). | unknown (unverified): Not documented either way. A table that keeps its rows past the transaction belongs to a session that a pooler hands on; this adapter uses none. | `temp-table-preserve` |
| `load` | `LOAD`. | works (postgres-docs): Loads a shared library into the session. | unsupported (hyperdrive-docs): A change to per-session state that the documents do not list as supported. | `other-session-state` |

<!-- docgen:end direct-only -->

## Connection profiles

`DatabaseLive` is the `hyperdrive` profile and `ImportDatabaseLive` the `direct` one: each builds its client from the profile of that name and from nothing else.

<!-- docgen:begin profiles -->

| Profile | Pooling | Statements | Multiplex | Pool size | Allows |
| --- | --- | --- | --- | --- | --- |
| `hyperdrive` | transaction | unnamed (`prepare: false`) | no | 2 | 12 constructs |
| `direct` | none | named | no | 2 | 21 constructs |

| Profile | Setting | Why |
| --- | --- | --- |
| `hyperdrive` | `maxConnections` | A Worker invocation can have six connections waiting at once (Workers limits) and Hyperdrive pools the origin side, so a request asks for few: two, one to hold a transaction and one more for a second transaction of the same request (the platform probe's two-connection checks). |
| `hyperdrive` | `multiplex` | Pipelining several fibers' statements on one connection is not documented for Hyperdrive (unverified), and a transaction needs the connection to itself. |
| `hyperdrive` | `prepare` | Hyperdrive documents named prepared statements for `postgres.js` and `node-postgres`, and says that other drivers "may have worse performance or may not be supported". `@effect/sql-pg` is a native wire client, so it is another driver. With `prepare: false` it sends Parse, Bind, Describe, Execute and Sync in one write and names no statement, so nothing depends on how the platform keeps statement names. That this path works through Hyperdrive is measured (every check of spec 0000); that named statements from `@effect/sql-pg` would work is not. |
| `direct` | `maxConnections` | The importer is sequential: two connections are plenty. |
| `direct` | `multiplex` | One transaction at a time on a connection. |
| `direct` | `prepare` | A direct connection keeps statement names for the session, as PostgreSQL does, so the client names its statements. |

Clients that reach Hyperdrive and are not built from a profile:

| Client | Where |
| --- | --- |
| Better Auth's `pg` pool | `apps/web/src/server/auth.ts` (`max: 2`, unnamed statements) |
| EmDash's Hyperdrive adapter | `apps/cms` (a Hyperdrive configuration of its own, as the role `emdash_app`) |

<!-- docgen:end profiles -->
