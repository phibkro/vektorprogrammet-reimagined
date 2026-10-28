/**
 * Spec 0018, falsifier 4: the isolation floor of `InTransaction` is a statement, not the default of the server. On a
 * database whose role defaults to SERIALIZABLE, every new session starts its transactions there; a program under
 * `transactional` (and under the domain's `Transactor`, which is the same runner) still reads `read committed`, in a
 * top-level scope and in a nested one (a savepoint keeps its parent's level).
 *
 * Control: the same read through a plain `SqlClient.withTransaction` reads `serializable`, so the setting is in force
 * and the test would see a transaction that left the level alone. Each case runs on a client of its own, built after
 * the setting, because a setting applies to the sessions that start after it.
 */
import { assert, layer } from "@effect/vitest";
import { Transactor } from "@vektorprogrammet/domain";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { TransactorLive, transactional } from "../src/transactional.ts";
import { postgresDatabase } from "./support/database.ts";
import {
  serializableByDefault,
  withClient,
} from "./support/disposableDatabase.ts";
import { level } from "./support/isolationLevel.ts";

layer(postgresDatabase({ maxConnections: 2 }), { excludeTestServices: true })(
  "the isolation floor on PostgreSQL (spec 0018)",
  (it) => {
    it.effect(
      "falsifier 4: under a role that defaults to SERIALIZABLE, transactional still begins at read committed, and a nested level keeps it",
      () =>
        Effect.gen(function* beginsAtReadCommitted() {
          const url = yield* serializableByDefault;

          const seen = yield* withClient(url, (client) =>
            Effect.gen(function* inEachScope() {
              const outside = yield* level;
              const top = yield* transactional(level);
              const nested = yield* transactional(transactional(level));

              return { nested, outside, top };
            }).pipe(Effect.provideService(SqlClient, client))
          );

          assert.deepStrictEqual(seen, {
            nested: "read committed",
            // Outside a transaction a statement is its own transaction, at the role's default.
            outside: "serializable",
            top: "read committed",
          });
        })
    );

    it.effect(
      "falsifier 4: the domain's Transactor begins at read committed too",
      () =>
        Effect.gen(function* transactorBeginsAtReadCommitted() {
          const url = yield* serializableByDefault;

          const seen = yield* withClient(url, (client) =>
            Transactor.use((transactor) => transactor.run(level)).pipe(
              Effect.provide(
                TransactorLive.pipe(
                  Layer.provide(Layer.succeed(SqlClient)(client))
                )
              )
            )
          );

          assert.strictEqual(seen, "read committed");
        })
    );

    it.effect(
      "falsifier 4, control: the same read through a plain withTransaction is at the role's default, serializable",
      () =>
        Effect.gen(function* plainTransactionKeepsTheDefault() {
          const url = yield* serializableByDefault;

          const seen = yield* withClient(url, (client) =>
            client.withTransaction(level)
          );

          assert.strictEqual(seen, "serializable");
        })
    );
  }
);
