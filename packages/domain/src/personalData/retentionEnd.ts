/**
 * When a declared row's retention ends (spec 0021, ADR 0014 answer 3). Every function here is plain: total over the
 * instants of 1980 to year 9999 and the durations the declarations use, deterministic, and explicit about the Oslo
 * calendar. Nothing reads the clock or a store. An adapter reads facts (an instant, a term and a year, a person's
 * memberships) and filters by what these functions give; it calculates no date.
 *
 * The oracle that this arithmetic is tested against is the stored arithmetic that it replaces: the database's own
 * calendar sum, its semester-end function and its view of a person's last activity, which spec 0021 removes from the
 * schema and keeps in the tests (`packages/db/test/support/retentionOracle.ts`).
 */
import { Array as Arr, DateTime, Option, Order } from "effect";

import { semesterWindow } from "../organisation/semester.ts";
import type { Semester, Term } from "../organisation/semester.ts";
import { OSLO, osloParts, osloWallClock } from "../shared/clock.ts";
import { Duration } from "./declaration.ts";
import type { Retention } from "./declaration.ts";

const HOUR = 60 * 60 * 1000;

const DAY = 24 * HOUR;

/** The first and last instants that the searches below look at (ms): 0001-01-01 and 9999-01-01. */
const EARLIEST = -62_135_596_800_000;
const LATEST = Date.UTC(9999, 0, 1);

/** The Oslo wall clock at `instant`, read as if it were UTC: calendar arithmetic on it has no zone and so no DST. */
const wallOf = (instant: DateTime.DateTime): DateTime.Utc => {
  const { day, hour, millisecond, minute, month, second, year } =
    osloParts(instant);

  return DateTime.makeUnsafe({
    day,
    hour,
    millisecond,
    minute,
    month,
    second,
    year,
  });
};

/** The calendar sum on a wall-clock reading: a month's end clamps (31 January plus a month is the end of February). */
const calendarSum = (wall: DateTime.Utc, duration: Duration): DateTime.Utc =>
  Duration.match(duration, {
    Days: ({ count }) => DateTime.add(wall, { days: count }),
    Months: ({ count }) => DateTime.add(wall, { months: count }),
    Years: ({ count }) => DateTime.add(wall, { years: count }),
  });

/**
 * The instant of an Oslo wall-clock reading. A time that does not exist (spring forward) moves forward by the gap; a time
 * that exists twice (fall back) is the second, standard-time occurrence. That is how the stored arithmetic that this
 * replaces read the clock (the test oracle); Effect's default, `compatible`, takes the first occurrence.
 */
const instantOf = (wall: DateTime.Utc): DateTime.Utc =>
  DateTime.toUtc(
    DateTime.makeZonedUnsafe(wall, {
      adjustForTimeZone: true,
      disambiguation: "later",
      timeZone: OSLO,
    })
  );

/** `instant` plus a declared duration in Oslo wall-clock time. */
export const afterDuration = (
  instant: DateTime.DateTime,
  duration: Duration
): DateTime.Utc => instantOf(calendarSum(wallOf(instant), duration));

/** The end of the semester: the first instant of the next period at Oslo midnight (RULE-022). */
export const semesterEnd = (semester: Semester): DateTime.Utc =>
  semesterWindow(semester).end;

/** The end of the Oslo calendar year of `at`: the association's fiscal year (Oslo midnight, 1 January of the next year). */
export const fiscalYearEnd = (at: DateTime.DateTime): DateTime.Utc =>
  osloWallClock({ day: 1, month: 1, year: osloParts(at).year + 1 });

/** What the end of a person's last activity is made of. */
export interface ActivityFacts {
  readonly createdAt: DateTime.Utc;
  /**
   * The latest end of an admin place that retention has deleted (`person.last_admin_place_end`, spec 0026): the place is
   * gone, its end still counts.
   */
  readonly keptPlaceEnd: Option.Option<DateTime.Utc>;
  /** The end semester of each membership. */
  readonly memberships: readonly Semester[];
  /** The `until` of each admin place. */
  readonly placeUntils: readonly DateTime.Utc[];
}

/**
 * The end of a person's last activity: the later of the end of their last membership, the end of their last admin place
 * (a valid place keeps a person active, and so does one that retention deleted: `keptPlaceEnd`), and their creation when
 * there is none of them.
 */
export const lastActivityEnd = (facts: ActivityFacts): DateTime.Utc => {
  const ends = [
    ...Arr.map(facts.memberships, semesterEnd),
    ...facts.placeUntils,
    ...Option.toArray(facts.keptPlaceEnd),
  ];

  return Arr.isReadonlyArrayNonEmpty(ends)
    ? Arr.max(ends, DateTime.Order)
    : facts.createdAt;
};

