/**
 * The aggregate writer (spec 0006b, contracts 1, 3 and 4). Every write to a table that a root owns goes through this
 * module; `vektor-anti-slop/no-owned-table-write` rejects a Drizzle `insert`, `update` or `delete` of an owned table
 * anywhere else. The lock itself is `AggregateLocks` (`locks.ts`).
 *
 * - `insert`, `update` and `remove` need the owner's token. The writer fills the owner column from the token and adds
 *   `owner = token.id` to every `WHERE`, so a write cannot reach a row of another owner. The state column of a stored
 *   machine is not a value of an update.
 * - `select` is the decision read: it returns the rows of the locked owners, which nobody else can change until this
 *   transaction ends. A read for display stays unlocked and does not come here.
 * - `apply` is the only writer of a machine's state: `UPDATE … SET state = to WHERE owner = $1 AND state = ANY(from)`.
 *
 * A token is checked against the locks that the transaction holds each time it is used, so a token from another
 * transaction, or from a savepoint that was rolled back, never reads or writes.
 */
import { Conflict, Machine as Declared } from "@vektorprogrammet/domain";
import type { AggregateRoot, Locked } from "@vektorprogrammet/domain";
import { and, eq, getTableName, inArray } from "drizzle-orm";
import type { InferInsertModel, InferSelectModel, SQL } from "drizzle-orm";
import type * as PgDrizzle from "drizzle-orm/effect-postgres";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { Array as Arr, Context, Effect, Layer, Struct } from "effect";
import { cast } from "effect/Function";

import { Drizzle } from "../internal/drizzle.ts";
import { ProtectedColumn, TransitionNotApplicable } from "./defects.ts";
import { assertHeld } from "./locks.ts";
import type {
  InsertValues,
  Owned,
  Root,
  SetValues,
  StatefulOwned,
} from "./model.ts";

/** What a failed statement carries; a repository maps it with `classifySqlFailure` or makes it a defect. */
export type QueryFailure = PgDrizzle.EffectPgQueryEffectHKT["error"];

/** One token, or the tokens of several owners (the result of `lockAll`). */
type Locks<Name extends AggregateRoot> = Locked<Name> | readonly Locked<Name>[];

/** The rows that a statement returns. */
type Rows<Table extends PgTable> = readonly InferSelectModel<Table>[];

type Statement<Table extends PgTable> = Effect.Effect<
  Rows<Table>,
  QueryFailure
>;

/** Any handle of an owned table. Each write is generic over the handle it is given, so the token, the table and the values agree. */
type AnyOwned = Owned | Owned<AggregateRoot, PgTable, string, string>;

type RootNameOf<O extends AnyOwned> = O["root"]["name"];

/** The state column's name when the handle has one, otherwise nothing. */
type StateOf<O extends AnyOwned> = O["stateKey"] extends string
  ? O["stateKey"]
  : never;

/** The row of a stored machine that a transition changes, and what a refusal says. */
export interface MachineRow<
  Name extends AggregateRoot,
  Table extends PgTable,
  Owner extends string,
  StateKey extends string,
> {
  readonly entity: Conflict["entity"];
  readonly key: string;
  /** User-facing text of the `Conflict`. */
  readonly message: string;
  readonly owned: StatefulOwned<Name, Table, Owner, StateKey>;
  /** Narrows the owner's rows to one, for a table that has several rows per owner. */
  readonly where?: SQL | undefined;
}

/** What an insert does when the row is already there: nothing, or set the given columns of the row that is. */
export type OnConflict<
  Table extends PgTable,
  Owner extends string,
  StateKey extends string,
> =
  | { readonly action: "ignore" }
  | {
      readonly action: "replace";
      readonly set: SetValues<Table, Owner, StateKey>;
      /** The unique columns that collide. */
      readonly target: readonly PgColumn[];
    };

/** A statement's rows, as the select model of the table of the handle (an owned table or a root) that it ran on. */
const asRows = <Holder extends { readonly table: PgTable }>(
  _holder: Holder,
  statement: Effect.Effect<unknown, QueryFailure>
): Statement<Holder["table"]> =>
  // SAFETY: every statement here selects or returns all the columns of the holder's table, so each row is its select
  // model (EX-0023).
  Effect.map(statement, (rows) => cast(rows));

