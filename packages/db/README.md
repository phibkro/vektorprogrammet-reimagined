# @vektorprogrammet/db

PostgreSQL for Phase 1: the Drizzle schema (single source), the generated migrations, and the Layers that implement `@vektorprogrammet/domain`'s repository services, the outbox and the audit log. Built on `@effect/sql-pg` and Drizzle `effect-postgres`. Consumers import only from the package root.

## Public API (`src/index.ts`)

| Export | What it is |
| --- | --- |
| `schema` | Drizzle `pg-core` tables: `department`, `semester`, `fieldOfStudy`, `admissionPeriod`, `socialEvent`, `publicFile`, `outbox`, `auditLog`, and the enums `semesterTerm`, `outboxStatus`. TS names are camelCase, SQL names snake_case. |
| `UniqueConstraint` | The unique constraint names (`department_city_unique`, `semester_term_year_unique`). |
| `DatabaseLive({ url, maxConnections? })` | `Layer<DepartmentRepository \| AdmissionPeriodRepository \| SemesterRepository \| FieldOfStudyRepository \| SocialEventRepository \| PublicFileRepository \| Outbox \| AuditLog \| OutboxDelivery \| SqlClient, SqlError>`. One pool per build. `PgClient` is not exposed. |
| `transactional(effect)` | Runs the effect in `SqlClient.withTransaction` (a savepoint when nested) and provides `InTransaction`. The only provider of `InTransaction`. A typed failure, a defect or an interruption rolls back every row, including audit and outbox rows. A failing BEGIN/COMMIT is a defect. |
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

## Hyperdrive rules

- `PgClient` runs with `prepare: false` (Hyperdrive pools in transaction mode), `multiplex: false`, and a small `maxConnections`. The settings live in `DatabaseLive`.
- This package uses no advisory locks, no LISTEN/NOTIFY and no session `SET`. Invariants come from constraints, `ON CONFLICT … RETURNING` and row locks.
- Transactions are short and never contain provider I/O. Commands enqueue outbox rows, and delivery happens after commit.
- Turn Hyperdrive query caching off (architecture §4).

## Migrations

`src/schema.ts` is the only source. Never edit `drizzle/` by hand.

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
- Every statement the helper runs as the admin (create, drop, the role's grants) goes through `withClient`: a client with one connection that lives only for that statement. A release must not wait on a client built earlier in its own scope. A pooled client retires a connection it finds idle for 60 to 120 seconds, and it cannot open another one while its scope is closing (Effect 4.0.5: `Pool.get` forks the replacement into the scope, which is already closed during its finalizers). A release after that window never returns. The browser tests in CI took more than two minutes, so the step ended its tests and then never exited. `test/disposableDatabase.postgres.test.ts` moves a `TestClock` five minutes with the database open and checks that the release still drops it (it fails with the old pooled release).
- `readOnlyRole` (`test/support/readOnlyRole.ts`, exported as `@vektorprogrammet/db/testing/read-only-role`) adds a login role on the disposable database that holds `SELECT` and nothing else. Code run through it that succeeds wrote nothing; a write is refused with `permission denied`. `test/readOnlyRole.postgres.test.ts` proves it reads and refuses INSERT, UPDATE, DELETE, TRUNCATE, `ON CONFLICT DO UPDATE`, sequence use, temporary tables and `CREATE`. `apps/web`'s `readsNeverWrite.postgres.test.ts` uses it for spec 0003, falsifier 3. The role is cluster-wide: the layer drops it before it drops the database. Leftovers: `select rolname from pg_roles where rolname like 'vp_read_only_%'`.
- Build the PostgreSQL layer with `excludeTestServices: true`. The pool reads the Clock it was built with to track connection age. When a test moved a shared `TestClock`, the suite hung. Tests that need fixed time nest `it.layer(TestClock.layer())`. At least one cause of that hang is gone: the disposable database's own release (see `withClient` above). The rule stays, because nobody has measured the suites without it.

Each Behavior Contract rule that the database enforces is covered by a test whose name contains the rule id. These rules are RULE-096, 133, 188, 189, 237, 249, 290 and 296.

## Version pin: Drizzle `1.0.0-rc.5-5935859` (registered exception DB-001)

- **Scope:** `drizzle-orm` and `drizzle-kit` are pinned to the preview build `1.0.0-rc.5-5935859` (npm dist-tag `rc5`) in the root catalog.
- **Missing capability:** the published `1.0.0-rc.4` does not load `drizzle-orm/effect-postgres` or `effect-pglite` with effect 4.0.5. It fails with `TypeError: Schema$1.TaggedErrorClass is not a function`, because effect 4.0 GA renamed the API to `Schema.TaggedError`. The rc5 build uses `Schema.TaggedError`.
- **Remaining defect:** the `.d.ts` files in rc5 still import `effect/unstable/sql/SqlError`. That path no longer exists, so Drizzle's `transaction` and `migrate` error types resolve to `any`. This package uses neither in production code. Transactions go through `SqlClient.withTransaction`.
- **Verification:** `bunx vp test` in this package. Both Drizzle drivers load and run against PGlite and PostgreSQL 18.
- **Retirement trigger:** a published Drizzle 1.0.0 that supports effect 4.0 GA. When it ships, move the catalog to it and run this suite.

A related Drizzle behaviour shapes the schema: Drizzle selects `bigint` columns as `::text`. That breaks `id IN (subquery)` in the outbox claim. For this reason the outbox and audit ids are `integer` identities.