/** The period that applies to a row: the longer one while the row's consent is current. */
const durationOf = (
  retention: Pick<Retention, "longerWhile" | "period">,
  consentCurrent: boolean
): Duration =>
  retention.longerWhile !== undefined && consentCurrent
    ? retention.longerWhile.period.duration
    : retention.period.duration;

/** When a retention ends for a row whose period started at `start`. */
export const retentionEnd = (
  retention: Pick<Retention, "longerWhile" | "period">,
  start: DateTime.DateTime,
  consentCurrent: boolean
): DateTime.Utc => afterDuration(start, durationOf(retention, consentCurrent));

/** Whether a period of `duration` that started at `start` has ended at `now`. */
export const startIsDue = (
  start: DateTime.DateTime,
  duration: Duration,
  now: DateTime.Utc
): boolean => DateTime.isLessThanOrEqualTo(afterDuration(start, duration), now);

/** Whether a person's period has ended at `now`. */
export const lastActivityDue = (
  facts: ActivityFacts,
  retention: Pick<Retention, "longerWhile" | "period">,
  consentCurrent: boolean,
  now: DateTime.Utc
): boolean =>
  DateTime.isLessThanOrEqualTo(
    retentionEnd(retention, lastActivityEnd(facts), consentCurrent),
    now
  );

// ---------------------------------------------------------------- thresholds

/**
 * The greatest integer in `[low, high]` that `holds` accepts, given that it accepts a prefix of the range; `low - 1` when
 * it accepts none. A bisection of at most ~50 steps over the range of instants.
 */
const greatest = (
  holds: (candidate: number) => boolean,
  low: number,
  high: number
): number => {
  const narrow = (known: number, refused: number): number => {
    if (refused - known <= 1) {
      return known;
    }

    const middle = known + Math.floor((refused - known) / 2);

    return holds(middle) ? narrow(middle, refused) : narrow(known, middle);
  };

  return narrow(low - 1, high + 1);
};

/**
 * A half-open range of Oslo wall-clock readings: `from <= reading < to`. A reading is an instant's Oslo date and time,
 * labelled UTC (`wallOf`); the period of a start depends on it alone, so two instants that share a reading (the hour that
 * repeats) are decided alike.
 */
export interface WallRange {
  readonly from: DateTime.Utc;
  readonly to: DateTime.Utc;
}

const dayStart = (millis: number): number => Math.floor(millis / DAY) * DAY;

/** The days (counted from the epoch) from `first` to `last`, both included; none when `last` is before `first`. */
const daysFrom = (first: number, last: number): readonly number[] =>
  last < first ? [] : Arr.makeBy(last - first + 1, (index) => first + index);

/**
 * The Oslo wall-clock readings whose period has ended at `now`, as ranges: the exact set, with no estimate in it. A
 * start's period ends when the calendar sum of its reading, read back as an instant, is at most `now`. Month ends make the
 * sum not monotone in the reading (30 March 23:00 plus six months is 30 September 23:00, and 31 March 00:00 is 30
 * September 00:00), and the hour that repeats and the hour that does not exist make reading it back not monotone (the
 * two clauses of `instantOf`), so the set is not a prefix. It is built in two steps:
 *
 * 1. The target readings (`sum`) that end by `now`: at most `now` plus an hour end by it whatever the offset, more than
 *    `now` plus two hours never do, and in the hour between, one change of offset at most, so an interval at either end.
 * 2. The source readings that the calendar sum maps into them. The sum moves a day to a day (a month's end clamps, which
 *    puts up to four days on one) and keeps the time of the day, so the readings are the days that land before the
 *    target's day, whole, and the days that land on it, up to the time of the day.
 */
