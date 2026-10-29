# Spec 0025: An explicit Hyperdrive platform adapter (ADR 0014 stage 1; operator decision, 2026-10-29)

Status: building. Frozen when its pull request opens; later changes are dated entries under Revisions.

## Journey

Four people meet this feature. Each can do the step below on the pull request.

1. **A reviewer reads what the platform is.** `docs/system/database-platforms.md` (generated) has three tables: what the **domain asks** of a platform (per capability, the checks that a platform must show, no engine word); how the **PostgreSQL adapter answers on Hyperdrive** (per capability, the constructs it uses, each with what Hyperdrive does with it and how that is known); and the **subset that only a direct PostgreSQL connection has** (advisory locks, `LISTEN`, session `SET`, SQL `PREPARE`, …), each with the reason Hyperdrive does not take it.
2. **A developer tries to leave the subset.** She writes `select pg_advisory_lock(42)` (or a session `SET`, or `LISTEN`) in a repository of `packages/db` or in a server file of `apps/web`. `bun run test:all` fails in `packages/db` and names the construct, the file and line, and the catalogue row. A recipe that names such a construct for a capability does not type-check.
3. **A reviewer asks a deployed Preview.** `GET $PREVIEW/api/platform` answers 200 with every check that the domain requires, each `held`, measured **through Hyperdrive** with the adapter's own constructs (two transactions on two pooled connections, a savepoint, a transaction-local setting, `SKIP LOCKED`, the statements the client sends). The pull request's Preview job calls it and fails unless it answers 200. `curl localhost:3000/api/platform` under `vp dev` answers the same from a direct connection.
4. **A developer reads why `prepare: false`.** `packages/db/README.md` says what Cloudflare documents (named prepared statements: supported for `postgres.js` and `node-postgres`, other drivers "may not be supported"), what `@effect/sql-pg` does (a native wire client; `prepare: false` sends unnamed statements in one write), and what is measured and what is not. The old sentence, "Hyperdrive pools in transaction mode, so `prepare: false`", is gone: it was the wrong reason.

## Goal, constraints, values

- **Goal.** Hyperdrive is a platform of the adapter, declared once and checked, and the domain never learns the word. The domain says which properties a platform must show; `packages/db` says which PostgreSQL constructs it uses to give them and what Hyperdrive does with each; a deployed route shows the properties hold where the system runs.
- **Constraints (operator decisions, 2026-10-28/29).** PostgreSQL-specific code stays in the adapter (ADR 0014). The domain asks for capabilities (ACID, transaction boundaries), not for PostgreSQL. The transaction constructs are independent of advisory locks (no advisory lock, `LISTEN`/`NOTIFY` or session `SET`, AGENTS.md). The Hyperdrive/PostgreSQL differences are one subset that is distinct from the direct capabilities, and the types keep them apart. Effect is the adapter's language here, not the only place the platform is decided: the declaration is plain data that the page, the checks and the probe all read.
- **Values.** One declaration, many readers (generate, then test, never copy). A check cannot pass by being absent. A claim about Hyperdrive carries how it is known (`docs`, `spec 0000`, `probe`, `unverified`), and a claim that rests on the unmerged `pg-txmode` catalogue says so in the same cell.
- **Not a dependency.** `pg-txmode` (`/srv/share/projects/pg-txmode`, PRs 1, 3 and 4 of `phibkro/pg-txmode`) is under review and unpublished. This repository imports none of it. Rows of its catalogue are cross-referenced by id and commit and labelled `unmerged`; no cell that the Preview check or a test relies on rests on them alone.

## Decisions

