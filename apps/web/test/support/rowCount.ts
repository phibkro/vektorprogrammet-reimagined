import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/** Counts rows in the disposable database's test-observed tables. */
export const rowsIn = Effect.fnUntraced(function* countRows(
  table: "outbox" | "workspace_report" | "captured_mail" | "captured_slack"
) {
  const sql = yield* SqlClient;

  const [row] = yield* sql<{
    readonly n: number;
  }>`select count(*)::int as n from ${sql(table)}`;

  return row?.n ?? -1;
});
