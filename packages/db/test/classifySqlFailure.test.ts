/**
 * `classifySqlFailure` on the SQL failures that two overlapping membership writes can meet (spec 0006 R6). An
 * exclusion violation (23P01) is the refusal the contract names. `deadlock_detected` (40P01) is not: the transaction
 * that survives the deadlock can still roll back, so it is no verdict on the data and stays a defect. The repository
 * prevents it with the person's row lock (`teams.postgres.test.ts`), not by renaming it.
 */
import { assert, describe, it } from "@effect/vitest";
import { MEMBERSHIP_OVERLAPS } from "@vektorprogrammet/domain";
import { Cause, Exit, Option, Predicate } from "effect";
import { ConstraintError, DeadlockError, SqlError } from "effect/sql/SqlError";

import { classifySqlFailure } from "../src/classifySqlFailure.ts";
import { UniqueConstraint } from "../src/schema.ts";

/** What `@effect/sql-pg` reports for an exclusion violation: a `ConstraintError` whose cause carries the SQLSTATE. */
const exclusionViolation = new SqlError({
  reason: new ConstraintError({
    cause: Object.assign(
      new Error("conflicting key value violates exclusion constraint"),
      {
        code: "23P01",
        constraint: UniqueConstraint.membershipOverlap,
      }
    ),
    operation: "execute",
  }),
});

/** What `@effect/sql-pg` reports for SQLSTATE 40P01. */
const deadlock = new SqlError({
  reason: new DeadlockError({
    cause: Object.assign(new Error("deadlock detected"), { code: "40P01" }),
    operation: "execute",
  }),
});

describe("classifySqlFailure: the failures of two overlapping membership writes", () => {
  it("an exclusion violation of membership_no_overlap is AlreadyExists", () => {
    const exit = classifySqlFailure(exclusionViolation, "42");

    const error = Exit.isFailure(exit)
      ? Cause.findErrorOption(exit.cause)
      : Option.none();

    assert.isTrue(Option.exists(error, Predicate.isTagged("AlreadyExists")));
    assert.isTrue(
      Option.exists(error, (found) => found.message === MEMBERSHIP_OVERLAPS)
    );
  });

  it("a deadlock_detected (40P01) is a defect, never AlreadyExists or Conflict", () => {
    const exit = classifySqlFailure(deadlock, "42");

    assert.isTrue(Exit.isFailure(exit));
    assert.isTrue(Exit.isFailure(exit) && Cause.hasDies(exit.cause));
    assert.isFalse(
      Exit.isFailure(exit) && Option.isSome(Cause.findErrorOption(exit.cause))
    );
  });
});
