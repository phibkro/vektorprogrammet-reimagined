/**
 * What the catalog's tables hold, as a count and a hash each (spec 0007b): two snapshots are equal when nothing in any
 * of the tables changed. A test that says "a second call changes nothing" or "a refused command changes nothing" reads
 * this, so that it cannot pass by looking at one table only.
 */
import { Catalog } from "@vektorprogrammet/domain";
import { Array as Arr, Effect, Number as Num, Record as Rec } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

export const snapshot = Effect.gen(function* snapshot() {
  const sql = yield* SqlClient;

  const tables = yield* Effect.forEach(Rec.keys(Catalog), (table) =>
    sql
      .unsafe<{ h: string; n: number }>(
        `select count(*)::int as n, md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as h from "${table}" as t`
      )
      .pipe(Effect.map(([row]) => [table, `${row?.n}:${row?.h}`] as const))
  );

  return Rec.fromEntries(tables);
});

/**
 * How many rows of each table hold one of `values`, written anywhere in the row: the scan of falsifier 4. A table that
 * the scan finds nothing in is left out.
 */
export const scan = Effect.fnUntraced(function* scan(
  values: readonly string[]
) {
  const sql = yield* SqlClient;

  const found = yield* Effect.forEach(Rec.keys(Catalog), (table) =>
    Effect.forEach(values, (value) =>
      sql
        .unsafe<{ n: number }>(
          `select count(*)::int as n from "${table}" as t where strpos(t::text, $1) > 0`,
          [value]
        )
        .pipe(Effect.map(([row]) => row?.n ?? 0))
    ).pipe(Effect.map((counts) => [table, Num.sumAll(counts)] as const))
  );

  return Rec.fromEntries(Arr.filter(found, ([, n]) => n > 0));
});
