import { inspect } from "node:util";

import { PgClient } from "@effect/sql-pg";
/**
 * Spec 0017 (review round 2): a failed `SignInDirectory` lookup is a defect that names the operation and carries
 * nothing the failed statement did. Drizzle's `EffectDrizzleQueryError` holds the SQL and, when the driver is told to
 * report them (`paramsInErrors`, off in `makeWithDefaults`), its parameters, which for `match` are the address that a
 * visitor typed. A defect is logged and rendered, so the adapter does not pass the original error on.
 */
import { assert, layer } from "@effect/vitest";
import { PersonId, SignInDirectory } from "@vektorprogrammet/domain";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import {
  Array as Arr,
  Cause,
  Context,
  Effect,
  Exit,
  Layer,
  Logger,
} from "effect";
import type { Redacted } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { Drizzle } from "../src/internal/drizzle.ts";
import { SignInDirectoryLive } from "../src/repositories/signIn.ts";
import { postgresDatabase } from "./support/database.ts";
import { TestDatabaseUrl } from "./support/disposableDatabase.ts";

/** `SignInDirectoryLive` over a Drizzle that puts the statement's parameters in its errors, on its own small pool. */
const reporting = (url: Redacted.Redacted) =>
  SignInDirectoryLive.pipe(
    Layer.provide(
      Layer.effect(
        Drizzle,
        PgDrizzle.makeWithDefaults({ paramsInErrors: true })
      )
    ),
    Layer.provide(PgClient.layer({ maxConnections: 1, prepare: false, url }))
  );

const TYPED = "typed.by.a.visitor@example.org";

/** Renames a column for the rest of the scope, so that every statement that names it fails. */
const withoutColumn = (table: string, column: string) =>
  Effect.gen(function* dropColumn() {
    const sql = yield* SqlClient;

    yield* Effect.acquireRelease(
      sql.unsafe(
        `alter table ${table} rename column ${column} to ${column}_gone`
      ),
      () =>
        sql
          .unsafe(
            `alter table ${table} rename column ${column}_gone to ${column}`
          )
          .pipe(Effect.orDie)
    );
  });

layer(postgresDatabase(), { excludeTestServices: true })(
  "spec 0017: a failed sign-in lookup carries only its operation",
  (it) => {
    it.effect(
      "each of the four lookups dies with its operation's name, and its rendering and its Effect log hold no SQL and no parameter",
      () =>
        Effect.gen(function* lookupsFail() {
          yield* withoutColumn("person", "company_email");
          yield* withoutColumn("person", "name");
          yield* withoutColumn("auth_user", "person_id");

          // The driver is told to report parameters (probe: the error then renders `params: <the typed address>`), so
          // what the test finds is the adapter's doing and not the driver's default.
          const directory = Context.get(
            yield* Layer.build(reporting(yield* TestDatabaseUrl)),
            SignInDirectory
          );

          const personId = PersonId.make(424_242);

          const lookups: readonly (readonly [
            string,
            Effect.Effect<unknown>,
          ])[] = [
            ["match", directory.match(TYPED)],
            ["personOfUser", directory.personOfUser(TYPED)],
            ["signInEmailOf", directory.signInEmailOf(personId)],
            ["profileOf", directory.profileOf(personId)],
          ];

          const logged: unknown[] = [];

          const capture = Logger.make((options) =>
            logged.push(options.message)
          );

          for (const [operation, lookup] of lookups) {
            const exit = yield* Effect.exit(lookup);

            assert.isTrue(Exit.isFailure(exit));

            if (Exit.isFailure(exit)) {
              const defect = Cause.squash(exit.cause);

              // The only thing that the failure says is the class of the failure.
              assert.strictEqual(defect, `SignInDirectory.${operation} failed`);

              // What the application writes for a defect: the rendered cause, through the Effect logger.
              yield* Effect.logError(Cause.pretty(exit.cause)).pipe(
                Effect.provide(Logger.layer([capture]))
              );
            }
          }

          assert.lengthOf(logged, 4);

          const text = Arr.join(
            Arr.map(logged, (message) => inspect(message, { depth: 12 })),
            "\n"
          );

          assert.notInclude(text, TYPED);
          assert.notInclude(text, "424242");
          assert.notInclude(text, "select ");
          assert.notInclude(text, "Failed query");
        })
    );
  }
);
