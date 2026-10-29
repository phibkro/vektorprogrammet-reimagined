import { NodeServices } from "@effect/platform-node";
import { assert, layer } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Layer, String as Str } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { transactional } from "../src/index.ts";
import { postgresDatabase } from "./support/database.ts";

const live = Layer.merge(postgresDatabase(), NodeServices.layer);

const migration = new URL(
  "../drizzle/20261027204231_backfill_company_addresses/migration.sql",
  import.meta.url
).pathname;

layer(live, { excludeTestServices: true })(
  "the company-address backfill",
  (it) => {
    it.effect(
      "a legacy cross-table collision fails and rolls back; distinct addresses backfill both owners",
      () =>
        Effect.gen(function* backfillCollision() {
          const sql = yield* SqlClient;

          const file = yield* (yield* FileSystem.FileSystem).readFileString(
            migration
          );

          const statements = Str.split(file, "--> statement-breakpoint");

          const insertAndBackfill = (groupAddress: string) =>
            transactional(
              Effect.gen(function* oldRows() {
                const [department] = yield* sql<{
                  readonly id: number;
                }>`insert into department (name, short_name, city, email) values ('Migration', 'MIG', 'Migrationby', 'migration@example.org') returning id`;

                const [field] = yield* sql<{
                  readonly id: number;
                }>`insert into field_of_study (department_id, name, short_name) values (${department?.id ?? 0}, 'Migrationfag', 'MF') returning id`;

                yield* sql`insert into person ${sql.insert({ company_email: "same@vektorprogrammet.no", email: "fixture@example.org", field_of_study_id: field?.id ?? 0, name: "Fixture Person" })}`;
                yield* sql`insert into team (department_id, name, function, default_term, group_email) values (${department?.id ?? 0}, 'Migrationteam', 'other', 1, ${groupAddress})`;
                yield* Effect.forEach(
                  statements,
                  (statement) => sql.unsafe(statement),
                  { discard: true }
                );
              })
            );

          const collision = yield* Effect.exit(
            insertAndBackfill("same@vektorprogrammet.no")
          );

          assert.isTrue(Exit.isFailure(collision));

          if (Exit.isFailure(collision)) {
            assert.include(
              Cause.pretty(collision.cause),
              "company_address_pkey"
            );
          }

          const [afterRollback] = yield* sql<{
            readonly n: number;
          }>`select count(*)::int as n from company_address`;

          assert.strictEqual(afterRollback?.n, 0);
          yield* insertAndBackfill("team@vektorprogrammet.no");

          const [complete] = yield* sql<{
            readonly people: number;
            readonly teams: number;
          }>`select count(person_id)::int as people, count(team_id)::int as teams from company_address`;

          assert.deepStrictEqual(complete, { people: 1, teams: 1 });
        })
    );
  }
);
