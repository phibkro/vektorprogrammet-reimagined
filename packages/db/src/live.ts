/**
 * The proof of a transaction is the live transaction's own (spec 0019, guarantee TX5).
 *
 * `InTransaction` is an ordinary service, and Effect keys a service by a string, so a program can make a value of it
 * without naming it (`Context.makeUnsafe`, `Context.addUnsafe` with `Layer.succeedContext`, a cast `{ key }`). What it
 * cannot make is the object that this module holds for the transaction that is running:
 *
 * - `transactional` opens each level (the transaction, and every nested `transactional`, which is a savepoint) with
 *   `liveLevel`: it makes the level's proof and puts it, as an entry, on a module-private stack of the levels of the
 *   level's connection (the connection of the `TransactionConnection` `[connection, depth]` pair that
 *   `SqlClient.withTransaction` gives to the program inside the level). It takes the entry off again when the level
 *   ends, on every exit. A nested level is entered before its `SAVEPOINT` is sent and left after its `ROLLBACK TO` or
 *   `RELEASE` has finished.
 * - An adapter method that requires `InTransaction` is wrapped by `verified`. Before its first statement it reads the
 *   proof that the program holds and the connection of the level that the fiber is in, and is a defect
 *   (`TransactionNotLive`) unless that proof is the top of the connection's stack, the innermost level. The comparison
 *   is by reference: a copy is a forgery. The method then counts as in flight on that entry until it ends, on every
 *   exit, interruption included (the count is released by a finalizer).
 * - A nested level is admitted only while the entry around it has no method in flight, and the admission and the entry
 *   are one synchronous step.
 *
 * Why (spec 0019 R14). One connection is one ordered conversation, so a nested level's `SAVEPOINT` lands between
 * whatever statements of the level around it are on the wire, and everything after it goes into the savepoint, which
 * can roll back while the caller is told it succeeded. Two things could let that happen, and each is closed by one
 * rule. A method of the outer level that starts after the nested level was asked for would write into it: the entry is
 * made before the `SAVEPOINT`, so the outer proof is no longer the innermost from that moment. A method of the outer
 * level that is already under way (it has several statements) would have its later statements land in it: the nested
 * level is refused while the count is above zero, and no method of the outer level can start once the entry is there.
 * For any interleaving of a method of a level and a nested level on one connection, one of them dies as
 * `TransactionNotLive`, or both complete and every row is in the level that reported it.
 *
 * Identity of the fiber plays no part: the in-process RPC server runs every command handler on a fiber of its own, not
 * the one that opened the transaction. Methods of one level may run concurrently (several `enqueue` calls at once are
 * ordinary use of one transaction, and their statements queue in order), and so may a handler on another fiber.
 *
 * What it does not stop (TX5, spec 0019 R7 and R14): a program that captures its whole context inside a live level
 * (`Effect.context()`) and provides it around a method elsewhere, even inside another transaction, holds the level's
 * proof and connection together, so while that level is the innermost the check passes and the statements go to it;
 * they commit or roll back with it, which is no forgery of a transaction that does not exist, and a finished level is
 * refused. And a method that is still running when its level ends: the level leaves the stack without waiting, the
 * method's later statements go to a connection that the level has returned, which is Effect's own behaviour for a
 * fiber that outlives its transaction and not something this check can see.
 *
 * Which methods verify is not listed here: it is the `Requires` rows of the domain's `TransactionModes`, the one
 * declaration of what a port method asks of a transaction, so a method that requires `InTransaction` is covered by being
 * declared. The cost of a call is two context lookups, one `WeakMap` read and a few field reads.
 */
import { InTransaction, TransactionModes } from "@vektorprogrammet/domain";
import type { StorePorts, TransactionMode } from "@vektorprogrammet/domain";
import { Array as Arr, Effect, Option, Record as Rec, Result } from "effect";
import { cast } from "effect/Function";
import { SqlClient } from "effect/sql/SqlClient";
import type { Connection } from "effect/sql/SqlConnection";

import { TransactionNotLive } from "./aggregate/defects.ts";

type Proof = InTransaction["Service"];

/** One level of a connection: its proof, and how many methods of it are running now. */
interface Entry {
  active: number;
  readonly proof: Proof;
}

/**
 * The live levels of each connection, outermost first, by the `TransactionConnection` connection of the level. Nothing
 * outside this module adds to it. A nested level (a savepoint) is on the same connection as its parent, so it sits above
 * the parent's entry, and only the innermost entry passes.
 */
const stacks = new WeakMap<Connection, Entry[]>();

/**
 * Puts the entry on the connection's stack, and says whether it did. A nested level is admitted only when there is a
 * level around it and no method of that level is running; a top level is always admitted. Check and push are one
 * synchronous step, so no method can start between them.
 */
const enter = (connection: Connection, entry: Entry, nested: boolean) =>
  Effect.sync(() => {
    const stack = stacks.get(connection) ?? [];
    const parent = stack.at(-1);

    if (nested && (parent === undefined || parent.active > 0)) {
      return false;
    }

    stacks.set(connection, [...stack, entry]);

    return true;
  });

const leave = (connection: Connection, entry: Entry) =>
  Effect.sync(() => {
    stacks.set(
      connection,
      Arr.filter(stacks.get(connection) ?? [], (live) => live !== entry)
    );
  });