/** The columns of an owned table that no caller sets: the owner's, which the token gives, and a machine's state. */
const protectedKeysOf = (owned: AnyOwned): readonly string[] =>
  owned.stateKey === undefined
    ? [owned.ownerKey]
    : [owned.ownerKey, owned.stateKey];

/**
 * A set that names a protected column is a defect. The types leave these columns out of a set, but a value that is
 * not a fresh object literal can still carry them, and a write that moved a row to another owner, or changed a
 * state, would reach past the lock that the caller holds.
 */
const refuseProtected = (
  table: PgTable,
  protectedKeys: readonly string[],
  given: readonly string[]
): Effect.Effect<void> => {
  const named = Arr.filter(protectedKeys, (key) => Arr.contains(given, key));

  return Arr.isReadonlyArrayNonEmpty(named)
    ? Effect.die(
        new ProtectedColumn({
          message: `${getTableName(table)}: ${Arr.join(named, ", ")} is written by the construct. The owner's column is the token's, and a machine's state changes only through apply.`,
        })
      )
    : Effect.void;
};

export class Aggregates extends Context.Service<
  Aggregates,
  {
    /**
     * Fails (as a defect) unless this transaction holds the lock of each token. A decision read of the root's own row
     * (a repository method that takes `Locked`) calls it, so that a stale token never reads.
     */
    readonly assertHeld: <Name extends AggregateRoot>(
      root: Root<Name>,
      locks: Locks<NoInfer<Name>>
    ) => Effect.Effect<void>;
    /** The decision read: the rows of the locked owners, optionally narrowed by `where`. */
    readonly select: <O extends AnyOwned>(
      locks: Locks<NoInfer<RootNameOf<O>>>,
      owned: O,
      where?: SQL
    ) => Statement<O["table"]>;
    /**
     * Inserts a row for the owner. `onConflict` says what a row that is already there means: `ignore` writes nothing
     * (the result is empty), `replace` sets the given columns of the row that is there (`target` names the unique
     * columns that collide).
     */
    readonly insert: <O extends AnyOwned>(
      locked: Locked<NoInfer<RootNameOf<O>>>,
      owned: O,
      values: InsertValues<O["table"], O["ownerKey"]>,
      onConflict?: OnConflict<O["table"], O["ownerKey"], StateOf<O>>
    ) => Statement<O["table"]>;
    /** Sets `set` on the root's own row (the person's name, e-mail address, …) and returns it. */
    readonly updateRoot: <Name extends AggregateRoot, Table extends PgTable>(
      locked: Locked<NoInfer<Name>>,
      root: Root<Name, Table>,
      set: Partial<Omit<InferInsertModel<Table>, "id">>
    ) => Statement<Table>;
    /** Sets `set` on the owner's rows that `where` selects, and returns them. */
    readonly update: <O extends AnyOwned>(
      locked: Locked<NoInfer<RootNameOf<O>>>,
      owned: O,
      change: {
        readonly set: SetValues<O["table"], O["ownerKey"], StateOf<O>>;
        readonly where?: SQL | undefined;
      }
    ) => Statement<O["table"]>;
    /** Deletes the owner's rows that `where` selects, and returns them. */
    readonly remove: <O extends AnyOwned>(
      locked: Locked<NoInfer<RootNameOf<O>>>,
      owned: O,
      where?: SQL
    ) => Statement<O["table"]>;
    /**
     * Applies one transition of a machine to the owner's row: `UPDATE … SET state = to WHERE owner = $1 AND state =
     * ANY(from)`. A row that is not in a state the transition starts from (any more) is a `Conflict`, and nothing is
     * written. The caller decided with `Machine.can`; this makes the decision atomic. (`Machine.apply` in the spec.)
     */
    readonly apply: <
      Name extends AggregateRoot,
      Table extends PgTable,
      Owner extends string,
      StateKey extends string,
      State extends string,
      Command extends string,
      Context,
    >(
      transition: Declared.Transition<State, Command, Context>,
      locked: Locked<NoInfer<Name>>,
      row: MachineRow<Name, Table, Owner, StateKey>
    ) => Effect.Effect<InferSelectModel<Table>, Conflict | QueryFailure>;
  }
