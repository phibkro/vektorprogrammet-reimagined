# Spec 0017: Store ports in the domain (ADR 0014, stage 1)

**Status:** frozen when its PR opens; later changes are dated entries under [Revisions](#revisions) · **Source:** ADR 0014 (`docs/decisions/0014-store-capabilities.md`), accepted by the operator on 2026-10-28: staged plan row 1, decision 6, and answers 1, 2 and 4 · **Evidence:** the repository at main `07c9144` (every `file:line` below was read at that head; the ADR's map was read at `f4bfe78`, so lines that moved are re-stated here) · **Stacked on:** nothing. Stage 1 touches no schema and no migration.

## Journey

Stage 1 changes who owns four store ports, who may read PostgreSQL, and nothing a user can see. Its journeys are a developer's and an operator's, plus one check that a user's journey did not move.

1. **A developer imports the adapter by mistake.** She adds `import { OutboxDelivery } from "@vektorprogrammet/db"` to `apps/web/src/server/outboxSweep.ts`. `vp check` fails on that line and names the rule. The port she wanted is in `@vektorprogrammet/domain`, so the fix is a one-line import change.
2. **A developer tests a delivery program on in-memory ports.** `apps/web/test/support/memory.ts` provides `OutboxDelivery`, `Transactor` and `CapturedMessageStore` without importing `@vektorprogrammet/db`, and the lint would refuse it if it did.
3. **A person signs in, and the Better Auth pool can read nothing of the domain.** Lise signs in with her company address. Better Auth's own `pg` pool is connected as a role that holds privileges on the four `auth_*` tables only. Sign-in, session refusal for a deactivated account, `signInPerson` and `setCredential` all work, because the domain reads go through ports on the application's own database layer.
4. **The operator runs the importer.** `bun run import` loads the same Phase 1 rows, refuses the same protected targets, and rolls back the same way. `tools/import` imports no database engine package. It names `@vektorprogrammet/db` once, where it builds its Layer.
5. **Nothing a user sees moves.** The public site, the control panel, Min side, the activation and reset mails, the queue consumer and the cron jobs behave as at `07c9144` (falsifier 10).

## Goal, constraints, values

- **Goal:** the four ports that sit in the adapter or in the web app (`OutboxDelivery`, `SessionDirectory`, `CapturedMessageStore`, `Transactor`) are declared by the domain; `@vektorprogrammet/db` stops exporting its Drizzle `schema`; Better Auth's five raw reads of domain tables and the importer's writes go behind domain ports; one lint fails every import of `@vektorprogrammet/db` outside composition roots and adapter tests (ADR 0014, stage 1: "Done when").
- **Constraints:**
  - **No behaviour change.** No migration, no new column, no change to a command, grant row, error table or generated document. A moved port keeps its signature and its tests keep their assertions. Only the service key (`@vektorprogrammet/db/OutboxDelivery` becomes `@vektorprogrammet/domain/outbox/OutboxDelivery`, and so on) and import paths change.
  - **Domain stays pure.** `packages/domain` gains declarations (Effect `Context.Service` classes, Schemas, one data module) and no import of `db`, `web`, Drizzle, `pg` or `@effect/sql*`. Its existing `no-restricted-imports` override stays.
  - **Moved ports are not reworded.** Rewriting each guarantee as a property, and adding `InTransaction` where a method needs it, is stage 2 (ADR 0014). The moved doc comments keep their current text, mechanism words included (`conditional UPDATE`, and so on). New declarations (`SignInDirectory`, `ImportTarget`) state their guarantee as a property from the start, because they have no SQL text to preserve.
  - **No shims.** No re-export of a moved name from `@vektorprogrammet/db`, no alias, no deprecated path. Every importer moves in the same commit as its port.
  - **Every commit is green** (`vp check` plus the tests of the packages it touches). The lint lands first with the current violators on a shrinking allowlist (see [Migration order](#migration-order)).
  - **Better Auth stays on its own `pg` adapter and tables** (ADR 0014, answer 4; EX-0017 stays the record of that boundary). Only its reads of domain tables move.
  - **The ports are Effect services whose methods require nothing**; an adapter Layer resolves its dependencies at construction (`effect-services-layers`). No service method runs an effect, except the one Better Auth bridge below.
  - **Latency is reported, not gated** (ADR 0014, answer 6): each changed path reports p50 and p95 per the ADR's method; a p95 above 500 ms is flagged.
- **Values:** one home per fact (a port is declared once, in the domain); a boundary a tool enforces beats one a reviewer remembers; the smallest move that satisfies the ADR's falsifier.

## Inventory at `07c9144`

### A. Ports that move (ADR 0014 section 1 and 3)

| Port | Declared now | Moves to | Adapter that stays in `packages/db` | Importers to update (file:line) |
| --- | --- | --- | --- | --- |
| `OutboxDelivery` with `ClaimedOutboxMessage`, `OutboxClaimToken`, `OutboxAck`, `OutboxClaim`, `OutboxEnding` | `packages/db/src/repositories/outbox.ts:80-175` (key at `:175`); exported by `index.ts:30-37` | `packages/domain/src/outbox/delivery.ts` | `OutboxDeliveryLive` (`outbox.ts:233`) | web src: `outboxDelivery.ts:10-14`, `outboxPublisher.ts:24`, `outboxQueue.ts:21`, `outboxSweep.ts:12`, `accountDelivery.ts:2-3`, `runtime.ts:21-25`; tests: `apps/web/test/{outboxDelivery,outboxPublisher}.test.ts`, `outboxQueue.postgres.test.ts:22`, `deliveryBoundary.postgres.test.ts:14`, `support/memory.ts:7-12`, `support/outboxQueue.worker.ts:9`; `packages/db/test/outbox.postgres.test.ts:29-30` and `repositories.pglite.test.ts:37` |
| `SessionDirectory`, `SessionActivity` | `packages/db/src/repositories/sessions.ts:11-26`; `index.ts:20-23` | `packages/domain/src/accounts/sessionDirectory.ts` | `SessionDirectoryLive` (`sessions.ts:28-63`) | `apps/web/src/server/accounts.ts:2`, `runtime.ts:21-25`, `auth.postgres.test.ts:7-10` |
| `CapturedMessageStore` | `packages/db/src/repositories/capturedMessages.ts:15-23`; `index.ts:18` | `packages/domain/src/outbox/captured.ts` | `CapturedMessageStoreLive` (`capturedMessages.ts:25-73`) | `apps/web/src/server/senders.ts:17`, `runtime.ts:21-25`; tests `sandbox.test.ts:7-10`, `outboxQueue.postgres.test.ts:22`, `support/deliveryLive.ts:6` |
| `Transactor` | `apps/web/src/server/transactor.ts:12-19`; layer `:21-36` needs `SqlClient` and `transactional` | `packages/domain/src/shared/transaction.ts`, next to `InTransaction` | `TransactorLive` in `packages/db/src/transactional.ts`, part of every layer that provides repositories | web src: `jobs.ts:26,85`, `runtime.ts:105,170,194,270-283,472,482`, `accountDelivery.ts:77,90,160` (opens its own `transactional` with a captured `SqlClient`: becomes `Transactor.run`); `vite.config.ts:75`; nine test files import `../src/server/transactor` (`deliveryBoundary`, `jobs`, `outboxQueue`, `readsNeverWrite`, `workspace` and `workspaceNamespace` `.postgres.test.ts`, and `support/{commandOutcome,memory,workspaceDatabase}.ts`) |
| Local fixture people (`LOCAL_PEOPLE`, `DEFAULT_LOCAL_PERSON`, `LOCAL_FAKE_PASSWORD`, `LocalPerson`) | `packages/db/src/localPeople.ts:1-24`; `index.ts:39-44` | `packages/domain/src/localPeople.ts` (data, no engine) | the seed script reads it from the domain | `apps/web/src/server/principal.ts:2` (production code), `sandbox.test.ts:7-10`, `e2e/{accounts,personalData,shell,teams}.spec.ts`, `e2e/support/panel.ts:8,14`. Not a port; moved because production code (`principal.ts`) would otherwise break the lint. |

Differences from the ADR's map, found by re-reading at `07c9144`: spec 0008b added three more web importers of `OutboxDelivery` (`outboxPublisher.ts`, `outboxQueue.ts`, `outboxSweep.ts`); `runtime.ts` lines moved (`:20-25` imports, `:163` `SqlClient`, `:170` `Transactor`, `:182` `DatabaseLive`, `:194` `transactorLayer`); the ADR's `senders.ts:17`, `accounts.ts:2` and `outboxDelivery.ts:2-3` hold at `senders.ts:17`, `accounts.ts:2`, `outboxDelivery.ts:10-14`.

### B. Better Auth's five raw reads of domain tables (`apps/web/src/server/auth.ts`)

All five run on Better Auth's own `pg` `Pool` (`:441-450`, `max: 2`, the Hyperdrive string).

| # | Where | SQL (abridged) | What the domain needs to know | Becomes |
| --- | --- | --- | --- | --- |
| 1 | `:258-270`, `databaseHooks.session.create.before` (Promise ABI) | `select a.state from auth_user u join account a on a.person_id = u.person_id where u.id = $1` | Is the owner of this sign-in user an Active account? A session is refused otherwise. | `SignInDirectory.personOfUser` then `AccountRepository.find` |
| 2 | `:316-337`, `hooks.before` for `/sign-in/email` (Promise ABI) | `select u.email from person p join auth_user u … where p.email = $1 or p.company_email = $1 limit 2` | Which sign-in identity answers to this typed address (private or company)? None or two or more is the same refusal. | `SignInDirectory.match` |
| 3 | `:481-498`, `sessionRefusal` | `select state from account where person_id = $1` | Is the session's person Active? Else `/get-session` is `null` and other paths are `wrongPasswordResponse`. | `AccountRepository.find` (already a domain read) |
| 4 | `:526-534`, `signInPerson` | `select email from auth_user where person_id = $1` | Which sign-in address belongs to this person (the first sign-in after activation)? | `SignInDirectory.signInEmailOf` |
| 5 | `:548-557`, `setCredential` | `select id, name, email, email_verified from person where id = $1` | The profile that Better Auth's `auth_user` row is created from. | `SignInDirectory.profileOf` |

Read 4 touches only `auth_user`, a Better Auth table. It moves too: `auth_user.person_id` is the link between a sign-in and a person (ADR 0014: "keep account linking an explicit connection"), and moving it makes the falsifier simple: the pool holds no privilege outside `auth_*`. `AccountRepository.find` exists today (`packages/domain/src/accounts/services.ts:26-28`); `PersonRepository` has no read of `email_verified` (`Person` has no such field, `teams/entities.ts:40-47`), so read 5 needs a new method.

`runSignInPerson` (`runtime.ts:415-431`) and `runAuthRequest` (`:563-586`) provide `authLayer(env)` alone. After this stage `authLayer` requires `AccountRepository | SignInDirectory`, so both also provide the database layer. A request scope already holds both pools (`liveRequestLayer`, `:211-216`: `databaseLayer` with `MAX_CONNECTIONS_PER_REQUEST = 2` and Better Auth's `max: 2`), so an auth request goes from 2 to at most 4 connections, the number a page request has today.

### C. The importer (`tools/import/src/target.ts`)

| What | Where | Becomes |
| --- | --- | --- |
| `PgClient`, `drizzle-orm`, `import { schema } from "@vektorprogrammet/db"` | `target.ts:15-19` | the adapter file `packages/db/src/repositories/legacyImport.ts` |
| `TABLES`, `BUILT_ON_TABLES` (the truncate list, "`no CASCADE`"), `IDENTITY_TABLES`, `BATCH` | `:55-103` | the same file; it is adapter mechanism |
| `lock table … access exclusive`, protected-records count, `truncate … restart identity`, batched inserts, `setval(pg_get_serial_sequence…)`, count reconciliation, all in `pg.withTransaction` | `:156-262` | `ImportTargetLive` in that file, unchanged statements |
| The service `ImportTarget.replaceAll(rows)` and `TargetWriteError` | `:37-43`, `:115-122` | declared in `packages/domain/src/organisation/legacyImport.ts` |
| `TargetRows`, the six row interfaces, `TARGET_TABLES`, `TargetTable` | `tools/import/src/transform/plan.ts:48-57, 73-137` | the same domain file (they are the port's contract and use domain types only); `plan.ts` and `report.ts` import them from the domain |
| `targetPgLayer` (direct connection, prepared statements on, 2 connections, `applicationName`) | `:270-279` | `ImportDatabaseLive({ url })` exported by `@vektorprogrammet/db`; called once, by `tools/import/src/pipeline.ts:48` |

`tools/import/package.json` drops `@effect/sql-pg` and `drizzle-orm` from `dependencies`; `AGENTS.md` ("a new foreign key to `person` … is named in `tools/import/src/target.ts`'s truncate list") and `tools/import/README.md` name the new file. `vite.config.ts:385` and `:492` name `tools/import/src/target.ts` in two override lists; they move with the file.

### D. The package root (`packages/db/src/index.ts`)

| Export | Line | After stage 1 |
| --- | --- | --- |
| `schema` | `:6` | removed. Eight in-package tests import it through `../src/index.ts` (`aggregates`, `commands`, `concurrency`, `jobRuns`, `retentionGate`, `retentionPeople`, `transactions` and `repositories.pglite`) and import `../src/schema.ts` instead |
| `UniqueConstraint`, `classifySqlFailure`, `transactional` | `:8, :16, :25-28` | stay while a consumer outside `packages/db` needs them: today only `tools/db-path-spike` (allowlisted) |
| `violatedUniqueConstraint` | `:27` | only `packages/db`'s own `teams.postgres.test.ts:49` uses it: that test imports it from `../src/classifySqlFailure.ts` and the root export is removed. Any other export that only the package's own tests use leaves the root the same way (knip checks) |
| `DatabaseLive`, `JobDatabaseLive`, `DatabaseConfig` | `:10-14` | stay; they provide `Transactor`, `SignInDirectory`, `SessionDirectory`, `CapturedMessageStore` and `OutboxDelivery` |
| `ImportDatabaseLive` | new | new |
| the four ports and their schemas | `:18-23, :30-37` | removed (moved) |
| `DEFAULT_LOCAL_PERSON`, `LOCAL_FAKE_PASSWORD`, `LOCAL_PEOPLE`, `LocalPerson` | `:39-44` | removed (moved) |

The rule `vektor-anti-slop/no-owned-table-write` names `import { schema } from "@vektorprogrammet/db"` in its doc comment (`rules/no-owned-table-write.ts:67`) and in one `RuleTester` case (`.test.ts:67`). That spelling stops being possible, so the comment and the case change to the in-package spelling (`import * as schema from "../schema.ts"`). The rule's behaviour does not change. The rule also imports `packages/db/src/aggregate/ownership.ts` by relative path (`:4`); that coupling is ADR 0014 stage 5 and stays (allowlisted, see below).

### E. Everyone who imports `@vektorprogrammet/db` today (outside `packages/db`)

| Class | Files | After |
| --- | --- | --- |
| Composition root (kept) | `apps/web/src/server/runtime.ts` (`DatabaseLive`, `JobDatabaseLive`); `tools/import/src/pipeline.ts` (`ImportDatabaseLive`) | allowed |
| Production code (must leave) | `apps/web/src/server/{accountDelivery,accounts,outboxDelivery,outboxPublisher,outboxQueue,outboxSweep,principal,senders,transactor}.ts`, `tools/import/src/target.ts` | import the domain; `transactor.ts` and `target.ts` are deleted |
| Adapter-level tests (kept) | web `*.postgres.test.ts` and `*.worker.test.ts` that build `DatabaseLive` or call `@vektorprogrammet/db/testing`; `apps/web/test/support/{commandOutcome,deliveryLive,outboxQueue.worker,workspaceDatabase}.ts`; `apps/web/e2e/support/database.ts`; `tools/import/test/roundTrip.test.ts`; `apps/cms/scripts/checkBundle.ts` (builds disposable databases); `tools/db-path-spike/**` (slice 0000 harness) | allowed, listed with a reason |
| Tests and fixtures that only need a port or fixture data (must leave) | `apps/web/test/{outboxDelivery,outboxPublisher,sandbox}.test.ts`, `apps/web/test/support/memory.ts`, `apps/web/e2e/{accounts,personalData,shell,teams}.spec.ts`, `apps/web/e2e/support/panel.ts` (`LOCAL_PEOPLE`; its `db/testing` import, if any, is split off) | import the domain |
| Adapter-level tests that stop using `transactional` | `alumniDelivery`, `auth` and `codeDelivery` `.postgres.test.ts` keep building `DatabaseLive` but run their commands with `Transactor.run`, so the root's `transactional` export has no consumer but the spike | allowed (pattern) |

This table is a snapshot, not a second source: the lint and falsifier 2 enforce the rule, so a file that is missing from the table fails the build rather than the review, and the allowlist declaration (`tools/quality/storeBoundary.ts`) is the one list.

### F. Verified but outside stage 1

`apps/web/src/server/runtime.ts:163` keeps `SqlClient` in `DatabaseServices`, and `DatabaseLive` keeps exposing it (the raw-SQL fixtures of 16 web test files need it). `Transactions` replacing `SqlClient` in the apps is ADR 0014 decision 1, delivered with the contract suites (stages 2 to 4). Also unchanged: the raw SQL in `apps/web/test/*.postgres.test.ts` and `e2e/support/{probes,publicFile}.ts` (stage 3 and 4), `tools/oxlint/anti-slop/rules/no-owned-table-write.ts` reading `ownership.ts` (stage 5), the TLA+ skill (answer 5), `apps/cms` and EmDash (out of scope), the `InTransaction` types of `Outbox.enqueue`, `AuditLog.record`, `DigestLedger.claim` and `AlumniRequests.claim` (stage 2).

## Port signatures

Effect 4.0.6 is the catalogue version (`package.json` catalog). Every service below follows the repository's existing shape: `Context.Service` class, a key `@vektorprogrammet/<package>/<path>/<Name>`, methods with precise success and error types and no requirements, and a `Live` Layer in the adapter. No type parameters.

### Moved verbatim (signature and doc comment unchanged)

```ts
// packages/domain/src/shared/transaction.ts (beside InTransaction)
export class Transactor extends Context.Service<Transactor, {
  readonly run: <A, E, R>(program: Effect<A, E, R>) => Effect<A, E, Exclude<R, InTransaction>>
}>()("@vektorprogrammet/domain/shared/Transactor") {}

// packages/domain/src/outbox/delivery.ts
export const OutboxClaimToken, ClaimedOutboxMessage, OutboxClaim /* Claimed | Held | Settled | Undeliverable */
export type OutboxAck = "recorded" | "claimLost"
export type OutboxEnding = "failed" | "held" | "settled"
export class OutboxDelivery extends Context.Service<OutboxDelivery, {
  claim(id, leaseSeconds): Effect<OutboxClaim>
  markDelivered(id, claimToken): Effect<OutboxAck>
  markFailed(id, claimToken, error: string, next: DateTime.Utc): Effect<OutboxAck>
  markDead(id): Effect<OutboxEnding>
  recordFailure(id, error, next): Effect<"recorded" | "settled">
  markQueued(ids): Effect<void>
  stale({ before, limit }): Effect<readonly OutboxMessageId[]>
}>()("@vektorprogrammet/domain/outbox/OutboxDelivery") {}

// packages/domain/src/outbox/captured.ts
export class CapturedMessageStore extends Context.Service<CapturedMessageStore, {
  readonly record: (message: TransportMessage, key: string) => Effect<void>
}>()("@vektorprogrammet/domain/outbox/CapturedMessageStore") {}
```

- **`InTransaction`, per ADR 0014 stage 2.** None of these four takes it in stage 1. `Transactor.run` provides it. Each `OutboxDelivery` method and `CapturedMessageStore.record` is one statement. The fact that stage 2 must state: `OutboxDelivery.markDelivered` joins the ambient transaction when it is called inside `Transactor.run` (`accountDelivery.ts:97, 110, 151`, where the acknowledgement commits with the minted code) and stands alone otherwise, so its type cannot require `InTransaction`. Stage 1 keeps the signature and records the fact here.
- **`SessionActivity` changes its codec, not its type.** In the domain: `Schema.Struct({ createdAt: Schema.DateTimeUtc, id: Schema.NonEmptyString, lastSeen: Schema.DateTimeUtc, userAgent: Schema.NullOr(Schema.String) })`. The adapter keeps its row codec `StoredSession` with `Schema.DateTimeUtcFromDate` (`sessions.ts:9-16`: a JavaScript `Date` is a driver detail). A type test asserts that the two `Type`s are equal.

```ts
// packages/domain/src/accounts/sessionDirectory.ts
export class SessionDirectory extends Context.Service<
  SessionDirectory,
  {
    readonly byPerson: (
      personId: PersonId,
      now: DateTime.Utc
    ) => Effect<readonly SessionActivity[]>;
  }
>()("@vektorprogrammet/domain/accounts/SessionDirectory") {}
```

### New: `SignInDirectory` (`packages/domain/src/accounts/signInDirectory.ts`)

What the authentication adapter may ask of the domain. Guarantees: every method is a read that writes nothing and takes no lock; each answers from one statement; a failure of the store is a defect, as for every repository (stored rows that do not decode are defects, never absence).

```ts
export const SignInMatch = Schema.TaggedUnion({
  Unique: { email: Schema.String }, // the one sign-in identity's own address
  Unknown: {}, // no identity answers to the address
  Ambiguous: {}, // two or more do: refused like Unknown
});
export const SignInProfile = Schema.Struct({
  id: PersonId,
  name: Schema.String,
  email: Schema.String,
  emailVerified: Schema.Boolean,
});
export class SignInDirectory extends Context.Service<
  SignInDirectory,
  {
    /** The person that owns the Better Auth user `userId`; None for a user with no person. */
    readonly personOfUser: (userId: string) => Effect<Option<PersonId>>;
    /** Which sign-in identity answers to `address` (already lower-cased by the caller): the person's private or company address. */
    readonly match: (address: string) => Effect<SignInMatch>;
    /** The sign-in address of a person's identity; None before the first activation. */
    readonly signInEmailOf: (personId: PersonId) => Effect<Option<string>>;
    /** The profile that an identity is created from; None for an unknown person. */
    readonly profileOf: (personId: PersonId) => Effect<Option<SignInProfile>>;
  }
>()("@vektorprogrammet/domain/accounts/SignInDirectory") {}
```

`match` takes a plain `string` because the caller passes what a person typed. `limit 2` and the join are adapter detail. Today an absent row in reads 4 and 5 is a decode failure that becomes `AuthBoundaryFailure`; after the change `None` becomes the same `AuthBoundaryFailure`, so the typed error and its callers (`runSignInPerson`, `AccountDelivery.setCredential`) do not change.

**The Better Auth bridge (the one place an adapter runs an effect).** Reads 1 and 2 happen inside Better Auth's Promise callbacks. `authLayer` builds one `FiberSet.makeRuntimePromise<AccountRepository | SignInDirectory>()` in its own scope and passes the runner to `makeAuth(pool, secret, siteUrl, run)`; the two hooks call `run(effect)`. The fibers belong to the layer's scope, so closing it interrupts them. A defect in the store rejects the hook's Promise, as a failing `pool.query` rejects it today, and Better Auth creates no session (fail closed). Reads 3 to 5 are plain Effects in the `Auth` service and use the ports directly. The change stays inside EX-0017's file and symbols (`apps/web/src/server/auth.ts`); the exception record gets the new symbol and is re-verified against Effect 4.0.6. Installed guidance: `FiberSet.makeRuntimePromise` has a source header example (`node_modules/effect/src/FiberSet.ts:215-260`) and no `ai-docs` example; the build re-reads it at 4.0.6 (the main checkout's install is 4.0.5, and this worktree has none yet).

### New: `ImportTarget` (`packages/domain/src/organisation/legacyImport.ts`)

The existing importer service, declared by the domain instead of by `tools/import`. Guarantee: **all or nothing**. A typed failure, a defect or an interruption leaves the target exactly as it was; a target that holds an account, a credential, a consent, or durable integration activity is refused (`TargetWriteError` with `step: "protect records"`); the stored row counts equal the plan's, or the replacement fails (`step: "reconcile"`). It opens its own transaction and takes no `InTransaction`; it is a top-level operation like `Transactor.run`.

```ts
export const TARGET_TABLES, type TargetTable, interface TargetRows  // moved from tools/import/src/transform/plan.ts
export class TargetWriteError extends Schema.TaggedError(…)("TargetWriteError", { cause, step })  // unchanged shape
export class ImportTarget extends Context.Service<ImportTarget, {
  readonly replaceAll: (rows: TargetRows) => Effect<Readonly<Record<TargetTable, number>>, TargetWriteError>
}>()("@vektorprogrammet/domain/organisation/ImportTarget") {}
```

`ImportTargetLive` (db) is `Layer<ImportTarget, never, Drizzle | SqlClient>`; `ImportDatabaseLive({ url })` builds the importer's connection settings under it. The statements in `target.ts:156-262` move without change.

### Adapter wiring in `packages/db`

`TransactorLive`, `SignInDirectoryLive`, `SessionDirectoryLive`, `CapturedMessageStoreLive` and `OutboxDeliveryLive` are in `Repositories` (`databaseLive.ts:77-113`), so `DatabaseLive`, `JobDatabaseLive` and `RepositoriesLayer` (PGlite) provide them. `apps/web` stops building its own `transactorLayer` (`runtime.ts:194, 482`) and tests stop wrapping `transactorLayer.pipe(Layer.provideMerge(…))`. `ImportTargetLive` is not in `Repositories`: the importer has its own entry, `ImportDatabaseLive`.

## The boundary lint

**Mechanism (reuse, not new tooling).** The repository already restricts imports with oxlint's `no-restricted-imports` (`vite.config.ts:256-268, 315-330, 692-695`), and `vp check` runs it in the hook, in `bun run ready` and in CI. The lint is a new pattern group on that rule, and one override per allowed file set.

- **Restricted for every file:** `@vektorprogrammet/db` and `@vektorprogrammet/db/*`; a relative path that enters `packages/db` (`(?:^|/)packages/db(?:/|$)`); and the engine packages `drizzle-orm`, `drizzle-orm/*`, `@effect/sql-pg`, `@effect/sql-pglite` and `pg`. Type-only imports count.
- **Allowed by override** (a later override replaces the rule's options, which the existing domain override already relies on): `packages/db/**`, the composition roots, the adapter tests and harnesses listed in one declaration, and, for `pg` only, `apps/web/src/server/auth.ts` (Better Auth's own adapter, answer 4).
- **One declaration.** The allowlist is data: `tools/quality/storeBoundary.ts` (path patterns, each with a reason and, for temporary entries, the commit that removes it). `vite.config.ts` builds the override from it and the staleness test reads it. Where two files disagree there is no second copy to disagree with.
- **Why the engine packages are in the same lint.** The ADR lists the importer's `PgClient` and Drizzle (`target.ts:15-19`) and Better Auth's `pg` pool among the code that depends on PostgreSQL. Without the engine patterns the importer could move to a port and back to raw Drizzle unnoticed.
- **Coverage of the forms** was probed with oxlint 1.88.0 (the binary in the main checkout's store; the repository's `vp lint` may bundle another version, so the build re-runs the probe through `vp lint`): static, `import type`, namespace, `export … from`, `export *`, subpath (`/testing`), `import()` and a relative path into `packages/db/src` were all reported; `require()` was not, and ESM TypeScript has no `require`.
- **Composition roots after this stage:** `apps/web/src/server/runtime.ts` and `tools/import/src/pipeline.ts`. This list is narrower than the Effect role `composition-root` in `vite.config.ts:19-215`, which names all of `tools/import/src/**`; the boundary does not reuse that role for that reason.

**Falsifier and controls: see falsifiers 1 and 2.**

## Falsifiers (each with a negative control)

1. **The ADR's falsifier: no import of the adapter outside composition roots and adapter tests.** A probe file at `apps/web/src/server/boundaryProbe.ts` makes `vp lint` fail with `no-restricted-imports` for each of eight forms (static, `import type`, namespace, `export … from`, `export *`, `@vektorprogrammet/db/testing`, `import()`, a relative path into `packages/db/src`), and for `drizzle-orm`, `@effect/sql-pg` and `pg`. The same probes pass at allowed paths: a file named `boundaryProbe.postgres.test.ts` under `apps/web/test/`, and a file under `tools/db-path-spike/`. **Control:** removing an allowlist entry makes its real file fail, so the rule is positional and not switched off; a probe with no restricted import passes. At the head of the PR `vp lint` reports no `no-restricted-imports` finding. A test in `tools/quality/test/` runs this against the real configuration (a probe written to a temporary file in the target directory and removed afterwards is one way; the mechanism is the build's).
2. **The allowlist cannot rot.** A test fails when an allowlisted file does not exist or no longer imports a restricted module (a permanent entry that stopped being needed is deleted, so the list only shrinks), and when a file imports a restricted module and no entry covers it. Its end state is asserted by path: under `apps/web/src/**` only `server/runtime.ts` and `server/auth.ts` (for `pg`) are allowed; under `tools/import/src/**` only `pipeline.ts`. **Control:** adding an unused entry, or removing a needed one, fails the test.
3. **The ports live in the domain, and the adapter owns none.** A test over the public surfaces asserts that `@vektorprogrammet/domain` exports `OutboxDelivery`, `SessionDirectory`, `CapturedMessageStore`, `Transactor`, `SignInDirectory`, `ImportTarget` and `LOCAL_PEOPLE`, and that the export names of `@vektorprogrammet/db` equal one declared list (`DatabaseLive`, `JobDatabaseLive`, `ImportDatabaseLive`, `DatabaseConfig`, plus the three helpers the spike imports (`transactional`, `classifySqlFailure`, `UniqueConstraint`), and nothing else). `apps/web/test/support/memory.ts` provides the in-memory `OutboxDelivery`, `Transactor` and `CapturedMessageStore` and is not allowlisted, so falsifier 1 proves it imports no adapter. A type test shows `Transactor.run` removes `InTransaction` from a program's requirements and keeps every other requirement (`OutboxDelivery` stays in `R`). **Control:** re-exporting any moved name from the db root fails the export-list test; a `Transactor.run` typed to erase all requirements fails the negative type case.
4. **No behaviour change: the existing tests still hold, and their controls still fail without their mechanism.** The suites that cover the moved ports pass with their assertions untouched (a reviewer reads each test file's diff: import lines and layer wiring only): `packages/db/test/{outbox,transactions,repositories.pglite}…`, `apps/web/test/{outboxQueue.postgres,deliveryBoundary.postgres,codeDelivery.postgres,alumniDelivery.postgres,auth.postgres,outboxDelivery,outboxPublisher,sandbox,jobs.postgres}`, and `bun run test:all`. **Controls (mutations, each run once and restored):** drop the live-claim condition from `OutboxDeliveryLive.claim` and the 300-round test of `outboxQueue.postgres.test.ts` and the 20-claimer test of `outbox.postgres.test.ts` fail (spec 0008b's control); make `TransactorLive.run` skip `transactional` and falsifier 5's failure and interruption cases fail; drop `onConflictDoNothing` from `CapturedMessageStoreLive` and the capture-twice case fails; drop the expiry filter from `SessionDirectoryLive` and `auth.postgres.test.ts`'s session-list case fails. [INFERENCE: the capture and session cases exist under these names; the build confirms each and adds a case where one is missing.]
5. **`Transactor.run` is one transaction on PostgreSQL.** `packages/db/test/transactions.postgres.test.ts:93-160` (commit, typed failure, defect, interruption, savepoint) also runs through `Transactor.run` provided by `TransactorLive`. **Control:** `jobRuns.postgres.test.ts:252` (a write outside a transaction survives), and the mutation in falsifier 4.
6. **Better Auth's pool reads no domain table.** `auth.postgres.test.ts`'s sign-in journeys run with Better Auth's `Pool` connected as a role that holds `SELECT, INSERT, UPDATE, DELETE` on `auth_user`, `auth_session`, `auth_account` and `auth_verification` and nothing else (a helper beside `@vektorprogrammet/db/testing/read-only-role`). They cover: sign-in by private address and by company address; an ambiguous address refused like an unknown one (constant-time hash path kept); a deactivated account refused at session creation (read 1) and at `/get-session` and other paths (read 3); `signInPerson` after activation (read 4); `setCredential` (read 5), with and without `revokeSessions`. **Fail closed:** with the store failing (a `SignInDirectory` that dies), `session.create.before` rejects and no `auth_session` row exists. **Controls:** (a) the test first asserts that the role cannot `SELECT` from `person`, `account`, `membership` or `audit_log` (`has_table_privilege`), so the restriction bites; (b) restoring each of the five raw reads, one at a time, makes the journey that uses it fail with `permission denied for table …` (five mutations, run once each); (c) a hook that swallows the store's failure creates a session for a deactivated account. [INFERENCE: PostgreSQL runs foreign-key checks without the inserting role holding a privilege on `person`, so `auth_user.person_id` inserts need none. If the build finds otherwise, it states the reason here and keeps the control by recording the pool's statements instead.] In production the pool uses the same credentials as the application's (Hyperdrive has one string), so the structural guarantee in production is port-enforced and test-enforced, not role-enforced. A second database role for Better Auth is a separate infrastructure decision, not in stage 1.
7. **One database layer per owned scope.** An acquisition counter on `PgClient` shows one build per request scope and per delivery scope in `liveRequestLayer`, `deliveryLayer`, `runSignInPerson` and `runAuthRequest`, and one release when the scope closes. **Control:** a variant that builds `databaseLayer(env)` for `authLayer` separately counts two (the plausible bug of providing the layer by value twice).
8. **The importer is engine-free, atomic and unchanged.** `tools/import/src` imports no restricted module except `pipeline.ts` (falsifier 1). `tools/import/test/roundTrip.test.ts` (real MySQL to PostgreSQL) produces the same row counts, quarantine, collapsed-semester and missing-file lists as at `07c9144`: the build records them from `main` first and compares them with the report. The refusal cases (`roundTrip.test.ts:537-552`, one per held kind: accounts, codes, `auth_user`, consents, welcome ledger, outbox, captured mail and Slack, job runs, Workspace reports) still end `step: "protect records"` with the target's rows unchanged, and a count that differs from the plan still rolls back. **Controls:** the same refusal test fails when `ImportTargetLive`'s protected-records check is removed; `drizzle-orm` imported into `tools/import/src/plan.ts` fails the lint.
9. **`schema` is gone from the public surface.** The export-list test of falsifier 3 has no `schema`; no file outside `packages/db` mentions `schema.` of the adapter (the lint of falsifier 1 and the type check). **Control:** re-adding `export * as schema` fails the export-list test. The `no-owned-table-write` `RuleTester` still passes with the in-package spelling, and its owned-table cases still fail the rule (spec 0006b's controls).
10. **Nothing a user sees changed.** `bun run ready` passes, and `bun run e2e` passes: the sign-in, Min side (sessions list and its last-seen times), activation, password reset and delivery journeys run through the real stack. The PR description lists the commands and results. **Control:** the browser suite fails on a deactivated account that signs in (it is an existing case of spec 0007; the build names it).

**Latency report (not a falsifier).** Per ADR 0014's method (100 timed requests after 20 warmups, interleaved, main against the branch), for `POST /api/auth/sign-in/email` (the only path whose query count changes: reads 1 and 2 now run on the application's connection, and `authLayer` now needs the database layer) and `Transactor.run` on one command. The PR reports p50 and p95 and flags p95 above 500 ms. [INFERENCE: ports add a Layer call and no statement for the moved ports; the sign-in path gains one extra statement for read 1 (`personOfUser` then `find` instead of one join) and nothing for the others. Measure to confirm.]

## Migration order

Every step is one commit whose subject is a lowercase Conventional Commit and passes `devenv shell -- bunx vp check` plus the tests of the packages it touches. The ratchet comes first: the lint lands with every current violator on a **temporary** allowlist, each later step deletes the entries it fixes, and falsifier 2 fails if a file is left on the list after it stopped importing the adapter.

| # | Commit | Gate beyond `vp check` |
| --- | --- | --- |
| 0 | `build(lint): fail imports of the store adapter outside composition roots` : `tools/quality/storeBoundary.ts`, the pattern group and override in `vite.config.ts`, the staleness test, the probe test; the allowlist holds every file of table E that must leave, marked temporary | `tools/quality` tests; repository-wide `vp lint` green |
| 1 | `refactor(domain): declare Transactor in the domain`: port in `shared/transaction.ts`; `TransactorLive` in `transactional.ts` and in `Repositories`; delete `apps/web/src/server/transactor.ts`; `accountDelivery` uses `Transactor.run`; `runtime.ts`, `jobs.ts` and the nine test files move; `vite.config.ts:75` and the skill's covered-files list (`verify-membership-writes/SKILL.md:36`) follow | falsifier 5; web tests that build a layer |
| 2 | `refactor(domain): declare CapturedMessageStore in the domain` | `outboxQueue.postgres`, `sandbox` |
| 3 | `refactor(domain): declare SessionDirectory in the domain`: domain `SessionActivity` plus the adapter row codec and the type-equality test | `auth.postgres` |
| 4 | `refactor(domain): declare OutboxDelivery in the domain`: the largest; five web src files, `memory.ts`, nine test files | `outbox.postgres` (db), `outboxQueue.postgres` (300 rounds), `deliveryBoundary`, the Miniflare `outboxQueue.worker` test |
| 5 | `refactor(domain): declare the local fixture people in the domain`: `principal.ts`, e2e, seed | `localSeed.pglite`, e2e type check |
| 6 | `refactor(auth): read domain tables through SignInDirectory`: port, `SignInDirectoryLive`, the bridge, `authLayer` requires the repositories, `runtime.ts` provides the shared database layer to `authLayer` (falsifier 7), the restricted-role helper and journeys, EX-0017 record | falsifiers 6 and 7; `bun run check:exceptions`; sign-in e2e |
| 7 | `refactor(import): write through the ImportTarget port`: domain declaration and moved row types, `ImportTargetLive` and `ImportDatabaseLive`, `pipeline.ts` provides it, delete `target.ts`, drop two dependencies, update `AGENTS.md`, `README`s and `vite.config.ts:385, 492` | falsifier 8 (the baseline report recorded from `main` before this commit) |
| 8 | `refactor(db): stop exporting the drizzle schema`: eight db tests import `../src/schema.ts`, root export removed, the lint rule's comment and case, export-list test | falsifiers 3 and 9; `bunx vp -C tools/oxlint test` |
| 9 | `docs: record that store ports moved to the domain`: `AGENTS.md` (architecture list, units table), `packages/db/README.md`, `packages/domain/src/README.md`, `apps/web/README.md`, `tools/import/README.md`, ADR 0014's stage 1 row ("done by spec 0017"), `STATE.md` | `bun run check:docs`; the temporary allowlist is empty |

Final gate before the PR: `devenv shell -- bun run ready`, then `bun run e2e` (check machine headroom first; it starts a browser and the CMS), then the latency report. A pre-push hook runs `bun run test:all` and needs `devenv up -d && devenv processes wait`; run `devenv down` afterwards. `apps/web/src/routeTree.gen.ts` is reverted if the build touched it.

## Out of scope

- **Stage 2:** rewording each guarantee as a property, stating the isolation level, and `InTransaction` on `Outbox.enqueue`, `AuditLog.record`, `DigestLedger.claim` and `AlumniRequests.claim`. This spec records only the `markDelivered` fact above.
- **Stages 3 to 6:** contract suites and their broken variants, PGlite runs, the in-memory adapter and deleting the ad-hoc fakes (`memory.ts`, `inMemory.ts`, `teamsInMemory.ts` stay), data-ownership declarations and moving `ownership.ts`, a second store.
- **Dropping `SqlClient` from `DatabaseLive`'s output**, and converting the raw SQL in web tests and e2e probes.
- **A separate database role for Better Auth in production**, and any change to Better Auth's own tables, hooks, rate limit or EX-0017's Promise boundary beyond the two reads that moved.
- **The domain's SQL-flavoured contract text** (`aggregate.ts:18, 67`, `teams/services.ts:142-143` and the others in ADR section 1) other than the moved ports' own comments.
- **EmDash and `apps/cms`'s database**, the TLA+ model, the latency alarm as a gate.
- **Any new user-visible behaviour**, schema change or migration.

## Resolutions of the open questions

Proposals this spec builds. Each is one declaration or one sentence the operator can overrule by changing that one place.

1. **Web `*.postgres.test.ts` and `*.worker.test.ts` count as adapter tests,** because each builds the real database Layer against a disposable PostgreSQL. They stay on the allowlist by naming pattern. The alternative (moving them to `packages/db`) is stage 3 and 4 work.
2. **The local fixture people move to the domain** (`packages/domain/src/localPeople.ts`), because `apps/web/src/server/principal.ts` is production code and reads them; the list is data and has no engine in it.
3. **`DatabaseLive` keeps exposing `SqlClient`** until the contract suites exist (above, F).
4. **All five Better Auth reads move, including read 4,** which touches only a Better Auth table: it is the person-to-sign-in link, and the result lets the test state "no privilege outside `auth_*`".
5. **The lint also covers the engine packages** (`drizzle-orm`, `@effect/sql-pg`, `@effect/sql-pglite`, `pg`), with `pg` allowed only in `auth.ts`: without it the importer's raw engine use is unguarded.
6. **`tools/db-path-spike/**`** is allowlisted as an adapter-level harness (slice 0000, torn down and redeployable) and **`tools/oxlint/anti-slop/rules/no-owned-table-write.ts`** as an adapter-coupled lint rule (stage 5 removes it); both entries name their reason and retirement.
7. **`ImportTarget` and its row types live in the domain** (`organisation/legacyImport.ts`), because they are the port's contract and use domain types only; the planner imports them from there.
8. **The number 0017 is the lead's assignment.** `docs/specs/` holds no 0009 to 0016 at `07c9144`.

## Checks the build runs and reports

`devenv shell -- bunx vp check` (format, lint with the new rule, type check with the Effect diagnostics), `bun run test:all`, `bun run check:exceptions` (EX-0017 scope), `bun run check:docs`, the knip step of `bun run ready`, `bun run e2e`, and the mutations of falsifiers 4, 6 and 8 each run once and restored. There is no `effect-house` overlay in this repository (`.agents/skills/` holds `review-pr`, `verify-membership-writes` and `verify-vektorprogrammet`), so `AGENTS.md` names the gates. The report names the Effect version of the build and every API for which installed guidance had no entry (`FiberSet.makeRuntimePromise` has a source example only).

## Revisions

None yet.
