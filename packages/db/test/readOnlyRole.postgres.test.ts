/**
 * The SELECT-only role (`readOnlyRole`, spec 0003 falsifier 3) is the instrument that proves "this code
 * wrote nothing". It must read, and it must refuse every kind of write, or a pass proves nothing.
 */
import { PgClient } from "@effect/sql-pg";
import { assert, layer } from "@effect/vitest";
import { Cause, Effect, Exit, Layer } from "effect";
import type { Redacted } from "effect";
import { SqlClient } from "effect/sql";

import {
  migratedTestDatabase,
  TestDatabaseUrl,
} from "./support/disposableDatabase.ts";
import { ReadOnlyDatabaseUrl, readOnlyRole } from "./support/readOnlyRole.ts";

const clientOf = (url: Redacted.Redacted) =>
  PgClient.layer({ maxConnections: 1, prepare: false, url });

/** A client as the SELECT-only role, and one as the owner (its own small pools, released with the test). */
const readerClient = Layer.unwrap(
  Effect.map(Effect.service(ReadOnlyDatabaseUrl), clientOf)
);

const ownerClient = Layer.unwrap(
  Effect.map(Effect.service(TestDatabaseUrl), clientOf)
);

const WRITES = [
  ["insert", `insert into semester (term, year) values ('VAR', 2099)`],
  ["update", `update semester set year = 2098 where false`],
  ["delete", `delete from semester where false`],
  ["truncate", `truncate semester`],
  [
    "insert … on conflict do update (the retired ensure)",
    `insert into semester (term, year) values ('VAR', 2099)
       on conflict (term, year) do update set term = excluded.term`,
  ],
  ["sequence use", `select nextval(pg_get_serial_sequence('semester', 'id'))`],
  ["temporary table", `create temporary table scratch (x integer)`],
  ["create table", `create table scratch (x integer)`],
] as const;

layer(readOnlyRole.pipe(Layer.provideMerge(migratedTestDatabase)), {
  excludeTestServices: true,
})("the SELECT-only role of the disposable database", (it) => {
  it.effect("reads every table", () =>
    Effect.gen(function* readsEffect() {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql.unsafe(`select count(*)::int as n from semester`);

      assert.deepStrictEqual(rows, [{ n: 0 }]);
    }).pipe(Effect.provide(readerClient))
  );

  for (const [kind, statement] of WRITES) {
    it.effect(`refuses a write: ${kind}`, () =>
      Effect.gen(function* refusesEffect() {
        const sql = yield* SqlClient.SqlClient;
        const exit = yield* Effect.exit(sql.unsafe(statement));

        assert.isTrue(Exit.isFailure(exit));

        if (Exit.isFailure(exit)) {
          assert.include(Cause.pretty(exit.cause), "permission denied");
        }
      }).pipe(Effect.provide(readerClient))
    );
  }

  it.effect(
    "negative control: the owner role performs the same insert, so the refusals come from the role",
    () =>
      Effect.gen(function* ownerWritesEffect() {
        const sql = yield* SqlClient.SqlClient;

        yield* sql.unsafe(
          `insert into semester (term, year) values ('VAR', 2099)`
        );

        const rows = yield* sql.unsafe(
          `select count(*)::int as n from semester`
        );

        assert.deepStrictEqual(rows, [{ n: 1 }]);
      }).pipe(Effect.provide(ownerClient))
  );
});
