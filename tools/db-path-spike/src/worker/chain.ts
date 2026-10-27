import { transactional } from "@vektorprogrammet/db";
import { Clock, Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/** Execute exactly n dependent PostgreSQL round trips in one transaction. */
export const runChain = (n: number) =>
  Effect.gen(function* program() {
    const sql = yield* SqlClient;
    let value = 0;
    let statementsMs = 0;
    const dbStarted = yield* Clock.monotonicTimeNanos;

    const result = yield* transactional(
      Effect.gen(function* transaction() {
        for (let index = 0; index < n; index += 1) {
          const statementStarted = yield* Clock.monotonicTimeNanos;
          const rows = yield* sql`select ${value}::int + 1 as value`;
          const statementFinished = yield* Clock.monotonicTimeNanos;
          statementsMs +=
            Number(statementFinished - statementStarted) / 1_000_000;
          value = Number(rows[0]?.value);
        }

        return value;
      })
    );

    const dbFinished = yield* Clock.monotonicTimeNanos;

    return {
      dbMs: Number(dbFinished - dbStarted) / 1_000_000,
      n,
      statementsMs,
      value: result,
    };
  });
