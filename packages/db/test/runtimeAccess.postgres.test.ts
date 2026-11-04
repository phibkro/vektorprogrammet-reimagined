import { assert, it } from "@effect/vitest";
import {
  Array as Arr,
  Cause,
  Config,
  Effect,
  Exit,
  Option,
  Random,
  Redacted,
  Schema,
} from "effect";

import { provisionRuntimeAccess } from "../src/runtimeAccess.ts";
import {
  migratedTestDatabase,
  TestDatabaseUrl,
  withClient,
} from "./support/disposableDatabase.ts";

const hasCode = (code: string) =>
  Schema.is(Schema.Struct({ code: Schema.Literal(code) }));

it.live(
  "runtime role can transact but cannot administer schema, roles or Auth",
  () =>
    Effect.gen(function* runtimeRoleTest() {
      const clusterAdmin = yield* Config.Redacted("TEST_DATABASE_ADMIN_URL");

      const words = yield* Effect.forEach(Arr.range(0, 7), () =>
        Random.nextIntBetween(0, 2 ** 31)
      );

      const encoded = Arr.map(words, (word) =>
        word.toString(16).padStart(8, "0")
      );

      const role = `vektor_runtime_${Arr.join(encoded, "").slice(0, 32)}`;
      const password = Arr.join(encoded, "");
      yield* Effect.acquireRelease(Effect.void, () =>
        withClient(clusterAdmin, (sql) =>
          sql.unsafe(`drop role if exists "${role}"`)
        ).pipe(Effect.orDie)
      );
      yield* Effect.gen(function* testDatabase() {
        const admin = yield* TestDatabaseUrl;
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

        for (const statement of [
          "create temporary table runtime_forbidden (id int)",
          "create schema runtime_forbidden",
          "alter table public.site_content add column runtime_forbidden text",
          "truncate public.site_content",
          "create role runtime_forbidden",
          "set role postgres",
          `grant postgres to "${role}"`,
          "delete from auth.users",
          "select * from auth.users",
          "delete from vektor_private.users",
          "create table vektor_private.runtime_forbidden (id int)",
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

        const browser = yield* Effect.exit(
          withClient(admin, (sql) =>
            sql.withTransaction(
              Effect.gen(function* browserRead() {
                yield* sql`set local role anon`;
                yield* sql`select * from public.site_content`;
              })
            )
          )
        );

        const denial = Exit.isFailure(browser)
          ? Cause.findErrorOption(browser.cause)
          : Option.none();

        assert.isTrue(
          Option.exists(denial, (error) => hasCode("42501")(error.reason.cause))
        );
      }).pipe(Effect.provide(migratedTestDatabase), Effect.scoped);
    }).pipe(Effect.orDie)
);
