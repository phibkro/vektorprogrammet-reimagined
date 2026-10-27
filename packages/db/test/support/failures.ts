/** What a failed command says: its typed error, if it failed with one (a defect or an interruption has none). */
import { Conflict } from "@vektorprogrammet/domain";
import { Cause, Exit, Option, Schema } from "effect";

/** Whether a command failed with this typed error, and not with a defect or another error. */
export const failedWith = (
  exit: Exit.Exit<unknown, unknown>,
  error: Schema.Top
): boolean =>
  Exit.isFailure(exit) &&
  Option.exists(Cause.findErrorOption(exit.cause), Schema.is(error));

/** The text of the typed `Conflict` that refused a command, or nothing when it failed otherwise. */
export const refusalOf = (exit: Exit.Exit<unknown, unknown>): string =>
  Exit.isFailure(exit)
    ? Option.match(Cause.findErrorOption(exit.cause), {
        onNone: () => "",
        onSome: (failure) =>
          Schema.is(Conflict)(failure) ? failure.message : "",
      })
    : "";
