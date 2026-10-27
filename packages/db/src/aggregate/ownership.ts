/**
 * Who owns which table (spec 0006b): the one declaration that the lock construct (`aggregates.ts`), the closure test
 * (`test/ownership.test.ts`) and the lint rule `vektor-anti-slop/no-owned-table-write` all read.
 *
 * It is plain data with no runtime import, so the lint plugin can read it without loading the schema and the domain.
 * Names are the property names of `schema.ts` (`membership`, `adminGrant`), as the code spells them. The domain
 * declares which entities are aggregate roots and in which order they are locked (`AggregateRoots`); this file says
 * which tables each root owns.
 *
 * - A table is owned when every row of it belongs to one row of the root (the foreign key `owner`). Every write to an
 *   owned table takes the owner's lock (`Locked<Root>`), so the writes of one owner never run at the same time.
 * - A table that refers to a root's table and that no root owns is declared in `NotOwned`, with the reason.
 * - `state` names the column that a stored state machine owns; a row is created in a state, and afterwards only
 *   `Aggregates.apply` changes it.
 */
import type { AggregateRoot } from "@vektorprogrammet/domain";

export interface OwnedTable {
  /** The property that holds the owner's id: a foreign key to the key of the root's table. */
  readonly owner: string;
  /** The property that holds the state of a stored machine, when the table has one. */
  readonly state?: string;
}

export interface RootOwnership {
  readonly name: AggregateRoot;
  /** The root's table (a `schema.ts` export); its `id` column is the key a lock is taken on. */
  readonly table: string;
  readonly owns: Readonly<Record<string, OwnedTable>>;
}

/** The tables of each root. A person owns the rows that are about that person alone. */
export const Ownership = [
  {
    name: "Person",
    owns: {
      account: { owner: "personId", state: "state" },
      adminGrant: { owner: "personId" },
      code: { owner: "subject" },
      membership: { owner: "personId" },
    },
    table: "person",
  },
] as const satisfies readonly RootOwnership[];

/** Tables that refer to a root's table, are owned by no root, and why that is safe. */
export const NotOwned = {
  authUser:
    "Better Auth's table. The library writes it through its own connection, outside every domain transaction, and a command never writes it: it enqueues an outbox message that the delivery performs after commit (spec 0007).",
  endingSoonDigest:
    "A claim ledger: its only write is INSERT … ON CONFLICT DO NOTHING on its own primary key (person, term, year), which the unique index orders, and nothing is decided from the person's other rows. A person lock would only queue the digest behind unrelated writes.",
} as const satisfies Readonly<Record<string, string>>;
