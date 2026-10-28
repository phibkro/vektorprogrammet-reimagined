/**
 * Spec 0018, falsifier 4, on the second engine: PGlite takes the explicit `BEGIN ISOLATION LEVEL READ COMMITTED` that
 * `transactional` sends. Its one connection is set to default to SERIALIZABLE, as a role setting would; the control is a
 * plain `SqlClient.withTransaction`, which stays there.
 */
import { assert, layer } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { transactional } from "../src/transactional.ts";
import { pgliteDatabase } from "./support/database.ts";
import { level } from "./support/isolationLevel.ts";

layer(pgliteDatabase)("the isolation floor on PGlite (spec 0018)", (it) => {
  it.effect(
    "falsifier 4: under a default of SERIALIZABLE, transactional begins at read committed and a nested level keeps it; a plain transaction does not",
    () =>
      Effect.gen(function* beginsAtReadCommitted() {
        const sql = yield* SqlClient;
        yield* sql`set default_transaction_isolation = 'serializable'`;

        const seen = {
          nested: yield* transactional(transactional(level)),
          plain: yield* sql.withTransaction(level),
          top: yield* transactional(level),
        };

        assert.deepStrictEqual(seen, {
          nested: "read committed",
          plain: "serializable",
          top: "read committed",
        });
      })
  );
});
