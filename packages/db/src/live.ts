/**
 * The proof of a transaction is the live transaction's own (spec 0019, guarantee TX5).
 *
 * `InTransaction` is an ordinary service, and Effect keys a service by a string, so a program can make a value of it
 * without naming it (`Context.makeUnsafe`, `Context.addUnsafe` with `Layer.succeedContext`, a cast `{ key }`). What it
 * cannot make is the object that this module holds for the transaction that is running.
 *
 * **The stack is PostgreSQL's savepoint stack** (R21). For each connection this module keeps the levels that are open on
 * it, outermost first, as PostgreSQL keeps its savepoints. A nested level is pushed before its `SAVEPOINT` is sent. A
 * level that ends takes its entry and every entry above it off the stack, as `RELEASE` and `ROLLBACK TO` destroy every
 * savepoint above the one they name. The connection is the one of the `TransactionConnection` `[connection, depth]`
 * pair that `SqlClient.withTransaction` gives to the program inside a level.
 *
 * - `transactional` opens each level (the transaction, and every nested `transactional`) with `liveLevel`, which makes
 *   the level's proof and its entry. A nested level is entered before its `SAVEPOINT` and left after its `ROLLBACK TO`
 *   or `RELEASE`; a top-level level is entered when `BEGIN` has given it a connection and left before `COMMIT`.
 * - An adapter method that requires `InTransaction` is wrapped by `verified`. Before its first statement it is a defect
 *   (`TransactionNotLive`) unless the proof that the program holds is the top of its connection's stack, the innermost
 *   level, and that level has not ended its body. The comparison is by reference: a copy is a forgery. The method then
 *   counts as running on that entry until it ends, on every exit, interruption included.
 * - A nested level is admitted only from the innermost live level: the entry at the depth of the caller's pair must be
 *   the one whose proof the caller holds, must be the top of the stack, must be open and must have no method running.
 *   The admission and the entry are one synchronous step. So a fiber that outlives a level holds a pair that no longer
 *   names the top, and cannot open a level from it (R18); and of two levels asked for at once from one parent the first
 *   is admitted and the second is refused as `TransactionNotLive`, every time.
 * - When a level's body has ended, before the statement that ends the level, the level and every level above it are
 *   closed: no method of them starts, and no level is opened from them. The level then waits until no method of any of
 *   them is running, so no statement of theirs is sent after the statement that ends the level and lands in the level
 *   around it. If a level above it is still running, the level fails (a defect), so that the statement is the rollback:
 *   the inner level's savepoint is destroyed by the end of this one, and it would report a failure for rows that the
 *   outer commit keeps.
 *
 * Why (R14, R18, R21). One connection is one ordered conversation, so a statement lands in whichever savepoint is open
 * when it reaches the server, and a method that was told it succeeded in one level must not land in another. Each rule
 * above closes one way that could happen, and `liveProperty.postgres.test.ts` holds the claim for every generated
 * program: a write that reported success is in the committed state if and only if its level and every level around it
 * reported success; a write that was refused is not; each rule, removed, is found by that test.
 *
 * Identity of the fiber plays no part: the in-process RPC server runs every command handler on a fiber of its own, not
 * the one that opened the transaction. Methods of one level may run concurrently (several `enqueue` calls at once are
 * ordinary use of one transaction, and their statements queue in order), and so may a handler on another fiber.
 *
 * What it does not stop (TX5, spec 0019 R7 and R21): a program that captures its whole context inside a live level
 * (`Effect.context()`) and provides it around a method elsewhere, even inside another transaction, holds the level's
 * proof and connection together, so while that level is the innermost the check passes and the statements go to it;
 * they commit or roll back with it, which is no forgery of a transaction that does not exist, and a finished level is
 * refused. And a level that is interrupted after its closing statement was issued (`withTransaction` records that on the span
 * of the level before it sends `RELEASE` or `COMMIT`, which it sends where it cannot be interrupted): the interruption is
 * reported afterwards, so the level says it failed and its rows may have merged, as with any commit whose
 * acknowledgment is lost. They merge whole or not at all, and nothing that a rolled-back level wrote comes back
 * (R24); `liveProperty.postgres.test.ts` holds both. A level interrupted before that statement rolled back.
 *
 * Which methods verify is not listed here: it is the `Requires` rows of the domain's `TransactionModes`, the one
 * declaration of what a port method asks of a transaction, so a method that requires `InTransaction` is covered by being
 * declared. The cost of a call is two context lookups, one `WeakMap` read and a few field reads; a level that ends
 * polls once a millisecond only while a method of it is still running.
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
  abandoned: boolean;
  active: number;
  closed: boolean;
  readonly proof: Proof;
}

/**
 * The live levels of each connection, outermost first, by the `TransactionConnection` connection of the level. Nothing
 * outside this module adds to it. A nested level (a savepoint) is on the same connection as its parent, so it sits above
 * the parent's entry, and only the innermost entry passes.
 */
const stacks = new WeakMap<Connection, Entry[]>();

/**
 * Puts a top-level entry on its connection's stack. The level has no connection until `BEGIN` has run, so there is
 * nothing to check: a top level is always admitted.
 */
const enterTop = (connection: Connection, entry: Entry) =>
  Effect.sync(() => {
    stacks.set(connection, [...(stacks.get(connection) ?? []), entry]);

    return true;
  });

