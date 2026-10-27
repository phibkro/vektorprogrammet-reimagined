/**
 * The locks that a transaction holds (spec 0006b, contract 2). `transactional` opens one scope per transaction level
 * (the transaction, and each nested `transactional`, which is a savepoint) and provides it as `CurrentLockScope`.
 *
 * - A second lock of a row that the transaction already holds returns the held token and sends no statement.
 * - A level that fails is dropped: PostgreSQL releases the row locks that a rolled-back savepoint took, so the scope
 *   forgets them. A level that succeeds hands its locks to its parent, which keeps them until it ends.
 * - Locks are taken in one global order: the roots in their declared order, and the rows of one root in ascending id
 *   order. Two transactions that take their locks in that order cannot wait for each other in a cycle, so a lock
 *   that would break the order is a defect found by the first run that reaches it, and no race is needed to see it.
 */
import { Array as Arr, Context, Effect, Option, Order, Ref } from "effect";

/** One held lock: the position of the root in the global order, and the row's id. */
export interface Held {
  readonly id: number;
  readonly rank: number;
}

export interface LockScope {
  readonly held: Ref.Ref<readonly Held[]>;
  readonly parent: Option.Option<LockScope>;
}

/** The scope of the innermost transaction level; none outside `transactional`. */
export const CurrentLockScope = Context.Reference<Option.Option<LockScope>>(
  "@vektorprogrammet/db/aggregate/CurrentLockScope",
  { defaultValue: Option.none }
);

const byLockOrder: Order.Order<Held> = Order.combine(
  Order.mapInput(Order.Number, (held: Held) => held.rank),
  Order.mapInput(Order.Number, (held: Held) => held.id)
);

/** The held lock that a request for `next` would have to precede, if there is one: the order is strictly ascending. */
export const orderViolation = (
  held: readonly Held[],
  next: Held
): Option.Option<Held> =>
  Option.filter(
    Arr.last(Arr.sort(held, byLockOrder)),
    (last) => byLockOrder(next, last) <= 0
  );

export const isHeld = (held: readonly Held[], wanted: Held): boolean =>
  Arr.some(
    held,
    (entry) => entry.rank === wanted.rank && entry.id === wanted.id
  );

export const openScope = (
  parent: Option.Option<LockScope>
): Effect.Effect<LockScope> =>
  Effect.map(Ref.make<readonly Held[]>([]), (held) => ({ held, parent }));

/** Every lock that the scope and its enclosing levels hold. */
export const heldIn = Effect.fnUntraced(function* heldIn(
  scope: Option.Option<LockScope>
): Effect.fn.Return<readonly Held[]> {
  if (Option.isNone(scope)) {
    return [];
  }

  return [
    ...(yield* Ref.get(scope.value.held)),
    ...(yield* heldIn(scope.value.parent)),
  ];
});

/** A level that succeeded: its locks are still held, now by the level around it. */
export const handUp = Effect.fnUntraced(function* handUp(scope: LockScope) {
  if (Option.isSome(scope.parent)) {
    yield* Ref.update(
      scope.parent.value.held,
      Arr.appendAll(yield* Ref.get(scope.held))
    );
  }
});
