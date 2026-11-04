import { assert, layer } from "@effect/vitest";
import { Cause, Context, Effect, Exit, Layer, Option, Schema } from "effect";
import type { Redacted } from "effect";

import {
  migratedTestDatabase,
  TestDatabaseUrl,
  withClient,
} from "./support/disposableDatabase.ts";
import { restrictedRole } from "./support/restrictedRole.ts";

const insufficientPrivilege = Schema.is(
  Schema.Struct({ code: Schema.Literal("42501") })
);

class BrowserDatabaseUrl extends Context.Service<
  BrowserDatabaseUrl,
  Redacted.Redacted
>()("test/BrowserDatabaseUrl") {}

// Mirror the broad object grants of Supabase's Data API roles, without owner/BYPASSRLS authority.
const browserRole = Layer.effect(
  BrowserDatabaseUrl,
  restrictedRole("vp_browser_", (role) => [
    `grant all on all tables in schema public to "${role}"`,
    `grant usage on all sequences in schema public to "${role}"`,
  ])
);

layer(browserRole.pipe(Layer.provideMerge(migratedTestDatabase)), {
  excludeTestServices: true,
})("the browser Data API boundary", (it) => {
  it.effect("denies domain reads and inserts despite broad object grants", () =>
    Effect.gen(function* browserCannotBypassDomain() {
      const owner = yield* TestDatabaseUrl;
      const browser = yield* BrowserDatabaseUrl;

      const unprotected = yield* withClient(
        owner,
        (sql) =>
          sql`select tablename from pg_tables where schemaname = 'public' and not rowsecurity order by tablename`
      );

      assert.deepStrictEqual(unprotected, []);

      yield* withClient(
        owner,
        (sql) => sql`insert into semester (term, year) values ('VAR', 2099)`
      );

      const visible = yield* withClient(
        browser,
        (sql) => sql`select term::text, year from semester`
      );

      assert.deepStrictEqual(visible, []);

      const insert = yield* withClient(
        browser,
        (sql) => sql`insert into semester (term, year) values ('HOST', 2099)`
      ).pipe(Effect.exit);

      const failure = Exit.isFailure(insert)
        ? Cause.findErrorOption(insert.cause)
        : Option.none();

      assert.isTrue(
        Option.exists(failure, (error) =>
          insufficientPrivilege(error.reason.cause)
        )
      );

      // Negative control: without RLS, the same valid statement and broad grants expose the rows.
      yield* withClient(
        owner,
        (sql) => sql`alter table semester disable row level security`
      );
      yield* Effect.gen(function* unprotectedControl() {
        yield* withClient(
          browser,
          (sql) => sql`insert into semester (term, year) values ('HOST', 2099)`
        );

        const exposed = yield* withClient(
          browser,
          (sql) =>
            sql`select term::text, year from semester order by term::text`
        );

        assert.deepStrictEqual(exposed, [
          { term: "HOST", year: 2099 },
          { term: "VAR", year: 2099 },
        ]);
      }).pipe(
        Effect.ensuring(
          withClient(
            owner,
            (sql) => sql`alter table semester enable row level security`
          ).pipe(Effect.orDie)
        )
      );
    })
  );
});
