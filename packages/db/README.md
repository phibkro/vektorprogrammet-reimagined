# @vektorprogrammet/db

PostgreSQL: the Drizzle schema (single source), the generated migrations, and the Layers that implement `@vektorprogrammet/domain`'s repository services, the outbox and the audit log. Built on `@effect/sql-pg` and Drizzle `effect-postgres`. Consumers import only from the package root.

## Public API (`src/index.ts`)

| Export | What it is |
| --- | --- |
| `schema` | Drizzle tables for organisation, teams, accounts, codes, outbox and audit. Better Auth owns `auth_user`, `auth_session`, `auth_account` and `auth_verification`. |
| `UniqueConstraint` | The constraint names that map to `AlreadyExists`: `department_city_unique`, `semester_term_year_unique`, `person_email_unique`, `team_department_name_unique` and the exclusion constraint `membership_no_overlap`. |
| `DatabaseLive({ url, maxConnections? })` | `Layer<` every repository (`DepartmentRepository`, `AdmissionPeriodRepository`, `SemesterRepository`, `FieldOfStudyRepository`, `SocialEventRepository`, `PublicFileRepository`, `PersonRepository`, `TeamRepository`, `PositionRepository`, `MembershipRepository`, `AdminGrantRepository`, `AccountRepository`, `CodeRepository`, `DigestLedger`, `PrincipalDirectory`) `\| AggregateLocks \| Aggregates \| Outbox \| AuditLog \| OutboxDelivery \| SqlClient, SqlError>`. One pool per build. `PgClient` is not exposed. `AggregateLocks` is the domain's lock service; `Aggregates` is the writer (§ Aggregate locks and writes). |
| `transactional(effect)` | Runs the effect in `SqlClient.withTransaction` (a savepoint when nested) and provides `InTransaction`. The only provider of `InTransaction`. A typed failure, a defect or an interruption rolls back every row, including audit and outbox rows. A failing BEGIN/COMMIT is a defect. It also opens the scope of the aggregate locks that the level takes (§ Aggregate locks and writes). |
| `OutboxDelivery` | `claimDue({ limit, leaseSeconds, ids? })`, `markDelivered(id, claimToken)`, `markFailed(id, claimToken, error, nextAttemptAt \| "dead")`. Acknowledgements return `"recorded"` or `"claimLost"`. |
| `ClaimedOutboxMessage`, `OutboxClaimToken`, `OutboxAck` | The delivery-side schemas and types. |
| `classifySqlFailure(failure, key)` | `Exit.fail(AlreadyExists)` for a unique violation of a known constraint, `Exit.die(failure)` for anything else. It unwraps Drizzle's `EffectDrizzleQueryError` to the `SqlError`. |
| `violatedUniqueConstraint(failure)` | The violated unique constraint name, if any (for the importer's quarantine report). |

### Repository behaviour

- Every method fails only with the domain errors its interface lists. Infrastructure failures, check or foreign-key violations, and stored rows that fail to decode are defects.
- Rows decode through the domain schemas.
- `SemesterRepository.ensure` (RULE-237) is one `INSERT … ON CONFLICT (term, year) DO UPDATE SET term = EXCLUDED.term RETURNING`, so it always returns the single row. Only the scheduled semester job calls it (spec 0003); there is no create-or-refuse variant, because nobody creates a semester by hand. `find` is a plain `SELECT`.
- `AdmissionPeriodRepository.list` is a plain `SELECT` (the public pages read the admission state; the importer is the only writer of admission periods in Phase 1).
- The content tables (`article`, `article_department`, `static_content`, `sponsor` and the enum `sponsor_size`) were dropped by the migration `content_moved_to_the_cms` (spec 0005): the CMS owns that content. The migration also tightens the `audit_log` action and entity checks, so it fails if an audit row of a retired action exists (the importer's databases and Neon `dev` hold none).
- `PublicFileRepository.register` is idempotent on `key`, and the stored row wins. Deleted files (`deleted_at`) never resolve.
- Outbox delivery is at least once. Rows are claimed in id order with `FOR UPDATE SKIP LOCKED` inside one `UPDATE … RETURNING`. A claim token fences every acknowledgement. The caller chooses the retry schedule and when a row is dead. Every timestamp comes from Effect's `Clock`.

### People and teams (spec 0006)

- Tables `person` (its department is its field of study's, joined, never stored), `team` (unique name per department, `default_term` 1 or 2, deactivated and never deleted), `position` (a value list; the migration `positions_seeded` inserts `Leder` and `Medlem`), `membership`, `admin_grant`, `admin_list` (one row, `id = 1`, that holds no data and exists to be locked; the migration `admin_list_seeded` inserts it) and `ending_soon_digest`. The `audit_log` columns are `person_id` or `system_job`, exactly one of them (a check), and no foreign key.
- A membership stores its term as `start_term`, `start_year`, `end_term`, `end_year`, and two generated columns, `start_ordinal` and `end_ordinal` (`year * 2 + (term = HOST)`, so Vår 2026 is 4052 and Høst 2026 is 4053). Its state (Planned, Active, Ended) is never stored. `start ≤ end` is the check `membership_term_order`. One person's terms in one team never overlap: the exclusion constraint `membership_no_overlap` (`EXCLUDE USING gist (person_id WITH =, team_id WITH =, int4range(start_ordinal, end_ordinal, '[]') WITH &&)`). A violation of it is `AlreadyExists` (`classifySqlFailure` reads SQLSTATE 23P01 from the driver's `ConstraintError`).
- A transition is a conditional update. `MembershipRepository.setEnd` is `UPDATE … WHERE id = $1 AND end_ordinal = $observed AND start_ordinal <= $current AND end_ordinal >= $current`; `remove` is `DELETE … WHERE id = $1 AND start/end = $observed AND start_ordinal > $current`. A row that no longer matches is a `Conflict`, never a silent overwrite. `teams.postgres.test.ts` races twenty callers, and replays the successes in the order they committed to check that the row is consistent.
- `MembershipRepository.insert`, `setEnd` and `remove`, and `AdminGrantRepository.create`, take the person's `Locked` token (spec 0006b, which replaced R6's hand-placed `SELECT … FOR NO KEY UPDATE`). PostgreSQL writes an exclusion constraint's index entry before it checks it, so two overlapping writes of one person that start together would wait for each other and one would die as `deadlock_detected` (40P01) instead of `23P01`. That error is no verdict on the data, so `classifySqlFailure` keeps it a defect; the person's lock makes the second write wait before it writes anything, so it meets the committed row (`AlreadyExists`) or a rolled-back one (success). `teams.postgres.test.ts` races both pairs (two inserts, an extension and an insert) for 300 rounds each. That guards the contract with the lock in place; it is not the control, because without the lock those races fail only now and then. The controls fail every time the lock is taken away (spec 0006b R3): a test that holds the person's row lock in an open transaction to show that an insert waits for it, and the replay test whose update is unconditional and stays legal only because of the lock.
- `AdminGrantRepository.revoke(adminList, holder, id, validAfter)` is atomic and requires `InTransaction`. It decides through the admin list's token (spec 0006b R2): the place is deleted, through the holder's token, unless it is the last place that ends after `validAfter` and that an Active account holds (`"last"`). Two revocations at once queue behind the list's lock and the second is told it is the last one, for one holder and for two (300 rounds each), and a revocation that follows a deactivation sees the deactivated administrator's place as not counting. `DigestLedger.claim` is `INSERT … ON CONFLICT DO NOTHING RETURNING`, and its table is `NotOwned`.
- `PrincipalDirectory.byName` loads a person's active memberships and admin places in one statement (`json_agg` subselects) and builds the principal with the domain's `personPrincipal`.

### Accounts and sessions (spec 0007)

- `account` stores the state, and only `Aggregates.apply` changes it. `code` stores one hash per purpose and person. Conditional updates enforce expiry and single use, under the person's lock.
- A partial unique index applies to verified private e-mail addresses. Company addresses have a separate unique index.
- `SessionDirectory` derives last seen from the session creation time and its latest audit entry. Audit rows include the session and client kind.
- `captured_mail` is the non-production mailbox. The outbox does not hold plaintext codes, even before delivery.
- The Phase 1 importer refuses an account-bearing target. It cannot restore credentials after replacement.

### Aggregate locks and writes (spec 0006b)

A person's own rows (`membership`, `admin_grant`, `account`, `code`) are written only by a transaction that holds the person's row lock, and the lock is a value: forgetting it is a type error, where R6's hand-placed lock was a convention that a single-attempt test did not notice.

- **Declaration.** `src/aggregate/ownership.ts` is plain data: each root (`AdminList`, which owns nothing, and `Person`, in the order of the domain's `AggregateRoots`) and the tables it `owns`, with the owner column and, for a stored machine, the `state` column. `NotOwned` lists the tables that refer to a root and that no root owns (`auth_user`, `ending_soon_digest`), each with its reason. `declaration.ts` turns the data and `schema.ts` into typed handles: `Person.owned.membership`. The closure test `test/ownership.test.ts` fails when a table with a foreign key to `person` is neither owned nor `NotOwned`, or when an owner column is not a foreign key to the root.
- **Lock.** The domain's `AggregateLocks`: `lock("Person", id)` runs `SELECT … FOR NO KEY UPDATE` on the root's row and returns `Locked<"Person">`; `lockAll("Person", ids)` locks several rows of one root in ascending id order in one statement. `lock("AdminList", ADMIN_LIST_ID)` does the same for the admin list's one row. Both need `InTransaction`, and the row lock ends with the transaction (it is not an advisory lock). A second `lock` of a held row sends no statement. A lock that would come before one the transaction holds (a lower id, or an earlier root: the admin list comes before every person) is a `LockOrderViolation` defect, found by the first run that reaches it, so a command locks everything it needs in one `lockAll` before its first decision read.
- **Token.** `Locked` carries the row's id and root and a brand type that an object literal lacks, so a token made by hand does not type-check. The types do not tie a token to its row: a spread of a real token with another `id` (`{ ...held, id: 7 }`) copies the brand and type-checks. The run-time check does: every use asks the locks that the running transaction holds, so a token made by hand, respelled for a row that this transaction does not hold, of another root, from a finished transaction or from a savepoint that was rolled back dies as `LockNotHeld`. `transactional` opens a scope for each level: a failed savepoint drops its locks (PostgreSQL releases them with the rollback), a successful one hands them to its parent.
- **Writer.** `Aggregates` (`aggregate/aggregates.ts`) is the only module that inserts into, updates or deletes from an owned table; the lint rule `vektor-anti-slop/no-owned-table-write` rejects Drizzle writes of an owned table anywhere else, and a `set({ state })` with a message of its own. It fills the owner column from the token and adds `owner = token.id` to every `WHERE`, and to the `DO UPDATE` of an upsert (spec 0006b R3): an upsert whose target leaves the owner column out and collides with another owner's row writes nothing.

| Method | What it does |
| --- | --- |
| `select(locks, owned, where?)` | The decision read: the rows of the locked owners, which nobody else can change until the transaction ends. |
| `insert(locked, owned, values, onConflict?)` | Inserts a row for the owner. `onConflict` is `{ action: "ignore" }` or `{ action: "replace", set, target }`; `replace` sets columns of the owner's own row only. |
| `update(locked, owned, { set, where? })` | Sets columns of the owner's rows. The owner column and a machine's state are not values of a set; a set that names either is a `ProtectedColumn` defect. |
| `remove(locked, owned, where?)` | Deletes the owner's rows. |
| `updateRoot(locked, root, set)` | Sets columns of the root's own row (the person's name, e-mail verification). |
| `apply(transition, locked, row)` | The spec's `Machine.apply`: `UPDATE … SET state = to WHERE owner = $1 AND state = ANY(from)`, a `Conflict` on zero rows. The only writer of a stored state. |
| `assertHeld(root, locks)` | For a decision read of the root's own row (`PersonRepository.findLocked`). |

- **Reads.** A read that decides a write is a repository method that takes the token (`findLocked`, `listLocked`). A read for display stays unlocked (`find`, `list`) and keeps passing the SELECT-only role test (`apps/web/test/readsNeverWrite.postgres.test.ts`); locked reads run inside commands and are not in that registry.
- **The admin list (spec 0006b R2).** Whether an Active administrator is left spans every administrator, so the list is a root of its own, and a command that decides on it locks it before any person (`lockAdminList`, the domain's `AggregateLocks.lock("AdminList", ADMIN_LIST_ID)`: the singleton row of `admin_list`, which holds no data). `deactivateAccount`, `reactivateAccount`, `createAdminGrant` and `deleteAdminGrant` take it first. `AccountRepository.isLastActiveAdmin(adminList, personId, now)`, `AdminGrantRepository.revoke(adminList, holder, id, validAfter)` and `AdminGrantRepository.create(adminList, locked, draft)` take its token, and both decisions read `activeAdminPlaces` (`repositories/adminPlaces.ts`): a place that ends after the cut-off and that an Active account holds. A place that a Deactivated or Invited account holds does not count. A decision about a few known people (a merge) still locks them in one `lockAll`.
- **Tests.** `aggregate.types.test.ts` (type cases under `@ts-expect-error`, EX-0024, and the one case that pins what the types let through: a respelled token), `aggregates.postgres.test.ts` (300 rounds of opposite-order `lockAll` and of two concurrent transitions, each with a negative control that fails as it should; the registry rules, among them the token that no lock made and the respelled one; an upsert that never rewrites another owner's row; and the admin list before every person), `adminList.postgres.test.ts` (R2: 300 rounds of a deactivation against a revocation, with and without the deactivation's write held back, the hand-written control that leaves no Active administrator, the stale principal, and each of the four commands waiting for the list's row lock with nothing written), `ownership.test.ts` (the closure, with negative controls), the R6 races in `teams.postgres.test.ts` (R3: the guard with the lock in place, and the two controls that fail every time it is taken away), and `membershipWriteModel.postgres.test.ts` (the PostgreSQL facts that the TLA+ model of `.agents/skills/verify-membership-writes` takes: the exclusion constraint's checks, the row lock, the probe that `lockAll` takes its rows lowest first one at a time, and one test per membership command that it waits for a person's lock before it writes). A lock-wait test reads the waiting backend's own state, `wrote` (its write locks) and `hasTransactionId`, from `meetsHeldLock`: under READ COMMITTED another session cannot read an uncommitted row, so a read of the table cannot show a write that came before the lock (R4). A race test runs 300 rounds in fresh state, prints each loser's full Cause and names its round count.
- **A new owned table.** Add it to `schema.ts` with the foreign key to the root, list it under the root in `ownership.ts` (`owner`, and `state` for a stored machine), write its repository methods with `Locked` and `Aggregates`, and lock first in the command. The closure test fails until the table is declared, and the lint rule rejects a direct write.

## Hyperdrive rules

- `PgClient` runs with `prepare: false` (Hyperdrive pools in transaction mode), `multiplex: false`, and a small `maxConnections`. The settings live in `DatabaseLive`.
- This package uses no advisory locks, no LISTEN/NOTIFY and no session `SET` (the `SET LOCAL` statements are in tests, each ending with its own transaction: `aggregates.postgres.test.ts` shortens `deadlock_timeout` in its negative control, and `codecs.postgres.test.ts` sets a time zone). Invariants come from constraints, `ON CONFLICT … RETURNING` and row locks taken inside a transaction: `AggregateLocks` (`SELECT … FOR NO KEY UPDATE`) is the only way a command locks a row.
- Domain command transactions never contain provider I/O. Code delivery uses a separate transaction to mint, send and acknowledge a link (spec 0007 R1).
- Turn Hyperdrive query caching off (architecture §4).

## Migrations

`src/schema.ts` is the only source; the generated migrations are never edited by hand. What Drizzle cannot model is a custom migration (`drizzle-kit generate --custom --name <change>`, then the SQL is written): the exclusion constraint `membership_no_overlap` (with `CREATE EXTENSION btree_gist`) and the seed of the position value list. A rename that Drizzle cannot guess goes in as a hint: `drizzle-kit generate --name <change> --hints '[{"type":"rename","kind":"column","from":[…],"to":[…]}]'`.

```sh
devenv shell -- bash -c 'cd packages/db && bunx drizzle-kit generate --name <change>'  # writes drizzle/<timestamp>_<change>/
devenv shell -- bash -c 'cd packages/db && bunx drizzle-kit check'                     # schema and migrations agree
devenv shell -- bash -c 'cd packages/db && bunx drizzle-kit migrate'                   # applies to $DATABASE_URL
```

`drizzle.config.ts` reads the target only from `DATABASE_URL`. For a Neon branch, export that branch's direct (non-Hyperdrive) URL in your shell. Never store it in a file.

## Neon

The deployed database is Neon project `bold-poetry-64036846` (name `vektorprogrammet`, `aws-eu-central-1`, PostgreSQL 18). Devenv's local server runs the same major version, so a local migration rehearses the deployed one.

| Branch | What lives there |
| --- | --- |
| `production` (default) | Roles and grants only. The schema is applied at the first deploy. |
| `dev` | Migrations applied. Used for slice 0000 and for the preview deployments. |
| one throwaway branch per import rehearsal | Created for a rehearsal and dropped afterwards. |

| Role | Use |
| --- | --- |
| `neondb_owner` | Migrations and the import, over a direct connection. |
| `vp_app` | DML only. Created in SQL so it is not a member of `neon_superuser`; Hyperdrive connects as this role. |

The two secrets are declared in `secretspec.toml` (`NEON_API_KEY`, `NEON_APP_PASSWORD`). Values live in each developer's own `secretspec` provider, never in the repository, and reach a command only through `secretspec run -- …` with a `SECRETSPEC_REASON`. No connection URL is ever stored; ask Neon for it at runtime:

```sh
bunx --bun neonctl@8.7.2 --api-key "$NEON_API_KEY" --project-id bold-poetry-64036846 \
  connection-string <branch> --role-name <role> --database-name vektorprogrammet
```

**Trap:** devenv exports `PGHOST`/`PGPORT` for the local server, and a Neon URL carries no port, so libpq would dial Neon on devenv's 54321 and hang. Clear them first:

```sh
unset PGHOST PGPORT PGDATA
```

## Tests

```sh
devenv shell -- bash -c 'cd packages/db && bunx vp test'   # PGlite and real PostgreSQL
devenv shell -- bash -c 'cd packages/db && bunx vp check'  # format, lint, type check
```

- `*.pglite.test.ts`: the production `RepositoriesLayer` and the generated migrations on an in-memory PGlite (`drizzle-orm/effect-pglite` and `@effect/sql-pglite`).
- `*.postgres.test.ts`: devenv's PostgreSQL 18 through `DatabaseLive`. Each suite creates `vp_db_test_<random>` through `TEST_DATABASE_ADMIN_URL`, applies the migrations, and drops the database when the suite ends. The suite never uses the `vektorprogrammet` database. A missing `TEST_DATABASE_ADMIN_URL` fails the suite and does not skip it. A run that is killed before cleanup leaves its database behind. Drop leftovers with: `psql "$TEST_DATABASE_ADMIN_URL" -Atc "select datname from pg_database where datname like 'vp_db_test_%'"`. The helper (`test/support/disposableDatabase.ts`) is also exported as `@vektorprogrammet/db/testing`, so `tools/import`'s round trip and the `apps/web` browser tests create their databases the same way.
- Every statement the helper runs as the admin (create, drop, the role's grants) goes through `withClient`: a client with one connection that lives only for that statement. A release must not wait on a client built earlier in its own scope. A pooled client retires a connection it finds idle for 60 to 120 seconds, and it cannot open another one while its scope is closing (Effect 4.0.5 and 4.0.6, whose `Pool.ts` is identical: `Pool.get` forks the replacement into the scope, which is already closed during its finalizers). A release after that window never returns. The browser tests in CI took more than two minutes, so the step ended its tests and then never exited. `test/disposableDatabase.postgres.test.ts` moves a `TestClock` five minutes with the database open and checks that the release still drops it (it fails with the old pooled release).
- `readOnlyRole` (`test/support/readOnlyRole.ts`, exported as `@vektorprogrammet/db/testing/read-only-role`) adds a login role on the disposable database that holds `SELECT` and nothing else. Code run through it that succeeds wrote nothing; a write is refused with `permission denied`. `test/readOnlyRole.postgres.test.ts` proves it reads and refuses INSERT, UPDATE, DELETE, TRUNCATE, `ON CONFLICT DO UPDATE`, sequence use, temporary tables and `CREATE`. `apps/web`'s `readsNeverWrite.postgres.test.ts` uses it for spec 0003, falsifier 3. The role is cluster-wide: the layer drops it before it drops the database. Leftovers: `select rolname from pg_roles where rolname like 'vp_read_only_%'`.
- Build the PostgreSQL layer with `excludeTestServices: true`. The pool reads the Clock it was built with to track connection age. When a test moved a shared `TestClock`, the suite hung. Tests that need fixed time nest `it.layer(TestClock.layer())`. At least one cause of that hang is gone: the disposable database's own release (see `withClient` above). The rule stays, because nobody has measured the suites without it.
- The PGlite database loads `btree_gist` (`@electric-sql/pglite/contrib/btree_gist`), because the migration `membership_no_overlap` creates the extension.
- The local seed gives Ada, Lise and Nora fake bcrypt credentials. Mats starts without an account for the invitation journey. The same seed runs on fake-data Preview branches.

Each Behavior Contract rule that the database enforces is covered by a test whose name contains the rule id. These rules are RULE-096, 133, 188, 189, 237, 249, 290 and 296.

## Drizzle `1.0.0-rc.5`

- `drizzle-orm` and `drizzle-kit` are the final `1.0.0-rc.5` (npm tag `rc`) in the root catalog, with no patch and no type bridge. It loads `drizzle-orm/effect-postgres` and `effect-pglite` with Effect 4.0.6 (rc.4 failed with `Schema$1.TaggedErrorClass is not a function`), and its declarations import `effect/sql/SqlError`, so Drizzle's `transaction` and `migrate` error types are real.
- The `Drizzle` service's type (`src/internal/drizzle.ts`) leaves the driver's raw result open: with the SqlError types resolved, `effect-postgres` and `effect-pglite` databases differ in it (`Result` against PGlite's `Results`), and the repositories read mapped rows only.
- rc.5 breaking changes this package meets: no query parameters in errors (`paramsInErrors` is off; `classifySqlFailure` reads the `SqlError` cause, not parameters), JSON parameters are serialised by Drizzle (the outbox `payload` is `jsonb` and nothing calls `JSON.stringify`), `undefined` in a relational `where` throws (no relational queries here), and `getTableUniqueName` changed. `drizzle-kit` rc.5 refuses a version 8 snapshot (`snapshot.json is not of the latest version, please run "drizzle-kit up"`), so `drizzle-kit up` rewrote the six `drizzle/*/snapshot.json` files to version 9. No `migration.sql` changed: the migrator reads those, so the migrations apply as before, and `bun run db:check` and `bun run db:generate` (no schema changes) pass.
- **Verification:** `bunx vp test` in this package, and `bun run db:check`. Both Drizzle drivers run against PGlite and PostgreSQL 18.

A related Drizzle behaviour shapes the schema: Drizzle selects `bigint` columns as `::text`. That breaks `id IN (subquery)` in the outbox claim. For this reason the outbox and audit ids are `integer` identities.
