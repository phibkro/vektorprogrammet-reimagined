/**
 * The proof of a transaction is the live transaction's own (spec 0019, guarantee TX5).
 *
 * `InTransaction` is an ordinary service, and Effect keys a service by a string, so a program can make a value of it
 * without naming it (`Context.makeUnsafe`, `Context.addUnsafe` with `Layer.succeedContext`, a cast `{ key }`). What it
 * cannot make is the object that this module holds for the transaction that is running:
 *
 * - `transactional` opens each level (the transaction, and every nested `transactional`, which is a savepoint) with
 *   `withLiveProof`: it makes the level's proof, pushes it on a module-private stack of the live levels of the level's
 *   connection (the connection of the `TransactionConnection` `[connection, depth]` pair that `SqlClient.withTransaction`
 *   gives to the program inside the level), and takes it off again when the level's program ends, on every exit.
 * - An adapter method that requires `InTransaction` is wrapped by `verified`. Before its first statement it reads the
 *   proof that the program holds and the connection of the level that the fiber is in, and is a defect
 *   (`TransactionNotLive`) unless that proof is the top of the connection's stack: the innermost live level. The
 *   comparison is by reference: a copy is a forgery.
 *
 * So the check refuses a proof that nothing here made, a proof of a transaction that has ended, a proof of another
 * transaction when the fiber runs on a different connection (finished, or running), a proof of an outer level while a
 * nested one is live on the connection (including a sibling fiber of the outer level, which would write into a
 * savepoint that can roll back), and no proof at all. The cost of a call is two context lookups, one `WeakMap` read and
 * one array read.
 *
 * What it does not stop (guarantee TX5, spec 0019 R7): a program that captures its whole context inside a live level
 * (`Effect.context()`) and provides it around a method elsewhere, even inside another transaction. That context holds
 * the level's proof and the level's own connection together, and if that level is the innermost live one of its
 * connection the check passes, and the statements go to it for as long as it lives (a finished level is no longer on
 * the stack, so it is refused). The write lands in that level and commits or rolls back with it, so it is no forgery of
 * a transaction that does not exist, and it needs the program to carry a live context out of its level on purpose,
 * which no lint sees. This module does not close it (`liveProof.postgres.test.ts`).
 *
 * Which methods verify is not listed here: it is the `Requires` rows of the domain's `TransactionModes`, the one
 * declaration of what a port method asks of a transaction, so a method that requires `InTransaction` is covered by being
 * declared.
 */
import { InTransaction, TransactionModes } from "@vektorprogrammet/domain";
import type { StorePorts, TransactionMode } from "@vektorprogrammet/domain";
import { Array as Arr, Effect, Option, Record as Rec } from "effect";
import { cast } from "effect/Function";
import { SqlClient } from "effect/sql/SqlClient";

import { TransactionNotLive } from "./aggregate/defects.ts";

type Proof = InTransaction["Service"];

/**
 * The proofs of the live levels of each connection, outermost first, by the `TransactionConnection` connection of the
 * level. Nothing outside this module adds to it. A nested level (a savepoint) is live on the same connection as its
 * parent, so it sits above the parent's proof, and only the innermost proof passes: a fiber of the outer level that runs
 * beside a live nested level would write into the savepoint, which can roll back with the caller told it succeeded.
 */
const stacks = new WeakMap<object, Proof[]>();

/**
 * Runs `self`, the program of one transaction level, with that level's own proof, and takes the proof back when `self`
 * ends, whatever its exit (it is a release, so interruption does it too). It runs inside `withTransaction`, so the
 * level's pair is in the context. Levels of one connection are serialised by `withTransaction` (a nested one holds the
 * client's transaction semaphore), so pushes and removals nest.
 */
export const withLiveProof = <A, E, R>(
  sql: SqlClient,
  self: Effect.Effect<A, E, R>
): Effect.Effect<A, E, Exclude<R, InTransaction>> =>
  Effect.flatMap(Effect.serviceOption(sql.transactionService), (level) =>
    Option.match(level, {
      onNone: () =>
        Effect.die(
          new TransactionNotLive({
            message: "A level of transactional began without a transaction.",
          })
        ),
      onSome: ([connection]) => {
        const proof = InTransaction.of({ kind: "database-transaction" });

        return Effect.acquireUseRelease(
          Effect.sync(() => {
            stacks.set(connection, [...(stacks.get(connection) ?? []), proof]);
          }),
          () => Effect.provideService(self, InTransaction, proof),
          () =>
            Effect.sync(() => {
              stacks.set(
                connection,
                Arr.filter(
                  stacks.get(connection) ?? [],
                  (live) => live !== proof
                )
              );
            })
        );
      },
    })
  );

const refusal = (method: string, why: string) =>
  Effect.die(
    new TransactionNotLive({
      message: `${method} requires the proof of the transaction it runs in: ${why}.`,
    })
  );

/** Why the program's proof is not the live one of this fiber's connection; nothing when it is. */
const whyNotLive = (
  held: Option.Option<Proof>,
  level: Option.Option<readonly [object, number]>
): string | undefined => {
  if (Option.isNone(held)) {
    return "the program holds none";
  }

  if (Option.isNone(level)) {
    return "it runs outside a transaction";
  }

  const [connection] = level.value;
  const live = stacks.get(connection);

  return live?.at(-1) === held.value
    ? undefined
    : "the proof it holds is not the one of the innermost live level of its connection";
};

/** Dies unless the program holds the proof that this fiber's own transaction level made. */
const verify = (sql: SqlClient, method: string) =>
  Effect.flatMap(Effect.serviceOption(InTransaction), (held) =>
    Effect.flatMap(Effect.serviceOption(sql.transactionService), (level) => {
      const why = whyNotLive(held, level);

      return why === undefined ? Effect.void : refusal(method, why);
    })
  );

/** What a member of a port is when it requires `InTransaction`: a method (arguments in, an effect out) or an effect. */
type Member =
  | ((...args: readonly unknown[]) => Effect.Effect<unknown, unknown, unknown>)
  | Effect.Effect<unknown, unknown, unknown>;

/** `member` behind the check: a method runs it first, an effect value too. */
const behindCheck = (sql: SqlClient, method: string, member: Member) =>
  Effect.isEffect(member)
    ? Effect.flatMap(verify(sql, method), () => member)
    : (...args: readonly unknown[]) =>
        Effect.flatMap(verify(sql, method), () => member(...args));

/**
 * `service` with every method that requires `InTransaction` made to verify the proof before it starts. The methods are
 * the `Requires` rows of `TransactionModes[name]`; the others are returned as they are.
 */
export const verified = Effect.fnUntraced(function* verified<
  Name extends keyof StorePorts,
>(name: Name, service: StorePorts[Name]["Service"]) {
  const sql = yield* SqlClient;

  const modes: Readonly<Record<string, TransactionMode>> =
    TransactionModes[name];

  // SAFETY: the members that this reads as `Member` are the `Requires` ones, which the declaration says are methods or
  // effects; the others are passed on untouched (EX-0025).
  const members = cast<typeof service, Readonly<Record<string, Member>>>(
    service
  );

  const guarded = Rec.map(members, (member, key) =>
    modes[key] === "Requires"
      ? behindCheck(sql, `${name}.${key}`, member)
      : member
  );

  // SAFETY: each member is the member it was, or the same method or effect behind the check, so the object has the
  // type of `service` (EX-0025).
  return cast<typeof guarded, typeof service>(guarded);
});