/**
 * Puts a nested entry on the connection's stack, and says whether it did. The caller's own level is the entry at the
 * caller's `depth` (the `[connection, depth]` pair of the context the nested level is asked for in), and the nested level
 * is admitted only when that entry is the one the caller holds the proof of (it is live, and it is the caller's), is the
 * top of the stack (no level above it, whether live or begun) and has no method running. A fiber that outlives its level
 * holds a pair whose entry is gone or is no longer the top, so it cannot open a level from it. Check and push are one
 * synchronous step, so no method can start between them.
 */
const enterNested = (
  connection: Connection,
  entry: Entry,
  depth: number,
  held: Option.Option<Proof>
) =>
  Effect.sync(() => {
    const stack = stacks.get(connection) ?? [];
    const caller = stack.at(depth);

    if (
      caller === undefined ||
      stack.length !== depth + 1 ||
      caller.closed ||
      caller.active > 0 ||
      !Option.exists(held, (proof) => proof === caller.proof)
    ) {
      return false;
    }

    stacks.set(connection, [...stack, entry]);

    return true;
  });

/**
 * Takes the entry off its connection's stack, and every entry above it. PostgreSQL destroys every savepoint above the one
 * that is released or rolled back to, so a level opened inside the ending one (by a fiber that outlived it) is gone with
 * it, and nothing that holds its proof may write. An entry that is no longer on the stack (an ancestor ended first) is
 * left alone.
 */
const leave = (connection: Connection, entry: Entry) =>
  Effect.sync(() => {
    const stack = stacks.get(connection) ?? [];

    Option.map(
      Arr.findFirstIndex(stack, (live) => live === entry),
      (at) => stacks.set(connection, Arr.take(stack, at))
    );
  });

const waitUntilIdle = (entries: readonly Entry[]): Effect.Effect<void> =>
  Effect.suspend(() =>
    Arr.some(entries, (live) => live.active > 0)
      ? Effect.andThen(Effect.sleep("1 millis"), waitUntilIdle(entries))
      : Effect.void
  );

/**
 * The body of the level has ended and the statement that ends the level is about to be sent. PostgreSQL destroys every
 * savepoint above the one it releases or rolls back to, so the same is done here first, without waiting for the
 * statement: the entry and every entry above it are closed, so that no method of them starts and no level is opened from
 * them, and the level waits until no method of any of them is running, so that no statement of theirs is sent after the
 * statement that ends the level and lands in the level around it. Entries above it mean levels that are still running,
 * and the level fails (`abandoned`) instead of ending as if they were not. `leave` takes them off the stack when the
 * statement has been sent.
 */
const close = (connection: Connection, entry: Entry) =>
  Effect.suspend(() => {
    const stack = stacks.get(connection) ?? [];

    const levels = Option.match(
      Arr.findFirstIndex(stack, (live) => live === entry),
      {
        onNone: () => [entry],
        onSome: (at) => Arr.drop(stack, at),
      }
    );

    for (const live of levels) {
      live.closed = true;
    }

    entry.abandoned = levels.length > 1;

    return waitUntilIdle(levels);
  });

const refusal = (method: string, why: string) =>
  Effect.die(
    new TransactionNotLive({
      message: `${method} requires the proof of the transaction it runs in: ${why}.`,
    })
  );

/**
 * `program` with the entry on its connection's stack for as long as it runs, on every exit (the release is a finalizer).
 * A level that is not admitted dies without having been entered.
 */
const holding = <A, E, R>(
  connection: Connection,
  entry: Entry,
  enter: Effect.Effect<boolean>,
  program: Effect.Effect<A, E, R>
) =>
  Effect.acquireUseRelease(
    enter,
    (admitted) =>
      admitted
        ? program
        : refusal(
            "a nested transactional",
            "it was asked for while a method of its own level is running, from a level that is not the innermost live one, or outside a live level"
          ),
    (admitted) => (admitted ? leave(connection, entry) : Effect.void)
  );

/** The program of one level, given the proof of that level. */
type Provide = <A, E, R>(
  program: Effect.Effect<A, E, R>
) => Effect.Effect<A, E, Exclude<R, InTransaction>>;

/**
 * The program of a level with its own proof, and the end of its body marked: when the body has ended, by any exit, and
 * before the statement that ends the level (`ROLLBACK TO`, `RELEASE`, `COMMIT` or `ROLLBACK`) is sent, the level is
 * closed. A level that ends while a level opened inside it is still running fails (a defect, so its statement is the
 * rollback): the inner level's savepoint is destroyed by the end of this one, and the inner level would report a failure
 * for rows that the outer commit keeps.
 */
const provided = <A, E, R>(
  connection: Connection,
  entry: Entry,
  program: Effect.Effect<A, E, R>
) =>
  Effect.filterOrElse(
    Effect.onExit(
      Effect.provideService(program, InTransaction, entry.proof),
      () => close(connection, entry)
    ),
    () => !entry.abandoned,
    () =>
      Effect.die(
        new TransactionNotLive({
          message:
            "A transactional level ended while a level opened inside it was still running, and its savepoint cannot outlive it.",
        })
      )
  );

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
      abandoned: false,
      active: 0,
      closed: false,
      proof: InTransaction.of({ kind: "database-transaction" }),
    };

    if (Option.isSome(outer)) {
      const [connection, depth] = outer.value;

      return Effect.flatMap(Effect.serviceOption(InTransaction), (held) =>
        holding(
          connection,
          entry,
          enterNested(connection, entry, depth, held),
          open((program) => provided(connection, entry, program))
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
              enterTop(connection, entry),
              provided(connection, entry, program)
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

  if (innermost?.proof !== held.value || innermost.closed) {
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
