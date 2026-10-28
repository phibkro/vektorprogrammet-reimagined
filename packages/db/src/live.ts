/**
 * The proof of a transaction is the live transaction's own (spec 0019, guarantee TX5).
 *
 * `InTransaction` is an ordinary service, and Effect keys a service by a string, so a program can make a value of it
 * without naming it (`Context.makeUnsafe`, `Context.addUnsafe` with `Layer.succeedContext`, a cast `{ key }`). What it
 * cannot make is the object that this module holds for the transaction that is running:
 *
 * - `transactional` opens each level (the transaction, and every nested `transactional`, which is a savepoint) with
 *   `withLiveProof`: it makes the level's proof, enters it in a module-private `WeakMap` under the level's
 *   `TransactionConnection` value (the `[connection, depth]` pair that `SqlClient.withTransaction` makes afresh for each
 *   level and gives to the program inside it), and takes it out again when the level's program ends, on every exit.
 * - An adapter method that requires `InTransaction` is wrapped by `verified`. Before its first statement it reads the
 *   proof that the program holds and the pair of the level that the fiber is in, and is a defect (`TransactionNotLive`)
 *   unless the map holds exactly that proof under that pair. The comparison is by reference: a copy is a forgery.
 *
 * So the check refuses a proof that nothing here made, a proof of a transaction that has ended, a proof of another
 * transaction (finished or running on another connection), a proof of the outer level where a nested one runs, and no
 * proof at all. The cost of a call is two context lookups and one `WeakMap` read.
 *
 * Which methods verify is not listed here: it is the `Requires` rows of the domain's `TransactionModes`, the one
 * declaration of what a port method asks of a transaction, so a method that requires `InTransaction` is covered by being
 * declared.
 */
import { InTransaction, TransactionModes } from "@vektorprogrammet/domain";
import type { StorePorts, TransactionMode } from "@vektorprogrammet/domain";
import { Effect, Option, Record as Rec } from "effect";
import { cast } from "effect/Function";
import { SqlClient } from "effect/sql/SqlClient";

import { TransactionNotLive } from "./aggregate/defects.ts";

type Proof = InTransaction["Service"];

/** The proof of each live level, by the level's own `TransactionConnection` value. Nothing outside this module adds to it. */
const proofs = new WeakMap<object, Proof>();

/**
 * Runs `self`, the program of one transaction level, with that level's own proof, and takes the proof back when `self`
 * ends, whatever its exit (it is a release, so interruption does it too). It runs inside `withTransaction`, so the
 * level's pair is in the context.
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
      onSome: (pair) => {
        const proof = InTransaction.of({ kind: "database-transaction" });

        return Effect.acquireUseRelease(
          Effect.sync(() => proofs.set(pair, proof)),
          () => Effect.provideService(self, InTransaction, proof),
          () => Effect.sync(() => proofs.delete(pair))
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

/** Why the program's proof is not the live one of this fiber's transaction level; nothing when it is. */
const whyNotLive = (
  held: Option.Option<Proof>,
  level: Option.Option<object>
): string | undefined => {
  if (Option.isNone(held)) {
    return "the program holds none";
  }

  if (Option.isNone(level)) {
    return "it runs outside a transaction";
  }

  return proofs.get(level.value) === held.value
    ? undefined
    : "the proof it holds is not the live transaction's own";
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
