/**
 * Generators and mistakes for the properties of spec 0021 (the domain's and the database's, which import them from
 * `@vektorprogrammet/domain/testing/retention`). Dates are not uniform: every year's two DST changes, the first and last
 * days of every month, and 29 February are anchors, and a generated instant is an anchor moved by up to three and a half
 * days in minutes (or, one in four, a uniform instant of 2000 to 2100), because the arithmetic breaks at those places and
 * a uniform instant would seldom be there. The mistakes (`inUtc`, `inEffectsDefault`, `negated`) are what a negative
 * control puts in place of the right arithmetic, so that the property is shown to be able to fail.
 */
import { Arbitrary, Array as Arr, DateTime, Match, Schema } from "effect";

import { Duration } from "../../src/personalData/declaration.ts";
import { afterDuration } from "../../src/personalData/retentionEnd.ts";
import { addOsloCalendar } from "../../src/shared/clock.ts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const FIRST_YEAR = 2000;
const LAST_YEAR = 2100;

/** 01:00 UTC on the last Sunday of the month: Oslo's clocks change then. */
const lastSundayAtOne = (year: number, month: number): number => {
  const last = DateTime.makeUnsafe(Date.UTC(year, month + 1, 0, 1));

  return (
    DateTime.toEpochMillis(last) - DateTime.getPartUtc(last, "weekDay") * DAY
  );
};

const years = Arr.makeBy(
  LAST_YEAR - FIRST_YEAR + 1,
  (index) => FIRST_YEAR + index
);

const months = Arr.makeBy(12, (month) => month);

/** The places where the arithmetic breaks, as instants. */
export const ANCHORS: readonly number[] = Arr.flatMap(years, (year) => [
  lastSundayAtOne(year, 2),
  lastSundayAtOne(year, 9),
  ...Arr.map(months, (month) => Date.UTC(year, month, 1)),
  ...Arr.map(months, (month) => Date.UTC(year, month + 1, 0)),
  Date.UTC(year, 1, 28),
  ...(year % 4 === 0 ? [Date.UTC(year, 1, 29)] : []),
]);

const Spot = Schema.Struct({
  anchor: Schema.Int.check(
    Schema.isBetween({ maximum: ANCHORS.length - 1, minimum: 0 })
  ),
  anchored: Schema.Int.check(Schema.isBetween({ maximum: 3, minimum: 0 })),
  free: Schema.Int.check(
    Schema.isBetween({
      maximum: Date.UTC(LAST_YEAR, 0, 1),
      minimum: Date.UTC(FIRST_YEAR, 0, 1),
    })
  ),
  minutes: Schema.Int.check(
    Schema.isBetween({ maximum: 5040, minimum: -5040 })
  ),
  seconds: Schema.Int.check(Schema.isBetween({ maximum: 59, minimum: 0 })),
});

const toInstant = (spot: typeof Spot.Type): DateTime.Utc =>
  DateTime.makeUnsafe(
    spot.anchored === 0
      ? spot.free
      : (ANCHORS[spot.anchor] ?? spot.free) +
          spot.minutes * MINUTE +
          spot.seconds * 1000
  );

/** An instant of 2000 to 2100, mostly near a place where the arithmetic breaks. */
export const instants: Arbitrary.Arbitrary<DateTime.Utc> = Arbitrary.map(
  Arbitrary.schema(Spot),
  toInstant
);

const Span = Schema.Struct({
  count: Schema.Int.check(Schema.isBetween({ maximum: 400, minimum: 0 })),
  kind: Schema.Literals(["Days", "Months", "Years"]),
});

const toDuration = (span: typeof Span.Type): Duration =>
  Match.value(span.kind).pipe(
    Match.when("Days", () => Duration.cases.Days.make({ count: span.count })),
    Match.when("Months", () =>
      Duration.cases.Months.make({ count: span.count % 121 })
    ),
    Match.when("Years", () =>
      Duration.cases.Years.make({ count: span.count % 31 })
    ),
    Match.exhaustive
  );

/** A declared duration: the days, months and years that the periods use, and more of each. */
export const durations: Arbitrary.Arbitrary<Duration> = Arbitrary.map(
  Arbitrary.schema(Span),
  toDuration
);

const Offset = Schema.Int.check(
  Schema.isBetween({ maximum: 4320, minimum: -4320 })
);

