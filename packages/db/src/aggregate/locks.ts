/**
 * Taking the lock of an aggregate root (spec 0006b, contracts 1 and 2): the implementation of the domain's
 * `AggregateLocks`, and the check that a token is used only while this transaction holds its lock.
 *
 * `SELECT … FOR NO KEY UPDATE` is the strongest row lock that no foreign-key check conflicts with, so a write that
 * only refers to the person (a membership, an admin place) never waits for the lock, and writes of the person's own
 * rows do. It is a row lock, not an advisory lock: it lives and dies with the transaction (Hyperdrive).
 */
import { AggregateLocks, NotFound } from "@vektorprogrammet/domain";
import type { AggregateRoot, Locked } from "@vektorprogrammet/domain";
import { asc, inArray, sql } from "drizzle-orm";
import { Array as Arr, Effect, Layer, Option, Order, Ref } from "effect";
import { cast } from "effect/Function";

import { Drizzle } from "../internal/drizzle.ts";
import { LockNotHeld, LockOrderViolation } from "./defects.ts";
import {
  CurrentLockScope,
  heldIn,
  isHeld,
  orderViolation,
} from "./lockScope.ts";
import type { Held } from "./lockScope.ts";
import type { Root } from "./model.ts";

/** The roots that the schema declares, by name: the domain's `AggregateRoots`, each with its table. */
export type DeclaredRoots = {
  readonly [Name in AggregateRoot]: Root<Name>;
};

/** The scope of the transaction that is running, and every lock it holds; outside `transactional` there is none. */
const transactionLocks = Effect.gen(function* transactionLocks() {
  const current = yield* CurrentLockScope;

  if (Option.isNone(current)) {
    return yield* Effect.die(
      new LockNotHeld({
        message: "A lock or a write of an aggregate ran outside transactional.",
      })
    );
  }

  return { held: yield* heldIn(current), scope: current.value };
});

const mint = <Name extends AggregateRoot>(
  name: Name,
  id: number
): Locked<Name> =>
  // SAFETY: the token's brand exists only in its type. This is the one place that makes a token, and its callers have
  // just locked the row or found it held (EX-0023).
  cast({ id, root: name });

/** A token is used only while this transaction holds its lock, and only for the root that it is a token of. */
export const assertHeld = Effect.fnUntraced(function* assertHeld(
  root: Root,
  tokens: readonly Locked[]
) {
  const { held } = yield* transactionLocks;

  const stale = Arr.findFirst(
    tokens,
    (token) =>
      token.root !== root.name ||
      !isHeld(held, { id: token.id, rank: root.rank })
  );

  return yield* Option.match(stale, {
    onNone: () => Effect.void,
    onSome: (token) =>
      Effect.die(
        new LockNotHeld({
          message: `${root.name} ${token.id} is not locked by this transaction.`,
        })
      ),
  });
});

const makeLocks = (db: Drizzle["Service"], roots: DeclaredRoots) => {
  const lockAll = Effect.fn("AggregateLocks.lockAll")(function* lockAll<
    Name extends AggregateRoot,
  >(name: Name, ids: readonly number[]) {
    const root: Root = roots[name];
    const { held, scope } = yield* transactionLocks;
    const wanted = Arr.sort(Arr.dedupe(ids), Order.Number);

    const fresh = Arr.filter(
      wanted,
      (id) => !isHeld(held, { id, rank: root.rank })
    );

    const [first] = fresh;

    if (first !== undefined) {
      const violation = orderViolation(held, { id: first, rank: root.rank });

      if (Option.isSome(violation)) {
        return yield* Effect.die(
          new LockOrderViolation({
            message: `Lock of ${name} ${first} would come after a held lock (root ${violation.value.rank}, row ${violation.value.id}). Lock every row that a command needs in one lockAll, in the global order.`,
          })
        );
      }

      const rows = yield* db
        .select({ id: sql<number>`${root.key}` })
        .from(root.table)
        .where(inArray(root.key, fresh))
        .orderBy(asc(root.key))
        .for("no key update")
        .pipe(Effect.orDie);

      const found: readonly Held[] = Arr.map(rows, (row) => ({
        id: row.id,
        rank: root.rank,
      }));

      yield* Ref.update(scope.held, Arr.appendAll(found));

      const missing = Arr.findFirst(
        fresh,
        (id) => !isHeld(found, { id, rank: root.rank })
      );

      if (Option.isSome(missing)) {
        return yield* new NotFound({
          entity: name,
          key: String(missing.value),
        });
      }
    }

    return Arr.map(wanted, (id) => mint(name, id));
  });

  const lock = Effect.fn("AggregateLocks.lock")(function* lock<
    Name extends AggregateRoot,
  >(name: Name, id: number) {
    const [locked] = yield* lockAll(name, [id]);

    return locked ?? (yield* Effect.die("lockAll returned no token"));
  });

  return AggregateLocks.of({ lock, lockAll });
};

/** The domain's `AggregateLocks` over the roots that the schema declares. */
export const aggregateLocksLayer = (roots: DeclaredRoots) =>
  Layer.effect(
    AggregateLocks,
    Effect.map(Drizzle, (db) => makeLocks(db, roots))
  );
