import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/** The isolation level of the transaction this program runs in, as PostgreSQL names it (`read committed`). */
export const level = Effect.gen(function* level() {
  const sql = yield* SqlClient;

  const rows = yield* sql<{ readonly level: string }>`
    select current_setting('transaction_isolation') as level`;

  return rows[0]?.level;
});

/** The isolation level that a statement outside a transaction runs at: the session's `default_transaction_isolation`. */
export const roleDefault = Effect.gen(function* roleDefault() {
  const sql = yield* SqlClient;

  const rows = yield* sql<{ readonly level: string }>`
    select current_setting('default_transaction_isolation') as level`;

  return rows[0]?.level;
});