const refusal = (method: string, why: string) =>
  Effect.die(
    new TransactionNotLive({
      message: `${method} requires the proof of the transaction it runs in: ${why}.`,
    })
  );

/**
 * `program` with the entry on its connection's stack for as long as it runs, on every exit (the release is a finalizer).
 * A nested level that is not admitted dies without having been entered.
 */
const holding = <A, E, R>(
  connection: Connection,
  entry: Entry,
  nested: boolean,
  program: Effect.Effect<A, E, R>
) =>
  Effect.acquireUseRelease(
    enter(connection, entry, nested),
    (admitted) =>
      admitted
        ? program
        : refusal(
            "a nested transactional",
            "it was asked for while a method of the level around it is running, or outside a live level"
          ),
    (admitted) => (admitted ? leave(connection, entry) : Effect.void)
  );

/** The program of one level, given the proof of that level. */
type Provide = <A, E, R>(
  program: Effect.Effect<A, E, R>
) => Effect.Effect<A, E, Exclude<R, InTransaction>>;

/**
 * One transaction level of `sql`: `open` gets `provide`, which gives the level's program its own proof, and returns the
 * effect that opens the level (`sql.withTransaction`).
 *
 * - A nested level (the context already holds a connection) is entered on that connection's stack before `open`'s effect
 *   runs and left after it has finished, so the entry covers the `SAVEPOINT` and the `ROLLBACK TO` or `RELEASE` too: from
 *   the moment a nested level is asked for, the outer proof is no longer the innermost.
 * - A top-level level has no connection until `BEGIN` has run, so it is entered inside, when the connection is known,
 *   and left before `COMMIT` or `ROLLBACK`. No proof of it exists before then, so nothing can be waiting on it.
 *
 * Either way the entry is removed on every exit, interruption included.
 */
export const liveLevel = <A, E, R>(
  sql: SqlClient,
  open: (provide: Provide) => Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> =>
  Effect.flatMap(Effect.serviceOption(sql.transactionService), (outer) => {
    const entry: Entry = {
      active: 0,
      proof: InTransaction.of({ kind: "database-transaction" }),
    };

    if (Option.isSome(outer)) {
      const [connection] = outer.value;

      return holding(
        connection,
        entry,
        true,
        open((program) =>
          Effect.provideService(program, InTransaction, entry.proof)
        )
      );
    }

    return open((program) =>
      Effect.flatMap(Effect.serviceOption(sql.transactionService), (own) =>
        Option.match(own, {
          onNone: () =>
            Effect.die(
              new TransactionNotLive({
                message:
                  "A level of transactional began without a transaction.",
              })
            ),
          onSome: ([connection]) =>
            holding(
              connection,
              entry,
              false,
              Effect.provideService(program, InTransaction, entry.proof)
            ),
        })
      )
    );
  });

/**
 * Whether the program's proof is the one that may be used on this connection now: the entry that the method now runs
 * on, or why not. The proof must be the innermost entry of the connection. When it is, the method is counted as running
 * on that entry in the same step, so a nested level cannot be admitted between the check and the count.
 */
const admit = (
  held: Option.Option<Proof>,
  level: Option.Option<readonly [Connection, number]>
): Result.Result<Entry, string> => {
  if (Option.isNone(held)) {
    return Result.fail("the program holds none");
  }

  if (Option.isNone(level)) {
    return Result.fail("it runs outside a transaction");
  }

  const [connection] = level.value;
  const innermost = stacks.get(connection)?.at(-1);

  if (innermost?.proof !== held.value) {
    return Result.fail(
      "the proof it holds is not the one of the innermost live level of its connection"
    );
  }

  innermost.active += 1;

  return Result.succeed(innermost);
};

/** Checks the proof and counts the method as running on its entry; dies, counting nothing, when the proof is not the live one. */
const begin = (sql: SqlClient, method: string) =>
  Effect.flatMap(Effect.serviceOption(InTransaction), (held) =>
    Effect.flatMap(Effect.serviceOption(sql.transactionService), (level) =>
      Result.match(admit(held, level), {
        onFailure: (why) => refusal(method, why),
        onSuccess: (entry) => Effect.succeed(entry),
      })
    )
  );

/** `program` counted as running on the entry of the live proof, from the check to the end, on every exit. */
const running = <A, E, R>(
  sql: SqlClient,
  method: string,
  program: () => Effect.Effect<A, E, R>
) =>
  Effect.acquireUseRelease(begin(sql, method), program, (entry) =>
    Effect.sync(() => {
      entry.active -= 1;
    })
  );

/** What a member of a port is when it requires `InTransaction`: a method (arguments in, an effect out) or an effect. */
type Member =
  | ((...args: readonly unknown[]) => Effect.Effect<unknown, unknown, unknown>)
  | Effect.Effect<unknown, unknown, unknown>;

/** `member` behind the check: a method runs under it, an effect value too. */
const behindCheck = (sql: SqlClient, method: string, member: Member) =>
  Effect.isEffect(member)
    ? running(sql, method, () => member)
    : (...args: readonly unknown[]) =>
        running(sql, method, () => member(...args));

/**
 * `service` with every method that requires `InTransaction` made to verify the proof before it starts and to count as
 * running until it ends. The methods are the `Requires` rows of `TransactionModes[name]`; the others are returned as
 * they are.
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
