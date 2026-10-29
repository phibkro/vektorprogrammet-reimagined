/**
 * The closure of the ownership declaration over a schema (spec 0006b, contract 5): what is wrong with the way a
 * schema's tables refer to the aggregate roots, compared with `Ownership` and `NotOwned`. It reads the foreign keys that
 * Drizzle holds for each table, so a table added to `schema.ts` with a foreign key to `person` appears here the moment
 * it exists. An empty list is a closed declaration.
 */
import { getTableColumns, is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import { Array as Arr, Option, Record as Rec, String as Str } from "effect";

import type { RootOwnership } from "../../src/aggregate/ownership.ts";
import type * as Schema from "../../src/schema.ts";

/** The tables of a schema, by the names that the declaration uses. */
export type SchemaTables = readonly (readonly [string, PgTable])[];

/** The tables among the exports of a schema module (or of a module that extends it). */
export const tablesOf = (schema: typeof Schema): SchemaTables =>
  Arr.flatMap(
    Rec.toEntries(schema),
    ([name, value]: readonly [string, unknown]) =>
      is(value, PgTable) ? [[name, value] as const] : []
  );

const foreignTables = (table: PgTable): readonly PgTable[] =>
  Arr.map(
    getTableConfig(table).foreignKeys,
    (key) => key.reference().foreignTable
  );

/** Whether `column` (a property of `table`) is a foreign key to the key of `target`. */
const referencesAsOwner = (
  table: PgTable,
  column: string,
  target: PgTable
): boolean =>
  Option.exists(Rec.get(getTableColumns(table), column), (owner) =>
    Arr.some(
      getTableConfig(table).foreignKeys,
      (key) =>
        key.reference().foreignTable === target &&
        Arr.some(key.reference().columns, (found) => found === owner)
    )
  );

const ownerProblems = (
  root: RootOwnership,
  rootTable: PgTable,
  tables: SchemaTables
): readonly string[] =>
  Arr.flatMap(Rec.toEntries(root.owns), ([name, owned]) =>
    Option.match(
      Arr.findFirst(tables, ([found]) => found === name),
      {
        onNone: () => [`${root.name} owns \`${name}\`, which the schema lacks`],
        onSome: ([, table]) =>
          referencesAsOwner(table, owned.owner, rootTable)
            ? []
            : [
                `${root.name} owns \`${name}\` by \`${owned.owner}\`, which is not a foreign key to ${root.table}`,
              ],
      }
    )
  );

const rootProblems = (
  root: RootOwnership,
  notOwned: Readonly<Record<string, string>>,
  tables: SchemaTables
): readonly string[] =>
  Option.match(
    Arr.findFirst(tables, ([name]) => name === root.table),
    {
      onNone: () => [`root ${root.name}: the schema lacks \`${root.table}\``],
      onSome: ([, rootTable]) => [
        ...Arr.flatMap(tables, ([name, table]) =>
          name !== root.table &&
          Arr.contains(foreignTables(table), rootTable) &&
          !Rec.has(root.owns, name) &&
          !Rec.has(notOwned, name)
            ? [
                `\`${name}\` refers to ${root.table} and is neither owned by ${root.name} nor declared NotOwned`,
              ]
            : []
        ),
        ...ownerProblems(root, rootTable, tables),
      ],
    }
  );

/** `NotOwned` entries that name no table that refers to a root, or a table that a root owns, or that give no reason. */
const notOwnedProblems = (
  ownership: readonly RootOwnership[],
  notOwned: Readonly<Record<string, string>>,
  tables: SchemaTables
): readonly string[] => {
  const rootTables = Arr.flatMap(ownership, (root) =>
    Arr.flatMap(tables, ([name, table]) => (name === root.table ? [table] : []))
  );

  return Arr.flatMap(Rec.toEntries(notOwned), ([name, reason]) => {
    const found = Arr.findFirst(tables, ([entry]) => entry === name);

    return [
      ...(Str.trim(reason) === ""
        ? [`NotOwned \`${name}\` gives no reason`]
        : []),
      ...(Arr.some(ownership, (root) => Rec.has(root.owns, name))
        ? [`\`${name}\` is both owned and NotOwned`]
        : []),
      ...(Option.exists(found, ([, table]) =>
        Arr.some(rootTables, (root) => Arr.contains(foreignTables(table), root))
      )
        ? []
        : [`NotOwned \`${name}\` is no table that refers to a root`]),
    ];
  });
};

export const closureProblems = (input: {
  readonly notOwned: Readonly<Record<string, string>>;
  readonly ownership: readonly RootOwnership[];
  readonly tables: SchemaTables;
}): readonly string[] => [
  ...Arr.flatMap(input.ownership, (root) =>
    rootProblems(root, input.notOwned, input.tables)
  ),
  ...notOwnedProblems(input.ownership, input.notOwned, input.tables),
];