export const dueWallRanges = (
  now: DateTime.Utc,
  duration: Duration
): readonly WallRange[] => {
  const nowMillis = DateTime.toEpochMillis(now);
  const firstDay = Math.floor(EARLIEST / DAY);
  const lastDay = Math.floor(LATEST / DAY);

  /** The midnight of the day that the calendar sum puts day number `day` on. */
  const landing = (day: number): number =>
    DateTime.toEpochMillis(
      calendarSum(DateTime.makeUnsafe(day * DAY), duration)
    );

  const ends = (target: number): boolean =>
    DateTime.toEpochMillis(instantOf(DateTime.makeUnsafe(target))) <= nowMillis;

  const hourAfter = nowMillis + HOUR + 1;
  const twoHoursAfter = nowMillis + 2 * HOUR;
  const firstEnds = ends(hourAfter);
  const lastEnds = ends(twoHoursAfter);

  /** The last target reading, up to two hours after `now`, that ends by it. */
  const furthest = (): number => {
    if (!firstEnds) {
      return hourAfter - 1;
    }

    return lastEnds ? twoHoursAfter : greatest(ends, hourAfter, twoHoursAfter);
  };

  const reach = furthest();

  /** The target readings that end by `now`, as closed intervals of milliseconds. */
  const targets: readonly (readonly [number, number])[] = [
    [EARLIEST, reach],
    ...(!firstEnds && lastEnds
      ? [
          [
            greatest((target) => !ends(target), hourAfter, twoHoursAfter) + 1,
            twoHoursAfter,
          ] as const,
        ]
      : []),
  ];

  /** The source readings that the calendar sum puts inside the closed interval `[from, to]`. */
  const sources = ([from, to]: readonly [number, number]): WallRange[] => {
    const fromDay = dayStart(from);
    const toDay = dayStart(to);

    const firstLanding =
      greatest((day) => landing(day) < fromDay, firstDay, lastDay) + 1;

    const lastLanding = greatest(
      (day) => landing(day) <= toDay,
      firstDay,
      lastDay
    );

    const lastOnFrom = greatest(
      (day) => landing(day) <= fromDay,
      firstLanding,
      lastLanding
    );

    const firstOnTo =
      greatest((day) => landing(day) < toDay, firstLanding, lastLanding) + 1;

    const part = (day: number): WallRange[] => {
      const target = landing(day);
      const low = Math.max(0, from - target);
      const high = Math.min(DAY - 1, to - target);

      return low > high
        ? []
        : [
            {
              from: DateTime.makeUnsafe(day * DAY + low),
              to: DateTime.makeUnsafe(day * DAY + high + 1),
            },
          ];
    };

    const whole: WallRange[] =
      lastOnFrom + 1 <= firstOnTo - 1
        ? [
            {
              from: DateTime.makeUnsafe((lastOnFrom + 1) * DAY),
              to: DateTime.makeUnsafe(firstOnTo * DAY),
            },
          ]
        : [];

    return [
      ...Arr.flatMap(
        Arr.dedupe([
          ...daysFrom(firstLanding, lastOnFrom),
          ...daysFrom(firstOnTo, lastLanding),
        ]),
        part
      ),
      ...whole,
    ];
  };

  const sorted = Arr.sort(
    Arr.flatMap(targets, sources),
    Order.mapInput(DateTime.Order, (range: WallRange) => range.from)
  );

  const none: readonly WallRange[] = [];

  return Arr.reduce(sorted, none, (merged, range) => {
    const previous = Arr.last(merged);

    return Option.isSome(previous) &&
      DateTime.isGreaterThanOrEqualTo(previous.value.to, range.from)
      ? [
          ...Arr.dropRight(merged, 1),
          {
            from: previous.value.from,
            to: DateTime.max(previous.value.to, range.to),
          },
        ]
      : [...merged, range];
  });
};

/** Whether the Oslo wall-clock reading of `instant` is inside one of the ranges. */
export const inWallRanges = (
  ranges: readonly WallRange[],
  instant: DateTime.DateTime
): boolean => {
  const reading = wallOf(instant);

  return Arr.some(
    ranges,
    ({ from, to }) =>
      DateTime.isGreaterThanOrEqualTo(reading, from) &&
      DateTime.isLessThan(reading, to)
  );
};

/** The last year whose semester of `term` has ended, with its period, at `now` (1899 when none has). */
const lastDueSemesterYear = (
  term: Term,
  now: DateTime.Utc,
  duration: Duration
): number =>
  greatest(
    (year) => startIsDue(semesterEnd({ term, year }), duration, now),
    1900,
    9999
  );

/**
 * Per term, the last year of a semester whose period has ended at `now`: a row of that term and a year up to it is due. A
 * semester ends at Oslo midnight, where the clock never changes, so the end is monotone in the year.
 */
export const semesterDueYears = (
  now: DateTime.Utc,
  duration: Duration
): Readonly<Record<Term, number>> => ({
  HOST: lastDueSemesterYear("HOST", now, duration),
  VAR: lastDueSemesterYear("VAR", now, duration),
});

/** A date before this instant is in an Oslo calendar year whose fiscal year's period has ended at `now`. */
export const fiscalYearDueBefore = (
  now: DateTime.Utc,
  duration: Duration
): DateTime.Utc =>
  osloWallClock({
    day: 1,
    month: 1,
    year:
      greatest(
        (year) =>
          startIsDue(
            osloWallClock({ day: 1, month: 1, year: year + 1 }),
            duration,
            now
          ),
        1900,
        9999
      ) + 1,
  });
