/** What a failed command says: its typed error, if it failed with one (a defect or an interruption has none). */
import { assert } from "@effect/vitest";
import { Conflict } from "@vektorprogrammet/domain";
import { Cause, Exit, Option, Schema } from "effect";

import { describeExit } from "./race.ts";

/** Whether a command failed with this typed error, and not with a defect or another error. */
export const failedWith = (
  exit: Exit.Exit<unknown, unknown>,
  error: Schema.Top
): boolean =>
  Exit.isFailure(exit) &&
  Option.exists(Cause.findErrorOption(exit.cause), Schema.is(error));

/**
 * Asserts that a command failed with this typed error. When it did not, the message says what the exit was (`it was
 * allowed`, or the whole Cause) after `label`, which names the attempt in a loop of refusals.
 */
export const assertFailedWith = (
  exit: Exit.Exit<unknown, unknown>,
  error: Schema.Top,
  label: string
): void => {
  assert.isTrue(failedWith(exit, error), `${label}: ${describeExit(exit)}`);
};

/** The text of the typed `Conflict` that refused a command, or nothing when it failed otherwise. */
export const refusalOf = (exit: Exit.Exit<unknown, unknown>): string =>
  Exit.isFailure(exit)
    ? Option.match(Cause.findErrorOption(exit.cause), {
        onNone: () => "",
        onSome: (failure) =>
          Schema.is(Conflict)(failure) ? failure.message : "",
      })
    : "";
