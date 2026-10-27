import { Array as Arr, Cause, Deferred, Effect, Exit } from "effect";

/** Release all effects from one gate and collect their exits. */
export const race = <A, E, R>(
  effects: readonly Effect.Effect<A, E, R>[]
): Effect.Effect<readonly Exit.Exit<A, E>[], never, R> =>
  Effect.gen(function* raceProgram() {
    const gate = yield* Deferred.make<null>();

    const fibers = Effect.forEach(
      effects,
      (effect) => Effect.andThen(Deferred.await(gate), Effect.exit(effect)),
      { concurrency: "unbounded" }
    );

    const [exits] = yield* Effect.all([fibers, Deferred.succeed(gate, null)], {
      concurrency: "unbounded",
    });

    return exits;
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