/**
 * A start, a duration and a `now` within three days of the start's end: the boundary, where an off-by-one or a mistake in
 * the zone changes the answer.
 */
export interface AtTheBoundary {
  readonly duration: Duration;
  readonly now: DateTime.Utc;
  readonly start: DateTime.Utc;
}

export const atTheBoundary: Arbitrary.Arbitrary<AtTheBoundary> = Arbitrary.map(
  Arbitrary.all({
    duration: durations,
    offset: Arbitrary.schema(Offset),
    start: instants,
  }),
  ({ duration, offset, start }) => ({
    duration,
    now: DateTime.add(afterDuration(start, duration), { minutes: offset }),
    start,
  })
);

/** The same, with `now` at the very millisecond that the period ends, or one before or after it. */
export const atTheEnd: Arbitrary.Arbitrary<AtTheBoundary> = Arbitrary.map(
  Arbitrary.all({
    duration: durations,
    offset: Arbitrary.schema(Schema.Literals([-1, 0, 1])),
    start: instants,
  }),
  ({ duration, offset, start }) => ({
    duration,
    now: DateTime.add(afterDuration(start, duration), { milliseconds: offset }),
    start,
  })
);

/** The same period, backwards: what a run that filtered by `start <= now - period` would use. */
export const negated = (duration: Duration): Duration =>
  Duration.match(duration, {
    Days: ({ count }): Duration => Duration.cases.Days.make({ count: -count }),
    Months: ({ count }): Duration =>
      Duration.cases.Months.make({ count: -count }),
    Years: ({ count }): Duration =>
      Duration.cases.Years.make({ count: -count }),
  });

const ClockChange = Schema.Struct({
  autumn: Schema.Boolean,
  endMinutes: Schema.Int.check(
    Schema.isBetween({ maximum: 150, minimum: -150 })
  ),
  nowMinutes: Schema.Int.check(
    Schema.isBetween({ maximum: 150, minimum: -150 })
  ),
  year: Schema.Int.check(
    Schema.isBetween({ maximum: LAST_YEAR, minimum: FIRST_YEAR })
  ),
});

/**
 * Where the end of the period lies within two and a half hours of a change of the clock (the hour that does not exist in
 * spring, the hour that repeats in autumn), and `now` within two and a half hours of that end: the cases in which reading
 * the repeated hour as its first occurrence changes the answer, which uniform instants and the anchors above reach once in
 * thousands of cases. The start is the end taken back by the period, on the Oslo calendar.
 */
export const atAClockChange: Arbitrary.Arbitrary<AtTheBoundary> = Arbitrary.map(
  Arbitrary.all({
    change: Arbitrary.schema(ClockChange),
    duration: durations,
  }),
  ({ change, duration }) => {
    const end = DateTime.add(
      DateTime.makeUnsafe(lastSundayAtOne(change.year, change.autumn ? 9 : 2)),
      { minutes: change.endMinutes }
    );

    const start = afterDuration(end, negated(duration));

    return {
      duration,
      now: DateTime.add(afterDuration(start, duration), {
        minutes: change.nowMinutes,
      }),
      start,
    };
  }
);

const minutesAround = [-1440, -90, -60, -1, 0, 1, 59, 60, 61, 90, 1440];

/** The instants around `start`, an hour and a day either side: the places where a boundary of a range can be wrong. */
export const around = (start: DateTime.Utc): readonly DateTime.Utc[] =>
  Arr.map(minutesAround, (minutes) => DateTime.add(start, { minutes }));

type Parts = Partial<DateTime.DateTime.PartsForMath>;

const partsOf = (duration: Duration): Parts =>
  Duration.match(duration, {
    Days: ({ count }): Parts => ({ days: count }),
    Months: ({ count }): Parts => ({ months: count }),
    Years: ({ count }): Parts => ({ years: count }),
  });

/** The mistake of a time zone: the same calendar sum on UTC instead of Oslo's wall clock. */
export const inUtc = (start: DateTime.Utc, duration: Duration): DateTime.Utc =>
  DateTime.add(start, partsOf(duration));

/** The mistake of the hour that repeats: Effect's default reading (the first occurrence), where the stored arithmetic reads the second. */
export const inEffectsDefault = (
  start: DateTime.Utc,
  duration: Duration
): DateTime.Utc => addOsloCalendar(start, partsOf(duration));
