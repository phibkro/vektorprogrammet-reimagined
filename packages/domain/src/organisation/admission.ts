/**
 * C2 admission-period decisions (RULE-015, RULE-119 replacements, operator
 * 2026-10-15). Admission periods are stored data in Phase 3; Phase 1 ships the
 * decisions as pure functions over typed periods. One definition serves every
 * caller (public page, filters, application form).
 */
import type { DateTime } from "effect";
import { Array as Arr, Data, Option, pipe, Predicate, Schema } from "effect";

import { isBefore } from "../shared/clock.ts";
import { AdmissionPeriodId, DepartmentId, SemesterId } from "../shared/ids.ts";
import { Semester, windowContains } from "./semester.ts";
import type { Window } from "./semester.ts";

export const AdmissionPeriod = Schema.Struct({
  departmentId: DepartmentId,
  end: Schema.DateTimeUtc,
  semester: Semester,
  start: Schema.DateTimeUtc,
}).check(
  Schema.makeFilter((period) =>
    isBefore(period.start, period.end)
      ? true
      : { issue: "Slutt må være etter start.", path: ["end"] }
  )
);

export type AdmissionPeriod = typeof AdmissionPeriod.Type;

/** RULE-119: admission is open iff `start <= now < end` (the end instant is closed). */
export const isAdmissionOpen = (
  period: Window,
  now: DateTime.DateTime
): boolean => windowContains(period, now);

/** Where a period is in its life; never stored: it is a function of the dates and the clock (spec 0009). */
export type AdmissionState = "Closed" | "Open" | "Scheduled";

/**
 * The state of a period at `now`, from the one window rule: Open exactly when `isAdmissionOpen`, Scheduled before the
 * start, Closed from the end on (the end instant is closed).
 */
export const admissionState = (
  period: Window,
  now: DateTime.DateTime
): AdmissionState => {
  if (isAdmissionOpen(period, now)) {
    return "Open";
  }

  return isBefore(now, period.start) ? "Scheduled" : "Closed";
};

/** A stored period: the one that `AdmissionPeriod` describes, with the ids that the panel and the commands name. */
export const StoredAdmissionPeriod = Schema.Struct({
  ...AdmissionPeriod.fields,
  id: AdmissionPeriodId,
  semesterId: SemesterId,
});

export type StoredAdmissionPeriod = typeof StoredAdmissionPeriod.Type;

/** What a new period is stored with. */
export interface AdmissionPeriodDraft {
  readonly departmentId: DepartmentId;
  readonly end: DateTime.Utc;
  readonly semesterId: SemesterId;
  readonly start: DateTime.Utc;
}

export type AdmissionSelection<P extends Window> = Data.TaggedEnum<{
  Current: { readonly period: P };
  Latest: { readonly period: P };
}>;

interface AdmissionSelectionDefinition extends Data.TaggedEnum.WithGenerics<1> {
  readonly taggedEnum: AdmissionSelection<this["A"] & Window>;
}

const admissionSelection = Data.taggedEnum<AdmissionSelectionDefinition>();

const latestStart = <P extends Window>(
  periods: readonly P[]
): Option.Option<P> =>
  Arr.reduce(periods, Option.none<P>(), (best, period) =>
    Option.isSome(best) && !isBefore(best.value.start, period.start)
      ? best
      : Option.some(period)
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
  now: DateTime.DateTime
): Option.Option<AdmissionSelection<P>> => {
  const all = [...periods];

  const current = latestStart(
    pipe(
      all,
      Arr.filter((period) => isAdmissionOpen(period, now))
    )
  );

  if (Option.isSome(current)) {
    return Option.some(admissionSelection.Current({ period: current.value }));
  }

  return Option.map(
    latestStart(
      pipe(
        all,
        Arr.filter((period) => !isBefore(now, period.start))
      )
    ),
    (period): AdmissionSelection<P> => admissionSelection.Latest({ period })
  );
};

/** The period that is open now, with whatever else it carries; none when no window contains `now` (RULE-119). */
export const openAdmissionPeriod = <P extends Window>(
  periods: Iterable<P>,
  now: DateTime.DateTime
): Option.Option<P> =>
  Option.flatMap(currentOrLatestAdmissionPeriod(periods, now), (selection) =>
    Predicate.isTagged(selection, "Current")
      ? Option.some(selection.period)
      : Option.none()
  );

/** "Is admission open for this department now": true iff a current period exists. */
export const hasOpenAdmission = (
  periods: Iterable<Window>,
  now: DateTime.DateTime
): boolean => Option.isSome(openAdmissionPeriod(periods, now));
