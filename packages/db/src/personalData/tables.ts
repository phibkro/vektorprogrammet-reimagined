/**
 * The schema's tables by their SQL names, which is how the catalog names them (spec 0007b), and the handles of the ones
 * that the Person root owns. The engine writes a table that a person owns only through `Aggregates` and a token; this
 * is how it finds out which that is.
 */
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { Array as Arr, Effect, Option, Record as Rec } from "effect";

import { roots } from "../aggregate/declaration.ts";
import * as schema from "../schema.ts";

/** Every table of the schema, by its SQL name. */
const tableNamed: Readonly<Record<string, PgTable>> = Rec.fromEntries(
  Arr.flatMap(Rec.toEntries(schema), ([, value]: readonly [string, unknown]) =>
    is(value, PgTable) ? [[getTableName(value), value] as const] : []
  )
);

/** The table of a catalog name. A name that the schema lacks is a defect: the closing test keeps the two in step. */
export const tableOf = (name: string): Effect.Effect<PgTable> =>
  Option.match(Rec.get(tableNamed, name), {
    onNone: () =>
      Effect.die(`The catalog names a table that the schema lacks: ${name}`),
    onSome: Effect.succeed,
  });

/** The handle of the table when the Person root owns it. */
export const ownedBy = (table: string) =>
  Arr.findFirst(
    Rec.values(roots.Person.owned),
    (handle) => getTableName(handle.table) === table
  );

/** The property that holds a SQL column of a table: Drizzle's `set` is keyed by properties, the catalog by SQL names. */
export const propertyOf = (table: PgTable, column: string): string =>
  Option.match(
    Arr.findFirst(
      Rec.toEntries(getTableColumns(table)),
      ([, found]) => found.name === column
    ),
    {
      onNone: () => column,
      onSome: ([property]) => property,
    }
  );
