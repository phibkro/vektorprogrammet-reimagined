/**
 * Grants (ADR 0001): a row is `(subject sets, commands, scope)`. The rows of a domain are its permission table.
 * Grants only add up; a command that no row names is refused for everyone (`authorize.ts`).
 *
 * `make` types the pairs: a department-bound set takes the scope `department` or `all`, `Self` takes `own`, and a
 * global set (`Anyone`, `Admin`, `System`) takes `all`. A pair outside these is a compile error.
 */
import type { NonEmptyReadonlyArray } from "effect/Array";

import type * as Subject from "./subject.ts";

export type { Scope } from "./subject.ts";

export interface Row<Command extends string = string> {
  /** The row holds for a principal in any of these sets (their union). */
  readonly subjects: NonEmptyReadonlyArray<Subject.Any>;
  readonly commands: NonEmptyReadonlyArray<Command>;
  readonly scope: Subject.Scope;
}

interface Make {
  <const Command extends string>(
    subjects: NonEmptyReadonlyArray<Subject.Global>,
    commands: NonEmptyReadonlyArray<Command>,
    scope: "all"
  ): Row<Command>;
  <const Command extends string>(
    subjects: NonEmptyReadonlyArray<Subject.Personal>,
    commands: NonEmptyReadonlyArray<Command>,
    scope: "own"
  ): Row<Command>;
  <const Command extends string>(
    subjects: NonEmptyReadonlyArray<Subject.Departmental>,
    commands: NonEmptyReadonlyArray<Command>,
    scope: "department" | "all"
  ): Row<Command>;
}

/** One grant row: `Grant.make([Subject.leader, Subject.board], ["createMembership"], "department")`. */
export const make: Make = <const Command extends string>(
  subjects: NonEmptyReadonlyArray<Subject.Any>,
  commands: NonEmptyReadonlyArray<Command>,
  scope: Subject.Scope
): Row<Command> => ({ commands, scope, subjects });
