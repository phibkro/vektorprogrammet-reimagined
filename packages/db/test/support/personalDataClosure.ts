/**
 * The closure of the personal data catalog over the migrated schema (spec 0007b, falsifiers 1 and 6): what is wrong
 * with the way the tables and columns of the database meet the declarations. The facts are read from
 * `information_schema` and `pg_constraint` of a migrated database, so a table or a column that a migration adds appears
 * here the moment it exists, with no list of names to keep. An empty list is a closed catalog.
 */
import { personReferences } from "@vektorprogrammet/domain";
import type { CatalogOf } from "@vektorprogrammet/domain";
import { Array as Arr, Effect, Record as Rec } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/** What the database says: its tables with their columns, and the columns that are foreign keys to `person`. */
export interface SchemaFacts {
  /** `[table, column]` of every column of every base table in schema `public`. */
  readonly columns: readonly (readonly [string, string])[];
  /** `[table, column]` of every foreign key to `person`. */
  readonly personKeys: readonly (readonly [string, string])[];
}

/**
 * Reads the facts through the connection's `SqlClient`, so that a statement inside a transaction sees the transaction's
 * own changes. Views are not tables: a view derives from tables that are declared.
 */
export const readSchemaFacts = Effect.gen(function* readSchemaFacts() {
  const client = yield* SqlClient;

  const columns = yield* client<{ column_name: string; table_name: string }>`
    select c.table_name, c.column_name
    from information_schema.columns as c
    join information_schema.tables as t
      on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
    order by c.table_name, c.column_name`;

  const personKeys = yield* client<{ column_name: string; table_name: string }>`
    select k.conrelid::regclass::text as table_name, a.attname as column_name
    from pg_constraint as k
    join pg_attribute as a on a.attrelid = k.conrelid and a.attnum = any (k.conkey)
    where k.contype = 'f' and k.confrelid = 'public.person'::regclass
    order by 1, 2`;

  return {
    columns: Arr.map(
      columns,
      (row) => [row.table_name, row.column_name] as const
    ),
    personKeys: Arr.map(
      personKeys,
      (row) => [row.table_name, row.column_name] as const
    ),
  } satisfies SchemaFacts;
});

/** The tables, and for each its columns, in the order that the facts list them. */
const tablesOf = (
  facts: SchemaFacts
): Readonly<Record<string, readonly string[]>> =>
  Rec.map(
    Arr.groupBy(facts.columns, ([table]) => table),
    (rows) => Arr.map(rows, ([, column]) => column)
  );

export const closureProblems = (
  catalog: CatalogOf,
  facts: SchemaFacts
): readonly string[] => {
  const tables = tablesOf(facts);

  const references = Arr.map(
    personReferences(catalog),
    ({ column, table }) => `${table}.${column}`
  );

  return [
    ...Arr.flatMap(Rec.toEntries(tables), ([table, columns]) => {
      const declared = catalog[table];

      return declared === undefined
        ? [`table ${table} is in the schema and has no declaration`]
        : Arr.flatMap(columns, (column) =>
            Rec.has(declared.columns, column)
              ? []
              : [
                  `column ${table}.${column} is in the schema and is declared as neither PersonalData nor NotPersonal`,
                ]
          );
    }),
    ...Arr.flatMap(Rec.toEntries(catalog), ([table, declaration]) => {
      const columns = tables[table];

      return columns === undefined
        ? [`table ${table} is declared and is not in the schema`]
        : Arr.flatMap(Rec.keys(declaration.columns), (column) =>
            Arr.contains(columns, column)
              ? []
              : [
                  `column ${table}.${column} is declared and is not in the schema`,
                ]
          );
    }),
    ...Arr.flatMap(facts.personKeys, ([table, column]) =>
      Arr.contains(references, `${table}.${column}`)
        ? []
        : [
            `${table}.${column} is a foreign key to person and has no merge rule`,
          ]
    ),
  ];
};