- **D1. The domain asks, the adapter answers.** `packages/domain/src/shared/platform.ts` declares `PlatformRequirements`: for each `Capability` of ADR 0014 either the checks a platform must show (an id, the guarantee it protects, a property in the domain's words) or why the capability needs none (a `NotProbed` with its reason and evidence). `PlatformProbe` is a port that reports checks; `platformProblems` is the one statement of what a report must hold. No SQL word, no table, no pooler.
- **D2. One declaration of the platform, in the adapter.** `packages/db/src/platform/` holds `profiles.ts` (the `hyperdrive` and `direct` connection profiles: pooling, pool size, `prepare`, `multiplex`, what each allows), `constructs.ts` (the closed set of constructs, the two subsets, and for each construct what Direct and Hyperdrive do with it, how that is known, its sources and its `pg-txmode` cross-reference), `recipes.ts` (capability → constructs) and `statements.ts` (which constructs a SQL text uses). `databaseLive.ts` reads its client settings from the profile; the literals `prepare: false`, `multiplex: false` and `MAX_CONNECTIONS_PER_REQUEST` are gone from their old homes.
- **D3. The subsets are types.** `Construct` is `PooledSafeConstruct | DirectOnlyConstruct`, two closed literal sets. `Recipe` accepts only `PooledSafeConstruct`, so a recipe that names an advisory lock does not type-check, and `Hyperdrive.allows` is `PooledSafeConstruct` by type. `DirectOnly` is exported and rendered as the third table.
- **D4. The probe uses the adapter's constructs, on the platform it runs on.** It reads and writes nothing that a command reads or writes: it locks the one admin-list row (the row `AggregateLocks` locks) from two transactions, and its other checks use a transaction-local setting, a savepoint and the statements the client sends. A probe with a transaction that writes (`rollback-leaves-nothing`) rolls it back. It never interrupts a statement (cancel behaviour through Hyperdrive is unverified, and a probe must not be the first to find out). It runs on a Preview and locally, never on production (404, as `/api/isolation`).
- **D5. `/api/isolation` stays.** Spec 0018 R10 and its CI step are unchanged; `/api/platform` adds the checks that need two connections or the client's own statements. Merging the two is a later decision (Not done).
- **D6. The scan is a guard.** The check that no forbidden construct appears in the SQL of `packages/db/src` and `apps/web/src` reads the string and template literals of those files with `oxc-parser` and classifies their text (`statements.ts`). It is a conservative token match on SQL text stripped of comments and quoted strings, not a SQL parser, and it does not see SQL that a program builds from parts at run time. The replacement is `pg-txmode`'s lint, which reads the PostgreSQL parser's own AST; the trigger to switch is that package being published and merged (Not done).
- **D7. `prepare: false` stays, with its true reason.** Cloudflare documents named prepared statements for `postgres.js` and `node-postgres` only (other drivers "may have worse performance or may not be supported"); `@effect/sql-pg` is a native wire client, so it is "another driver". `prepare: false` sends `Parse/Bind/Describe/Execute/Sync` in one write with no statement name, so nothing depends on how a pooler keeps names. That the unnamed path works through Hyperdrive is measured (spec 0000 results, check lines PASS); that **named** statements from `@effect/sql-pg` would work is not measured. The platform probe adds `statements-are-unnamed` so a change of this setting fails on the platform.

## The platform, as declared

| Profile | Pooling | Client | Statements | Pool | Allows |
| --- | --- | --- | --- | --- | --- |
| `hyperdrive` | transaction (Hyperdrive) | `@effect/sql-pg`, `multiplex: false` | unnamed (`prepare: false`) | at most 2 per request | `PooledSafe` constructs |
| `direct` | none | `@effect/sql-pg` | named (`prepare` on) | 2 (the importer) | `PooledSafe` and `DirectOnly` |

`DatabaseLive` is the Hyperdrive adapter (what a Worker builds per request); `ImportDatabaseLive` is the direct one. Better Auth's own `pg` pool (`auth.ts`, `max: 2`) and EmDash's driver connect to Hyperdrive too; they are listed on the page as consumers and are not built from the profile (Not done).

## Requirements

- **R1.** The domain declares `PlatformRequirements`, `PlatformCheck`, `PlatformProbe` and `platformProblems` (D1). A `Capability` without an entry does not type-check. Every check names a guarantee id that `guarantees.ts` declares (a test reads both).
- **R2.** `packages/db/src/platform/` declares profiles, constructs, recipes and the statement classifier (D2, D3). `databaseLive.ts` and `ImportDatabaseLive` read their client settings from a profile; `runtime.ts` takes the pool size from it.
- **R3.** Every recipe uses `PooledSafeConstruct` only; every construct a recipe uses has the Hyperdrive outcome `works` or `scoped`; no recipe, and no construct that `packages/db/src` uses, is an advisory lock, `LISTEN`/`NOTIFY`, a session `SET`, SQL `PREPARE`/`EXECUTE`/`DEALLOCATE`/`DISCARD`, a `WITH HOLD` cursor, an `ON COMMIT PRESERVE ROWS` table or `LOAD`. `Hyperdrive.allows` is a strict subset of `Direct.allows`, and `DirectOnly` is their difference.
- **R4.** `PlatformProbeLive` (adapter) reports, for every check that `PlatformRequirements` lists, `held` with a detail in the engine's words, and the checks of D7; a probe step that cannot run (a second connection that is not given, an unexpected SQLSTATE) is `held: false` with the reason, never a defect that hides the other checks.
- **R5.** `GET /api/platform` answers 200 and the report when `platformProblems` is empty, 500 with the problems otherwise, an empty 404 on production (the store is not asked), and the failure's own status otherwise. `.github/workflows/preview.yml` calls it after the isolation step on every pull request and fails unless it answers 200.
- **R6.** The forbidden-construct scan (D6) runs in `packages/db`'s tests over `packages/db/src` and `apps/web/src`; it fails with file, line, construct and catalogue row.
- **R7.** `docs/system/database-platforms.md` is generated by `bun run docs` from the two declarations and checked by `bun run check:docs`. `packages/db/README.md`, `AGENTS.md` and the header comment of `databaseLive.ts` state D7 and cite the generated page; the sentence in `packages/db/README.md` about code delivery (`Code delivery uses a separate transaction to mint, send and acknowledge a link`, stale since spec 0024) is corrected on the way.
- **R8.** The module graph and the store boundary say what the new imports are: `platformProbe`/`platform` modules of the domain, `tools/docgen` reading `@vektorprogrammet/db/platform` (pure data, no client), each with its reason.

## Failure cases

| Case | What happens |
| --- | --- |
| A required check is missing from the report | `platformProblems` names it; the route answers 500 |
| A check reports `held: false` (a lock that does not exclude, statements that are named, a second connection that is not available) | the route answers 500 with the check's id, guarantee and detail |
| The database cannot be reached | the probe's own statement is a defect, as in `IsolationProbe`: the route answers the failure's status |
| Production | empty 404, no statement |
| A forbidden construct appears in source | the scan fails the test with file, line, construct, row |
| A new `Capability` is added | `PlatformRequirements` does not compile until it says what the platform must show or why nothing |
| Hyperdrive changes a documented cell | not detected here; the row's `verified-on` date and `verifiedBy` say how old the claim is, and the Preview check is what notices a changed behaviour |

## Falsifiers

Each has a negative control. The mutations that were run, and what they did, are recorded in the Revisions.

| # | Falsifier | Negative control | Where |
| --- | --- | --- | --- |
| F1 | **The route and the report.** On a migrated database the probe holds every required check; the route answers 200 with them; a production deployment answers 404 and the probe is not run | a report with one check `held: false`, one missing and one unknown id each fails `platformProblems` (500) | `apps/web/test/platform.postgres.test.ts`, `packages/domain/test/shared/platform.test.ts` |
| F2 | **A check cannot pass by omission.** `platformProblems` lists a required check that is absent, one that is false, and (for the probe) an id that the domain does not declare | the complete report passes | domain test |
| F3 | **The probe can fail.** Each of the checks fails when its mechanism is broken: no row lock in the lock check (`FOR NO KEY UPDATE` taken out), no `SKIP LOCKED`, a client built with `prepare: true`, a pool of one connection | M1 to M3 (Revision R1) and the pool-of-one variant, each run on the real source and restored | `packages/db/test/platformProbe.postgres.test.ts` |
| F4 | **The constructs are independent of advisory locks, by type and by scan.** `Recipe` rejects `AdvisorySession` (type test); the scan finds `pg_advisory_lock`, `pg_try_advisory_lock`, `LISTEN`, `NOTIFY`, `SET search_path`, `set_config(…, false)`, `PREPARE`, `DEALLOCATE`, `DISCARD`, `DECLARE … WITH HOLD`, `ON COMMIT PRESERVE ROWS` and `LOAD` in planted sources; the real tree has none | the same scan over the allowed constructs (`FOR NO KEY UPDATE`, `SKIP LOCKED`, `SET LOCAL`, `set_config(…, true)`, `SAVEPOINT`, `BEGIN ISOLATION LEVEL`, `ON CONFLICT`, `ON COMMIT DROP`) finds nothing, and words in comments and in quoted strings are not found | `packages/db/test/platformConstructs.test.ts` |
| F5 | **The subsets are distinct.** `Hyperdrive.allows` ⊂ `Direct.allows`, `DirectOnly` = the difference, and every `DirectOnly` construct has a Hyperdrive outcome that is not `works` | a mutation that moves one construct into the pooled set fails the type check and the test | same, and `tsc` (M2) |
| F6 | **One declaration of the client settings.** `DatabaseLive` sends unnamed statements and `ImportDatabaseLive` sends named ones, read from `pg_prepared_statements` on the connection | M3: the `hyperdrive` profile with `prepare: true` fails F6 and the probe's `statements-are-unnamed` | `packages/db/test/platformProbe.postgres.test.ts` |
| F7 | **The page is the declaration.** `bun run check:docs` fails when the page is not what the two declarations render, and the rendering is checked against a planted declaration | a changed cell without `bun run docs` fails | `tools/docgen/test`, `check:docs` |
| F8 | **The deployed path.** The Preview job's `GET /api/platform` answers 200 through Hyperdrive | none locally: the check can fail on the platform (each check has F3's control); **not run by this branch**, the pull request's CI is its first run | `.github/workflows/preview.yml` |
| F9 | **Nothing else moved.** `vp check`, `bun run test:all`, `bun run ready`, and the accounts and journey browser specs pass; the membership-writes model is not affected (no covered path changes) | — | CI |

## Not done here

- **Merging `/api/isolation` into `/api/platform`** (D5).
- **Better Auth's `pg` pool and EmDash on the profile.** They connect to Hyperdrive with their own settings; the page lists them.
- **A committed-write probe of claims** (`CL2`, one winner of `ON CONFLICT … DO NOTHING RETURNING`): it would leave a committed row on a Preview. Its Hyperdrive evidence is spec 0000 (20 concurrent upserts, PASS).
- **A PgBouncer harness in CI** (pg-txmode's lane). The stand-in run recorded in the Revisions is a one-off on a developer machine.
- **`pg-txmode`'s lint and catalogue as dependencies** (D6; unpublished).
- **Named prepared statements from `@effect/sql-pg` through Hyperdrive**: not measured (D7).
- **Production**: the route answers 404 there and nothing asserts production's platform until it is deployed (spec 0018 R18 has the follow-up).

## Revisions

### R1 (2026-10-29): first plan

Written before any code, after reading the research report (`../review-evidence/hyperdrive-research/REPORT.md`), spec 0018, `databaseLive.ts`, `isolationProbe.ts`, the Preview job and the unmerged `pg-txmode` catalogue (commit `afc310d`, PR 4). The plan changes under this heading as the build teaches.
