import { assert, it } from "@effect/vitest";
import { Cause, Config, Effect, Exit, Option, Redacted, Schema } from "effect";

import { provisionRuntimeAccess } from "../../src/adapters/db/runtimeAccess.ts";
import {
  migratedTestDatabase,
  TestDatabaseUrl,
  withClient,
} from "./support/disposableDatabase.ts";
import { runtimeRoleCredentials } from "./support/runtimeRole.ts";

const hasCode = (code: string) =>
  Schema.is(Schema.Struct({ code: Schema.Literal(code) }));

it.live(
  "runtime role can transact but cannot administer schema, roles or Auth",
  () =>
    Effect.gen(function* runtimeRoleTest() {
      const clusterAdmin = yield* Config.Redacted("TEST_DATABASE_ADMIN_URL");

      const { role, password } = yield* runtimeRoleCredentials;
      const browserRole = `vektor_browser_${role.slice("vektor_runtime_".length)}`;
      yield* Effect.acquireRelease(
        withClient(clusterAdmin, (sql) =>
          sql.unsafe(
            `create role "${browserRole}" login password '${password}' noinherit`
          )
        ),
        () =>
          withClient(clusterAdmin, (sql) =>
            sql.unsafe(`drop role if exists "${browserRole}"`)
          ).pipe(Effect.orDie)
      );
      yield* Effect.acquireRelease(Effect.void, () =>
        withClient(clusterAdmin, (sql) =>
          sql.unsafe(`drop role if exists "${role}"`)
        ).pipe(Effect.orDie)
      );
      yield* Effect.gen(function* testDatabase() {
        const admin = yield* TestDatabaseUrl;
        yield* withClient(
          admin,
          (sql) => sql`grant create on schema public to public`
        );

        const ambientSchema = yield* Effect.exit(
          provisionRuntimeAccess(admin, password, role)
        );

        assert.isTrue(Exit.isFailure(ambientSchema));
        yield* withClient(
          admin,
          (sql) => sql`revoke create on schema public from public`
        );
        yield* withClient(
          admin,
          (sql) =>
            sql`do $$ begin execute format('grant create on database %I to public', current_database()); end $$`
        );

        const ambientDatabase = yield* Effect.exit(
          provisionRuntimeAccess(admin, password, role)
        );

        assert.isTrue(Exit.isFailure(ambientDatabase));
        yield* withClient(
          admin,
          (sql) =>
            sql`do $$ begin execute format('revoke create on database %I from public', current_database()); end $$`
        );
        yield* provisionRuntimeAccess(admin, password, role);
        // Re-provisioning must remove stale write grants from an existing runtime role.
        yield* withClient(admin, (sql) =>
          sql.unsafe(
            `grant update, delete on public.impact_snapshot to "${role}"`
          )
        );
        yield* provisionRuntimeAccess(admin, password, role);
        const url = new URL(Redacted.value(admin));
        url.username = role;
        url.password = password;
        const runtime = Redacted.make(url.toString());
        yield* withClient(runtime, (sql) =>
          sql.withTransaction(
            Effect.gen(function* transact() {
              yield* sql`insert into site_content (id, collection, slug, draft) values (gen_random_uuid(), 'texts', 'runtime-role-test', '{}'::jsonb)`;

              const rows =
                yield* sql`select id from site_content where slug = 'runtime-role-test'`;

              assert.lengthOf(rows, 1);
              yield* sql`delete from site_content where slug = 'runtime-role-test'`;
            })
          )
        );
        yield* withClient(
          runtime,
          (sql) =>
            sql`insert into impact_snapshot (closed_at, coverage, definition_hash, measure, semester_term, semester_year, source, value) values (now(), 'complete', 'acl-test', 'assistantsPlaced', 'VAR', 2099, 'reimagined', 7)`
        );

        const adminRoles = yield* withClient(
          admin,
          (sql) =>
            sql<{
              readonly quoted: string;
            }>`select quote_ident(current_user) as quoted`
        );

        const adminRole = adminRoles[0]?.quoted ?? "";
        assert.notStrictEqual(adminRole, "");

        for (const statement of [
          "create temporary table runtime_forbidden (id int)",
          "create schema runtime_forbidden",
          "alter table public.site_content add column runtime_forbidden text",
          "truncate public.site_content",
          "create role runtime_forbidden",
          `set role ${adminRole}`,
          `grant ${adminRole} to "${role}"`,
          "delete from auth.users",
          "select * from auth.users",
          "delete from vektor_private.users",
          "create table vektor_private.runtime_forbidden (id int)",
          "update impact_snapshot set value = 8 where definition_hash = 'acl-test'",
          "delete from impact_snapshot where definition_hash = 'acl-test'",
        ]) {
          const result = yield* Effect.exit(
            withClient(runtime, (sql) => sql.unsafe(statement))
          );

          const failure = Exit.isFailure(result)
            ? Cause.findErrorOption(result.cause)
            : Option.none();

          assert.isTrue(
            Option.exists(failure, (error) =>
              hasCode("42501")(error.reason.cause)
            )
          );
        }

        const snapshot = yield* withClient(
          runtime,
          (sql) =>
            sql`select value from impact_snapshot where definition_hash = 'acl-test'`
        );

        assert.deepStrictEqual(snapshot, [{ value: 7 }]);

        const secret = yield* Effect.exit(
          withClient(
            runtime,
            (sql) => sql`select encrypted_password from vektor_private.users`
          )
        );

        const missing = Exit.isFailure(secret)
          ? Cause.findErrorOption(secret.cause)
          : Option.none();

        assert.isTrue(
          Option.exists(missing, (error) =>
            hasCode("42703")(error.reason.cause)
          )
        );

        yield* withClient(admin, (sql) =>
          sql.unsafe(`grant usage on schema public to "${browserRole}"`)
        );
        yield* withClient(admin, (sql) =>
          sql.unsafe(
            `grant select, insert on public.site_content to "${browserRole}"`
          )
        );
        yield* withClient(
          admin,
          (sql) =>
            sql`insert into site_content (id, collection, slug, draft) values (gen_random_uuid(), 'texts', 'browser-boundary', '{}'::jsonb)`
        );
        const browserUrl = new URL(Redacted.value(admin));
        browserUrl.username = browserRole;
        browserUrl.password = password;
        const browserConnection = Redacted.make(browserUrl.toString());

        const visible = yield* withClient(
          browserConnection,
          (sql) => sql`select id from public.site_content`
        );

        assert.deepStrictEqual(visible, []);

        const browser = yield* Effect.exit(
          withClient(
            browserConnection,
            (sql) =>
              sql`insert into site_content (id, collection, slug, draft) values (gen_random_uuid(), 'texts', 'browser-write', '{}'::jsonb)`
          )
        );

        const denial = Exit.isFailure(browser)
          ? Cause.findErrorOption(browser.cause)
          : Option.none();

        assert.isTrue(
          Option.exists(denial, (error) => hasCode("42501")(error.reason.cause))
        );

        yield* provisionRuntimeAccess(admin, password, role);
        yield* Effect.gen(function* rejectSchemaCreate() {
          for (const schema of ["public", "vektor_private"]) {
            yield* withClient(admin, (sql) =>
              sql.unsafe(`grant create on schema ${schema} to "${role}"`)
            );

            const rejected = yield* Effect.exit(
              provisionRuntimeAccess(admin, password, role)
            );

            assert.isTrue(Exit.isFailure(rejected));
            yield* withClient(admin, (sql) =>
              sql.unsafe(`revoke create on schema ${schema} from "${role}"`)
            );
          }
        });
        yield* withClient(admin, (sql) =>
          sql.unsafe(
            `do $$ begin execute format('grant create on database %I to %I', current_database(), '${role}'); end $$`
          )
        );

        const rejectedDatabase = yield* Effect.exit(
          provisionRuntimeAccess(admin, password, role)
        );

        assert.isTrue(Exit.isFailure(rejectedDatabase));
      }).pipe(Effect.provide(migratedTestDatabase), Effect.scoped);
    }).pipe(Effect.orDie)
);
