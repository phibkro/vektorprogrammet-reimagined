/**
 * C2 semester primitives (RULE-022, 033, 050, 051, 084, 190).
 *
 * A semester is (term, year) with a numeric year, so the legacy int-vs-string
 * comparison defect (RULE-050) cannot occur. Windows are half-open in Europe/Oslo:
 *
 *   Vår Y  = [Y-01-01 00:00, Y-08-01 00:00)
 *   Høst Y = [Y-08-01 00:00, (Y+1)-01-01 00:00)
 *
 * Legacy stored an inclusive end at 23:59:59 with one-second resolution; the
 * half-open end answers identically for every instant legacy can represent and
 * also covers the sub-second gap after 23:59:59 (spec 0001, equivalence note).
 */
import type { DateTime } from "effect";
import { Array as Arr, Order, Schema } from "effect";

import {
  isBefore,
  osloParts,
  osloWallClock,
  osloYear,
} from "../shared/clock.ts";
import { SemesterId } from "../shared/ids.ts";

export const Term = Schema.Literals(["VAR", "HOST"]);

export type Term = typeof Term.Type;

export const SemesterYear = Schema.Int.check(
  Schema.isBetween({ maximum: 9999, minimum: 1900 })
);

export const Semester = Schema.Struct({ term: Term, year: SemesterYear });

export type Semester = typeof Semester.Type;

export const StoredSemester = Schema.Struct({
  id: SemesterId,
  term: Term,
  year: SemesterYear,
});

export type StoredSemester = typeof StoredSemester.Type;

/** Norwegian label of a term, as shown in the UI. */
export const termLabel = (term: Term): "Vår" | "Høst" =>
  term === "VAR" ? "Vår" : "Høst";

/** "Vår 2026" / "Høst 2026". */
export const semesterLabel = (semester: Semester): string =>
  `${termLabel(semester.term)} ${semester.year}`;

/** RULE-033: January-July is Vår, August-December is Høst, by the Oslo calendar. */
export const semesterForDate = (instant: DateTime.DateTime): Semester => {
  const { year, month } = osloParts(instant);

  return { term: month <= 7 ? "VAR" : "HOST", year };
};

/** A half-open interval `[start, end)` of instants. */
export interface Window {
  readonly start: DateTime.Utc;
  readonly end: DateTime.Utc;
}

/** RULE-022 / RULE-051: the semester's half-open window at Oslo midnight. */
export const semesterWindow = (semester: Semester): Window =>
  semester.term === "VAR"
    ? {
        end: osloWallClock({ day: 1, month: 8, year: semester.year }),
        start: osloWallClock({ day: 1, month: 1, year: semester.year }),
      }
    : {
        end: osloWallClock({ day: 1, month: 1, year: semester.year + 1 }),
        start: osloWallClock({ day: 1, month: 8, year: semester.year }),
      };

/** `start <= instant < end`. */
export const windowContains = (
  window: Window,
  instant: DateTime.DateTime
): boolean => !isBefore(instant, window.start) && isBefore(instant, window.end);

/** RULE-050: by year, then Vår before Høst. */
export const SemesterOrder: Order.Order<Semester> = Order.combine(
  Order.mapInput(Order.Number, (semester: Semester) => semester.year),
  Order.mapInput(Order.Number, (semester: Semester) =>
    semester.term === "VAR" ? 0 : 1
  )
);

/** RULE-084: semester lists are ordered newest first. */
export const sortNewestFirst = <S extends Semester>(
  semesters: Iterable<S>
): S[] => Arr.sort(semesters, Order.flip(SemesterOrder));

/**
 * RULE-050: inclusive range check; a missing (null) bound is open-ended.
 * Typed numeric years fix the legacy same-year detection defect.
 */
export const isBetween = (
  semester: Semester,
  from: Semester | null,
  to: Semester | null
): boolean =>
  (from === null || SemesterOrder(semester, from) >= 0) &&
  (to === null || SemesterOrder(semester, to) <= 0);

/** The first year offered when creating a semester. */
export const FIRST_SELECTABLE_YEAR = 2012;

/** RULE-190 / RULE-144: selectable years, newest first: next Oslo year down to 2012. */
export const selectableYears = (today: DateTime.DateTime): readonly number[] =>
  Arr.reverse(Arr.range(FIRST_SELECTABLE_YEAR, osloYear(today) + 1));
