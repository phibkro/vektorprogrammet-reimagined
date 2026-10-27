/**
 * Spec 0007b falsifiers 1 and 6 on the migrated schema: every table and column of the database is declared (as
 * `PersonalData` or `NotPersonal`), both ways, and every foreign key to `person` has a merge rule. The facts come from
 * `information_schema` and `pg_constraint` of a real migrated PostgreSQL, so the check closes over the schema and not
 * over guessed names. The negative controls make the schema change inside a transaction that is rolled back, and show
 * that each way of getting out of step is reported.
 */
import { assert, layer } from "@effect/vitest";
import { Catalog, Forms, catalogProblems } from "@vektorprogrammet/domain";
import type { CatalogOf } from "@vektorprogrammet/domain";
import { Array as Arr, Effect, Record as Rec } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { postgresDatabase } from "./support/database.ts";
import {
  closureProblems,
  readSchemaFacts,
} from "./support/personalDataClosure.ts";

/** The problems that a schema change causes, read inside a transaction that is rolled back afterwards. */
const problemsAfter = (change: Effect.Effect<unknown, never, SqlClient>) =>
  Effect.gen(function* readInRolledBackTransaction() {
    const client = yield* SqlClient;

    return yield* client
      .withTransaction(
        Effect.gen(function* changeAndRead() {
          yield* change;

          return yield* Effect.fail(
            closureProblems(Catalog, yield* readSchemaFacts)
          );
        })
      )
      .pipe(Effect.flip);
  });

/** The catalog without one column of one table: the declaration that a forgetful author would leave out. */
const withoutColumn = (table: string, column: string): CatalogOf =>
  Rec.map(Catalog, (declaration, name) =>
    name === table
      ? { ...declaration, columns: Rec.remove(declaration.columns, column) }
      : declaration
  );

layer(postgresDatabase(), { excludeTestServices: true })(
  "spec 0007b: the catalog is closed over the migrated schema",
  (it) => {
    it.effect(
      "falsifier 1: every table and column of the schema is declared, both ways, and the catalog is consistent",
      () =>
        Effect.gen(function* closed() {
          assert.deepStrictEqual(
            closureProblems(Catalog, yield* readSchemaFacts),
            []
          );

          assert.deepStrictEqual(catalogProblems(Catalog, Forms), []);
        })
    );

    it.effect(
      "falsifier 6: every foreign key to person has a merge rule (and the query that finds them finds them)",
      () =>
        Effect.gen(function* foreignKeys() {
          const { personKeys } = yield* readSchemaFacts;

          const found = Arr.map(
            personKeys,
            ([table, column]) => `${table}.${column}`
          );

          // A query that read nothing would pass the closure for the wrong reason.
          for (const expected of [
            "membership.person_id",
            "admin_grant.person_id",
            "admin_grant.granted_by",
            "account.person_id",
            "consent.person_id",
            "alumni_request.person_id",
            "auth_user.person_id",
            "code.subject",
            "person.merged_into",
          ]) {
            assert.include(found, expected);
          }

          assert.deepStrictEqual(
            Arr.filter(
              closureProblems(Catalog, yield* readSchemaFacts),
              (problem) => problem.includes("foreign key")
            ),
            []
          );
        })
    );

    it.effect(
      "negative control: a column added to a table without a declaration is reported",
      () =>
        Effect.gen(function* addedColumn() {
          const client = yield* SqlClient;

          const problems = yield* problemsAfter(
            client`alter table outbox add column forgotten text`.pipe(
              Effect.orDie
            )
          );

          assert.deepStrictEqual(problems, [
            "column outbox.forgotten is in the schema and is declared as neither PersonalData nor NotPersonal",
          ]);
        })
    );

    it.effect(
      "negative control: a table added with a foreign key to person is reported as undeclared and as without a merge rule",
      () =>
        Effect.gen(function* addedTable() {
          const client = yield* SqlClient;

          const problems = yield* problemsAfter(
            client`create table loose (person_id integer references person (id))`.pipe(
              Effect.orDie
            )
          );

          assert.deepStrictEqual(problems, [
            "table loose is in the schema and has no declaration",
            "loose.person_id is a foreign key to person and has no merge rule",
          ]);
        })
    );

    it.effect(
      "negative control: a column that the declaration lacks, a declared column that is gone, and a merge rule that is missing",
      () =>
        Effect.gen(function* declarationsThatDrift() {
          const facts = yield* readSchemaFacts;

          assert.deepStrictEqual(
            closureProblems(withoutColumn("membership", "leader"), facts),
            [
              "column membership.leader is in the schema and is declared as neither PersonalData nor NotPersonal",
            ]
          );

          assert.deepStrictEqual(
            closureProblems(Catalog, {
              ...facts,
              columns: Arr.filter(
                facts.columns,
                ([table, column]) =>
                  !(table === "membership" && column === "leader")
              ),
            }),
            ["column membership.leader is declared and is not in the schema"]
          );

          const withoutRule = Rec.map(Catalog, (declaration, name) =>
            name === "membership" && declaration.person !== null
              ? {
                  ...declaration,
                  person: { ...declaration.person, references: {} },
                }
              : declaration
          );

          assert.deepStrictEqual(closureProblems(withoutRule, facts), [
            "membership.person_id is a foreign key to person and has no merge rule",
          ]);
        })
    );
  }
);
