import { Array as Arr, Cause, Deferred, Effect, Exit, Fiber } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { transactional } from "../../src/index.ts";
import { TestDatabaseUrl, withClient } from "./disposableDatabase.ts";

/** The effect, held at the gate until it opens, then run to its exit. */
const atGate = <A, E, R>(
  gate: Deferred.Deferred<null>,
  effect: Effect.Effect<A, E, R>
) => Effect.andThen(Deferred.await(gate), Effect.exit(effect));

/** Release all effects from one gate and collect their exits. */
export const race = <A, E, R>(
  effects: readonly Effect.Effect<A, E, R>[]
): Effect.Effect<readonly Exit.Exit<A, E>[], never, R> =>
  Effect.gen(function* raceProgram() {
    const gate = yield* Deferred.make<null>();

    const fibers = Effect.forEach(effects, (effect) => atGate(gate, effect), {
      concurrency: "unbounded",
    });

    const [exits] = yield* Effect.all([fibers, Deferred.succeed(gate, null)], {
      concurrency: "unbounded",
    });

    return exits;
  });

/** Two effects of different types released from one gate, each with its own exit. */
export const raceTwo = <A, EA, RA, B, EB, RB>(
  first: Effect.Effect<A, EA, RA>,
  second: Effect.Effect<B, EB, RB>
): Effect.Effect<
  readonly [Exit.Exit<A, EA>, Exit.Exit<B, EB>],
  never,
  RA | RB
> =>
  Effect.gen(function* raceTwoProgram() {
    const gate = yield* Deferred.make<null>();

    const [one, other] = yield* Effect.all(
      [atGate(gate, first), atGate(gate, second), Deferred.succeed(gate, null)],
      { concurrency: "unbounded" }
    );

    return [one, other] as const;
  });

/**
 * Holds `lock` in a transaction of its own (so the lock holds until the transaction ends), starts `command`, and
 * reports whether the command was waiting on a lock whose query matches `waitingQuery` (an `ilike` pattern) before it
 * wrote anything, whether it was still running then, and how it ended once the lock was let go. A command that does not
 * take the lock does not wait, and finishes while the lock is held. `whileWaiting` runs once the command is seen
 * waiting, with the lock still held: what it returns is `during`.
 */
export const meetsHeldLock = Effect.fnUntraced(function* meetsHeldLock<
  A,
  E,
  R,
  LE,
  LR,
  W = undefined,
  WE = never,
  WR = never,
>(
  lock: Effect.Effect<unknown, LE, LR>,
  waitingQuery: string,
  command: Effect.Effect<A, E, R>,
  whileWaiting?: Effect.Effect<W, WE, WR>
) {
  const sql = yield* SqlClient;
  const held = yield* Deferred.make<null>();
  const release = yield* Deferred.make<null>();
  const finished = yield* Deferred.make<null>();

  const holder = yield* Effect.forkChild(
    transactional(
      Effect.gen(function* holdLock() {
        yield* lock;
        yield* Deferred.succeed(held, null);
        yield* Deferred.await(release);
      })
    )
  );

  yield* Deferred.await(held);

  const running = yield* Effect.forkChild(
    Effect.exit(Effect.ensuring(command, Deferred.succeed(finished, null)))
  );

  let waiting = 0;

  for (const _ of Arr.range(1, 5000)) {
    const rows = yield* sql<{
      readonly waiting: number;
    }>`select count(*)::int as waiting from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'
      and query ilike ${waitingQuery} and pid <> pg_backend_pid()`;

    waiting = rows[0]?.waiting ?? 0;

    if (waiting > 0 || (yield* Deferred.isDone(finished))) {
      break;
    }
  }

  const stillRunning = !(yield* Deferred.isDone(finished));
  const during = whileWaiting === undefined ? undefined : yield* whileWaiting;
  yield* Deferred.succeed(release, null);
  yield* Fiber.join(holder);

  return { during, exit: yield* Fiber.join(running), stillRunning, waiting };
});

/** Whether another connection could lock the person's row right now (`FOR NO KEY UPDATE NOWAIT`). */
export const lockableElsewhere = Effect.fnUntraced(function* lockableElsewhere(
  personId: number
) {
  const url = yield* TestDatabaseUrl;

  return yield* withClient(url, (client) =>
    client
      .unsafe(
        `select id from person where id = ${personId} for no key update nowait`
      )
      .pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false)
      )
  );
});

/** What a failed race prints: each loser's full Cause, with the SQLSTATE and the reason of a SQL defect. */
export const raceReport = <A, E>(
  round: number,
  exits: readonly Exit.Exit<A, E>[]
): string =>
  `round ${round}:\n${Arr.join(
    Arr.map(Arr.filter(exits, Exit.isFailure), (failure) =>
      Cause.pretty(failure.cause)
    ),
    "\n\n"
  )}`;

/** What an exit says when an assertion about it fails. */
export const describeExit = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isSuccess(exit) ? "it was allowed" : Cause.pretty(exit.cause);
