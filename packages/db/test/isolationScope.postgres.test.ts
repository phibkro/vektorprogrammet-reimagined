/**
 * Spec 0018 R9 (review round 1, finding 2): what the isolation floor covers, and what it leaves to the role.
 *
 * - The legacy importer's one transaction begins at READ COMMITTED like every `transactional` one: under a role that
 *   defaults to SERIALIZABLE, a statement inside `ImportTarget.replaceAll` still reads `read committed`. The probe is a
 *   trigger on the truncate that `replaceAll` runs, which records the level of the transaction it runs in.
 *   Control: the same truncate in a plain `withTransaction` records `serializable`, so the trigger and the setting work.
 * - A statement outside a transaction (the Standalone and Joins methods) runs at the role's default, and a contended
 *   claim fails with a serialization failure under SERIALIZABLE. So the role's default is itself asserted: the test
 *   server's is READ COMMITTED, and the Preview check asserts it of the deployed role (`IsolationProbe`).
 *   Control: after the database is set to default to SERIALIZABLE, the same read says so.
 */
import type { PgClient } from "@effect/sql-pg";
import { assert, layer } from "@effect/vitest";
import { ImportTarget } from "@vektorprogrammet/domain";
import type { TargetRows } from "@vektorprogrammet/domain";
import { Array as Arr, Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { ImportDatabaseLive } from "../src/index.ts";
import {
  TestDatabaseUrl,
  migratedTestDatabase,
  serializableByDefault,
  withClient,
} from "./support/disposableDatabase.ts";
import { roleDefault } from "./support/isolationLevel.ts";

const noRows: TargetRows = {
  admission_period: [],
  department: [],
  field_of_study: [],
  public_file: [],
  semester: [],
  social_event: [],
};

/** Records the level of the transaction that truncates `department`, which `replaceAll` does first. */
const logTruncates = (client: PgClient.PgClient) =>
  Effect.gen(function* logTruncatesOfDepartment() {
    yield* client.unsafe(`create table isolation_log (level text not null)`);

    yield* client.unsafe(
      `create function log_isolation() returns trigger language plpgsql as $$ begin insert into isolation_log values (current_setting('transaction_isolation')); return null; end $$`
    );

    yield* client.unsafe(
      `create trigger log_isolation before truncate on department for each statement execute function log_isolation()`
    );
  });

const logged = (client: PgClient.PgClient) =>
  Effect.map(
    client<{ readonly level: string }>`select level from isolation_log`,
    (rows) => Arr.map(rows, ({ level }) => level)
  );

layer(migratedTestDatabase, { excludeTestServices: true })(
  "what the isolation floor covers (spec 0018 R9)",
  (it) => {
    it.effect(
      "the test server's role default is read committed, and a database set to SERIALIZABLE says so (control)",
      () =>
        Effect.gen(function* roleDefaultIsReadCommitted() {
          const url = yield* TestDatabaseUrl;

          const readDefault = withClient(url, (client) =>
            roleDefault.pipe(Effect.provideService(SqlClient, client))
          );

          assert.strictEqual(yield* readDefault, "read committed");

          yield* serializableByDefault;

          assert.strictEqual(yield* readDefault, "serializable");
        })
    );

    it.effect(
      "the importer's transaction begins at read committed under a role that defaults to SERIALIZABLE; a plain transaction does not (control)",
      () =>
        Effect.gen(function* importerBeginsAtReadCommitted() {
          const url = yield* serializableByDefault;
          yield* withClient(url, logTruncates);

          yield* ImportTarget.use((target) => target.replaceAll(noRows)).pipe(
            Effect.provide(ImportDatabaseLive({ url })),
            Effect.orDie
          );

          assert.deepStrictEqual(yield* withClient(url, logged), [
            "read committed",
          ]);

          yield* withClient(url, (client) =>
            client.withTransaction(
              client.unsafe(`truncate table department cascade`)
            )
          );

          assert.deepStrictEqual(yield* withClient(url, logged), [
            "read committed",
            "serializable",
          ]);
        })
    );
  }
);