>()("@vektorprogrammet/db/Aggregates") {
  static readonly layer = Layer.effect(
    Aggregates,
    Effect.gen(function* aggregatesLayer() {
      const db = yield* Drizzle;

      return Aggregates.of({
        apply: Effect.fn("Aggregates.apply")(
          function* apply(transition, locked, row) {
            const { owned } = row;
            yield* assertHeld(owned.root, [locked]);

            const from = Arr.filter(
              transition.from,
              (state) => state !== Declared.Boundary
            );

            if (
              transition.to === Declared.Boundary ||
              Arr.isReadonlyArrayEmpty(from)
            ) {
              return yield* Effect.die(
                new TransitionNotApplicable({
                  message: `The transition of ${row.entity} ${row.key} to ${transition.to} creates or removes a row, or starts from no state.`,
                })
              );
            }

            const table: PgTable = owned.table;
            const state: PgColumn = owned.state;

            const [first] = yield* asRows(
              owned,
              db
                .update(table)
                .set({ [owned.stateKey]: transition.to })
                .where(
                  and(
                    eq(owned.owner, locked.id),
                    inArray(state, from),
                    row.where
                  )
                )
                .returning()
            );

            return (
              first ??
              (yield* new Conflict({
                entity: row.entity,
                key: row.key,
                message: row.message,
              }))
            );
          }
        ),
        assertHeld: (root, locks) => assertHeld(root, Arr.ensure(locks)),
        insert: Effect.fn("Aggregates.insert")(
          function* insert(locked, owned, values, onConflict) {
            yield* assertHeld(owned.root, [locked]);
            const table: PgTable = owned.table;

            const insertion = db
              .insert(table)
              .values({ ...values, [owned.ownerKey]: locked.id });

            if (onConflict?.action === "ignore") {
              return yield* asRows(
                owned,
                insertion.onConflictDoNothing().returning()
              );
            }

            if (onConflict?.action === "replace") {
              yield* refuseProtected(
                owned.table,
                protectedKeysOf(owned),
                Struct.keys(onConflict.set)
              );

              return yield* asRows(
                owned,
                insertion
                  .onConflictDoUpdate({
                    set: { ...onConflict.set },
                    target: [...onConflict.target],
                  })
                  .returning()
              );
            }

            return yield* asRows(owned, insertion.returning());
          }
        ),
        remove: Effect.fn("Aggregates.remove")(
          function* remove(locked, owned, where) {
            yield* assertHeld(owned.root, [locked]);
            const table: PgTable = owned.table;

            return yield* asRows(
              owned,
              db
                .delete(table)
                .where(and(eq(owned.owner, locked.id), where))
                .returning()
            );
          }
        ),
        select: Effect.fn("Aggregates.select")(
          function* select(locks, owned, where) {
            const held = Arr.ensure(locks);
            yield* assertHeld(owned.root, held);
            const table: PgTable = owned.table;

            return yield* asRows(
              owned,
              db
                .select()
                .from(table)
                .where(
                  and(
                    inArray(
                      owned.owner,
                      Arr.map(held, (token) => token.id)
                    ),
                    where
                  )
                )
            );
          }
        ),
        update: Effect.fn("Aggregates.update")(
          function* update(locked, owned, change) {
            yield* assertHeld(owned.root, [locked]);

            yield* refuseProtected(
              owned.table,
              protectedKeysOf(owned),
              Struct.keys(change.set)
            );

            const table: PgTable = owned.table;

            return yield* asRows(
              owned,
              db
                .update(table)
                .set({ ...change.set })
                .where(and(eq(owned.owner, locked.id), change.where))
                .returning()
            );
          }
        ),
        updateRoot: Effect.fn("Aggregates.updateRoot")(
          function* updateRoot(locked, root, set) {
            yield* assertHeld(root, [locked]);
            yield* refuseProtected(root.table, ["id"], Struct.keys(set));
            const table: PgTable = root.table;

            return yield* asRows(
              root,
              db
                .update(table)
                .set({ ...set })
                .where(eq(root.key, locked.id))
                .returning()
            );
          }
        ),
      });
    })
  );
}
