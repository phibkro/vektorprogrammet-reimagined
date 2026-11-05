/**
 * Value round trips on real PostgreSQL through both Drizzle `effect-postgres`
 * and the raw `SqlClient` (`prepare: false`, as behind Hyperdrive):
 * `timestamptz` (millisecond instants, including a DST change in Europe/Oslo),
 * `date` (calendar days, no zone shift), `jsonb` and `numeric`.
 */
import { assert, layer } from "@effect/vitest";
import { eq } from "drizzle-orm";
import {
  date,
  integer,
  jsonb,
  numeric,
  pgTable,
  timestamp,
} from "drizzle-orm/pg-core";
import { DateTime, Effect, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { Drizzle, postgresDatabase } from "./support/database.ts";

const roundTrip = pgTable("round_trip", {
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  at: timestamp("at", { mode: "date", withTimezone: true }).notNull(),
  day: date("day", { mode: "string" }).notNull(),
  doc: jsonb("doc").notNull(),
  id: integer("id").primaryKey(),
});

/** 2026-03-29 01:00 UTC is when Oslo moves from CET to CEST. */
const instants = [
  DateTime.toDate(DateTime.makeUnsafe("2026-03-29T00:59:59.999Z")),
  DateTime.toDate(DateTime.makeUnsafe("2026-03-29T01:00:00.000Z")),
  DateTime.toDate(DateTime.makeUnsafe("2026-10-25T00:59:59.123Z")),
  DateTime.toDate(DateTime.makeUnsafe("1970-01-01T00:00:00.000Z")),
];

const JsonDocument = Schema.TaggedStruct("Email", {
  nested: Schema.Unknown,
  to: Schema.String,
});

const doc = JsonDocument.make({
  nested: { list: [1, "to", null], æøå: true },
  to: "kontakt@avdeling.example",
});

const jsonDocumentString = Schema.fromJsonString(
  Schema.toCodecJson(JsonDocument)
);

const createTable = Effect.gen(function* createTable() {
  const sql = yield* SqlClient;
  yield* sql`create table if not exists round_trip (
    id integer primary key,
    at timestamptz not null,
    day date not null,
    doc jsonb not null,
    amount numeric(12, 2) not null
  )`;
});

layer(postgresDatabase(), { excludeTestServices: true })(
  "value round trips on PostgreSQL",
  (it) => {
    it.effect(
      "Drizzle writes, Drizzle and SqlClient read: timestamptz, date, jsonb, numeric",
      () =>
        Effect.gen(function* effectProgram() {
          yield* createTable;
          const db = yield* Drizzle;
          const sql = yield* SqlClient;

          for (const [index, at] of instants.entries()) {
            const id = index + 1;
            yield* db
              .insert(roundTrip)
              .values({ amount: "1234.50", at, day: "2026-03-29", doc, id });

            const [row] = yield* db
              .select()
              .from(roundTrip)
              .where(eq(roundTrip.id, id));

            assert.strictEqual(row?.at.toISOString(), at.toISOString());
            assert.strictEqual(row?.day, "2026-03-29");
            assert.deepStrictEqual(row?.doc, doc);
            assert.strictEqual(row?.amount, "1234.50");

            const raw = yield* sql<{
              readonly at: Date;
              readonly day: string;
              readonly doc: unknown;
              readonly amount: unknown;
            }>`select at, day::text as day, doc, amount::text as amount from round_trip where id = ${id}`;

            assert.strictEqual(raw[0]?.at.toISOString(), at.toISOString());
            assert.strictEqual(raw[0]?.day, "2026-03-29");
            assert.deepStrictEqual(raw[0]?.doc, doc);
            assert.strictEqual(raw[0]?.amount, "1234.50");
          }
        })
    );

    it.effect(
      "SqlClient writes, Drizzle reads: the same values come back",
      () =>
        Effect.gen(function* effectProgram() {
          yield* createTable;
          const db = yield* Drizzle;
          const sql = yield* SqlClient;

          const at = DateTime.toDate(
            DateTime.makeUnsafe("2026-03-29T01:00:00.001Z")
          );

          const encodedDocument =
            yield* Schema.encodeEffect(jsonDocumentString)(doc);

          yield* sql`insert into round_trip (id, at, day, doc, amount)
                values (100, ${at}, ${"2026-12-31"}::date, ${encodedDocument}::jsonb, ${"0.10"}::numeric)`;

          const [row] = yield* db
            .select()
            .from(roundTrip)
            .where(eq(roundTrip.id, 100));

          assert.strictEqual(row?.at.toISOString(), at.toISOString());
          assert.strictEqual(row?.day, "2026-12-31");
          assert.deepStrictEqual(row?.doc, doc);
          assert.strictEqual(row?.amount, "0.10");
        })
    );

    it.effect(
      "timestamptz is an instant: the session time zone does not change what is read",
      () =>
        Effect.gen(function* effectProgram() {
          yield* createTable;
          const sql = yield* SqlClient;

          // Inside one transaction only (`set local`), so no session state leaks into the pool.
          const rows = yield* sql.withTransaction(
            Effect.gen(function* rows() {
              yield* sql`set local time zone 'Pacific/Auckland'`;

              return yield* sql<{
                readonly at: Date;
              }>`select ${"2026-03-29 03:00:00+02"}::timestamptz as at`;
            })
          );

          assert.strictEqual(
            rows[0]?.at.toISOString(),
            "2026-03-29T01:00:00.000Z"
          );
        })
    );
  }
);
