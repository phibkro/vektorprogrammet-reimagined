/**
 * The typed side of the ownership declaration (spec 0006b): roots and the tables they own. `declare` turns the plain
 * data of `ownership.ts` and the schema's tables into these values, so the declaration has one source and the types
 * follow from it. The token that proves a lock, `Locked`, is the domain's: only this package makes one.
 *
 * A write to an owned table names the table's `Owned` handle and the `Locked` token of its owner; the two must be of
 * the same root, so a token of another root does not type-check. The owner column is never a value of a write: the
 * writer fills it from the token, so a write cannot reach another owner's row.
 */
import { AggregateRoots } from "@vektorprogrammet/domain";
import type { AggregateRoot } from "@vektorprogrammet/domain";
import { getTableColumns } from "drizzle-orm";
import type { InferInsertModel } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { Array as Arr, Option, Record as Rec } from "effect";
import { cast } from "effect/Function";

import { OwnershipDeclarationError } from "./defects.ts";
import type { OwnedTable, RootOwnership } from "./ownership.ts";

/** An aggregate root: the table whose row a lock is taken on. */
export interface Root<
  Name extends AggregateRoot = AggregateRoot,
  Table extends PgTable = PgTable,
> {
  readonly key: PgColumn;
  readonly name: Name;
  /** The position of the root in the global lock order. */
  readonly rank: number;
  readonly table: Table;
}

/** A table that a root owns, with the column that names the owner and the column of a stored machine's state. */
export interface Owned<
  Name extends AggregateRoot = AggregateRoot,
  Table extends PgTable = PgTable,
  Owner extends string = string,
  StateKey extends string = never,
> {
  readonly owner: PgColumn;
  readonly ownerKey: Owner;
  readonly root: Root<Name>;
  readonly state: [StateKey] extends [never] ? undefined : PgColumn;
  readonly stateKey: [StateKey] extends [never] ? undefined : StateKey;
  readonly table: Table;
}

/** An owned table that has a stored machine: its handle has the state column, and only such a handle can be applied. */
export type StatefulOwned<
  Name extends AggregateRoot,
  Table extends PgTable,
  Owner extends string,
  StateKey extends string,
> = Owned<Name, Table, Owner, StateKey> & {
  readonly state: PgColumn;
  readonly stateKey: StateKey;
};

/** The values of an insert: the table's, without the owner (the token gives it). */
export type InsertValues<Table extends PgTable, Owner extends string> = Omit<
  InferInsertModel<Table>,
  Owner
>;

/** The columns an update may set: the same set without a machine's state, each optional. */
export type SetValues<
  Table extends PgTable,
  Owner extends string,
  StateKey extends string,
> = Partial<Omit<InferInsertModel<Table>, Owner | StateKey>>;

type TableOf<Tables, Key extends string> = Key extends keyof Tables
  ? Tables[Key] extends PgTable
    ? Tables[Key]
    : never
  : never;

type StateKeyOf<Table extends OwnedTable> = Table extends {
  readonly state: infer StateKey extends string;
}
  ? StateKey
  : never;

type HandleOf<
  Name extends AggregateRoot,
  Table extends PgTable,
  Entry extends OwnedTable,
> = Entry["owner"] extends keyof Table & string
  ? Owned<Name, Table, Entry["owner"], StateKeyOf<Entry>>
  : never;

type OwnedHandles<Entry extends RootOwnership, Tables> = {
  readonly [Key in keyof Entry["owns"] & string]: HandleOf<
    Entry["name"],
    TableOf<Tables, Key>,
    Entry["owns"][Key]
  >;
};

/** A declared root, with the handles of the tables it owns by their schema names. */
type DeclaredRoot<Entry extends RootOwnership, Tables> = Root<
  Entry["name"],
  TableOf<Tables, Entry["table"]>
> & { readonly owned: OwnedHandles<Entry, Tables> };

export type Declared<Roots extends readonly RootOwnership[], Tables> = {
  readonly [Entry in Roots[number] as Entry["name"]]: DeclaredRoot<
    Entry,
    Tables
  >;
};

/** The schema names that a declaration needs as tables: every root and every table it owns. */
type NeededTables<Roots extends readonly RootOwnership[]> =
  Roots[number] extends infer Entry extends RootOwnership
    ? Entry extends RootOwnership
      ? Entry["table"] | (keyof Entry["owns"] & string)
      : never
    : never;

const missing = (what: string, name: string) => () =>
  new OwnershipDeclarationError({
    message: `The ownership declaration names ${what} \`${name}\`, which the schema does not have.`,
  });

const columnOf = (table: PgTable, key: string): PgColumn =>
  Option.getOrThrowWith(
    Rec.get(getTableColumns(table), key),
    missing("a column", key)
  );

/**
 * The typed roots and handles of an ownership declaration over the tables of a schema. The rank of a root is its place
 * in the domain's `AggregateRoots`; `tables` has every table that the declaration names (a schema module does).
 */
export const declare = <
  const Roots extends readonly RootOwnership[],
  const Tables extends Readonly<Record<NeededTables<Roots>, PgTable>>,
>(
  ownership: Roots,
  tables: Tables
): Declared<Roots, Tables> => {
  const tableNamed = (name: string): PgTable =>
    Option.getOrThrowWith(
      Rec.get<string, PgTable>(tables, name),
      missing("the table", name)
    );

  const declaredRoots = Arr.map(ownership, (entry) => {
    const table = tableNamed(entry.table);

    const root: Root = {
      key: columnOf(table, "id"),
      name: entry.name,
      rank: Option.getOrElse(
        Arr.findFirstIndex(AggregateRoots, (name) => name === entry.name),
        () => AggregateRoots.length
      ),
      table,
    };

    const owned = Rec.map(entry.owns, (declared, key) => {
      const ownedTable = tableNamed(key);

      return {
        owner: columnOf(ownedTable, declared.owner),
        ownerKey: declared.owner,
        root,
        state:
          declared.state === undefined
            ? undefined
            : columnOf(ownedTable, declared.state),
        stateKey: declared.state,
        table: ownedTable,
      };
    });

    return [entry.name, { ...root, owned }] as const;
  });

  // SAFETY: each entry is the root of `Declared` that its name selects, built from the same declaration (EX-0025).
  return cast(Rec.fromEntries(declaredRoots));
};
