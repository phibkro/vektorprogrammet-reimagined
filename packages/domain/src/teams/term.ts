/**
 * Terms (ADR 0002, spec 0006): a membership's term is the semesters from its start to its end, both included. Whether
 * a membership is Planned, Active or Ended is calculated here from the current semester and stored nowhere, so there
 * is one definition of "active" for every caller (RULE-016, 023, 031, 048 and 124 were five; RULE-219 and 263 were a
 * flag and a job that disagreed with it). Semester arithmetic is the organisation module's: Vår before Høst, the
 * Oslo calendar at the boundaries (RULE-022, 033, 050).
 */
import { Schema } from "effect";
import type { DateTime } from "effect";

import {
  Semester,
  SemesterOrder,
  semesterForDate,
} from "../organisation/semester.ts";

/** The semesters a membership covers. `start ≤ end` is a schema rule here and a check constraint in the database. */
export const MembershipTerm = Schema.Struct({
  end: Semester,
  start: Semester,
}).check(
  Schema.makeFilter((term) =>
    SemesterOrder(term.start, term.end) <= 0
      ? true
      : {
          issue: "Sluttsemesteret kan ikke være før startsemesteret.",
          path: ["end"],
        }
  )
);

export type MembershipTerm = typeof MembershipTerm.Type;

/** The states of a membership, as the machine declares them (`declaration.ts`). */
export const MembershipState = Schema.TaggedUnion({
  Active: {},
  Ended: {},
  Planned: {},
});

export type MembershipState = (typeof MembershipState.Type)["_tag"];

/** Semesters in order, one number each: Vår 2026 is 4052, Høst 2026 is 4053, Vår 2027 is 4054. */
export const semesterOrdinal = (semester: Semester): number =>
  semester.year * 2 + (semester.term === "HOST" ? 1 : 0);

/** The semester of an ordinal; the inverse of `semesterOrdinal`. */
export const semesterOfOrdinal = (ordinal: number): Semester => ({
  term: ordinal % 2 === 0 ? "VAR" : "HOST",
  year: Math.floor(ordinal / 2),
});

/** The semester `count` after `semester` (before it when `count` is negative). */
export const advanceSemester = (semester: Semester, count: number): Semester =>
  semesterOfOrdinal(semesterOrdinal(semester) + count);

/** The semester right before this one. */
export const previousSemester = (semester: Semester): Semester =>
  advanceSemester(semester, -1);

/** `start + defaultTerm − 1`: a team's default term counts the start semester (ADR 0002). */
export const defaultEnd = (start: Semester, defaultTerm: number): Semester =>
  advanceSemester(start, defaultTerm - 1);

/** `left` is before `right`. */
export const isBeforeSemester = (left: Semester, right: Semester): boolean =>
  SemesterOrder(left, right) < 0;

/**
 * The state of a membership with this term in `current`: Planned before its start, Active from its start to its end,
 * Ended after it. At the last instant of the end semester it is still Active, and at the first instant of the next it
 * is Ended (the Oslo boundaries of `semesterForDate`).
 */
export const membershipState = (
  term: MembershipTerm,
  current: Semester
): MembershipState => {
  const at = semesterOrdinal(current);

  if (at < semesterOrdinal(term.start)) {
    return "Planned";
  }

  return at <= semesterOrdinal(term.end) ? "Active" : "Ended";
};

/** The state at an instant. */
export const membershipStateAt = (
  term: MembershipTerm,
  instant: DateTime.DateTime
): MembershipState => membershipState(term, semesterForDate(instant));
