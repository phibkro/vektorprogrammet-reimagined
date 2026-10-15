/**
 * C2 admission-period decisions (RULE-015, RULE-119 replacements, operator
 * 2026-10-15). Admission periods are stored data in Phase 3; Phase 1 ships the
 * decisions as pure functions over typed periods. One definition serves every
 * caller (public page, filters, application form).
 */
import { DateTime, Option, Schema } from "effect";
import { isBefore } from "../shared/clock.ts";
import { DepartmentId } from "../shared/ids.ts";
import { Semester, type Window, windowContains } from "./semester.ts";

export const AdmissionPeriod = Schema.Struct({
  departmentId: DepartmentId,
  semester: Semester,
  start: Schema.DateTimeUtc,
  end: Schema.DateTimeUtc,
}).check(
  Schema.makeFilter((period) =>
    isBefore(period.start, period.end)
      ? true
      : { path: ["end"], issue: "Slutt må være etter start." },
  ),
);
export type AdmissionPeriod = typeof AdmissionPeriod.Type;

/** RULE-119: admission is open iff `start <= now < end` (the end instant is closed). */
export const isAdmissionOpen = (period: Window, now: DateTime.DateTime): boolean =>
  windowContains(period, now);

export type AdmissionSelection<P extends Window> =
  | { readonly _tag: "Current"; readonly period: P }
  | { readonly _tag: "Latest"; readonly period: P };

const latestStart = <P extends Window>(periods: ReadonlyArray<P>): Option.Option<P> =>
  periods.reduce<Option.Option<P>>(
    (best, period) =>
      Option.isSome(best) && !isBefore(best.value.start, period.start) ? best : Option.some(period),
    Option.none(),
  );

/**
 * RULE-015 replacement: CURRENT is the period whose window contains `now`;
 * otherwise LATEST is the period with the most recent start that is not in the
 * future. A period that has not started is never current or latest. If
 * windows overlap (legacy data allowed it), the current period with the latest
 * start wins, so the answer is deterministic.
 */
export const currentOrLatestAdmissionPeriod = <P extends Window>(
  periods: Iterable<P>,
  now: DateTime.DateTime,
): Option.Option<AdmissionSelection<P>> => {
  const all = Array.from(periods);
  const current = latestStart(all.filter((period) => isAdmissionOpen(period, now)));
  if (Option.isSome(current)) return Option.some({ _tag: "Current", period: current.value });
  return Option.map(
    latestStart(all.filter((period) => !isBefore(now, period.start))),
    (period): AdmissionSelection<P> => ({ _tag: "Latest", period }),
  );
};

/** "Is admission open for this department now": true iff a current period exists. */
export const hasOpenAdmission = (periods: Iterable<Window>, now: DateTime.DateTime): boolean =>
  Option.isSome(
    Option.filter(
      currentOrLatestAdmissionPeriod(periods, now),
      (selection) => selection._tag === "Current",
    ),
  );
