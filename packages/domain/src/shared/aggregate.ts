/**
 * Aggregate locks (spec 0006b): the contract that commands and repositories share, so that a race is avoided by how
 * a command is written and not by a test that happens to catch it.
 *
 * An aggregate root is an entity whose row is the unit that concurrent writes queue on. A person is one: every row that
 * is about one person alone (memberships, admin places, and from spec 0007 the account and its codes) is written only
 * by a transaction that holds that person's lock. A command takes the lock first, reads the facts it decides on
 * through the token (a repository method that takes `Locked` runs after the lock), and writes through the token. Two
 * commands on one person then queue instead of interleaving, and a decision is never made on a fact that another
 * transaction could change before the write.
 *
 * `packages/db` declares which tables each root owns, implements `AggregateLocks` with `SELECT … FOR NO KEY UPDATE`,
 * and is the only place that makes a token. This module declares only what the domain needs: the roots in their
 * global lock order, the token, and the service that takes the lock.
 *
 * The order is a rule. A transaction that locks several rows takes them in ascending order (all of one root at once, in
 * ascending id order, with `lockAll`; the roots in the order below), so two transactions cannot wait for each other in
 * a cycle. A command therefore locks everything it needs before its first decision read.
 */
import { Context } from "effect";
import type { Effect } from "effect";

import type { NotFound } from "./errors.ts";
import type { EntityName } from "./ids.ts";
import type { InTransaction } from "./transaction.ts";

/** The entities that are aggregate roots, in the order that a transaction locks different roots. */
export const AggregateRoots = [
  "Person",
] as const satisfies readonly EntityName[];

export type AggregateRoot = (typeof AggregateRoots)[number];

declare const lockedBrand: unique symbol;

/**
 * Proof that the running transaction holds the lock of one row of a root. Only `packages/db` makes one (the brand is
 * not exported, so an object made by hand does not type-check), and a repository checks it against the locks that the
 * transaction holds each time it is used: a token from another transaction, or from a savepoint that was rolled back,
 * never reads or writes. A token of one root does not stand for another.
 */
export interface Locked<Root extends EntityName = AggregateRoot> {
  readonly [lockedBrand]: Root;
  readonly id: number;
  readonly root: Root;
}

export class AggregateLocks extends Context.Service<
  AggregateLocks,
  {
    /**
     * `SELECT … FOR NO KEY UPDATE` on the row, and its token. Locking a row that this transaction already holds
     * returns the token without a statement. `NotFound` when the root has no such row.
     */
    readonly lock: <Root extends AggregateRoot>(
      root: Root,
      id: number
    ) => Effect.Effect<Locked<Root>, NotFound, InTransaction>;
    /**
     * The rows of one root in ascending id order, in one statement, and a token for each (in that order). A command
     * that needs several rows asks for all of them here, before its first decision read.
     */
    readonly lockAll: <Root extends AggregateRoot>(
      root: Root,
      ids: readonly number[]
    ) => Effect.Effect<readonly Locked<Root>[], NotFound, InTransaction>;
  }
>()("@vektorprogrammet/domain/shared/AggregateLocks") {}
