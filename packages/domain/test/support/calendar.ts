/**
 * Calendar fixtures shared by the semester and admission tests: Oslo wall-clock instants, semesters,
 * and the instants where a wrong boundary would show.
 */
import { Array as Arr, DateTime } from "effect";

import type { Semester } from "../../src/index.ts";
import { semesterWindow } from "../../src/organisation/semester.ts";

/** An Oslo wall-clock time as an instant. */
export const oslo = (local: string): DateTime.Zoned =>
  DateTime.makeZonedUnsafe(local, {
    adjustForTimeZone: true,
    timeZone: "Europe/Oslo",
  });

export const vaar = (year: number): Semester => ({ term: "VAR", year });

export const host = (year: number): Semester => ({ term: "HOST", year });

/** The years the boundary tests walk: legacy's first selectable year to well past the next ones. */
export const YEARS = Arr.range(2012, 2040);

/**
 * The EU summer-time rule, written down independently of the time-zone database the code under test
 * uses: clocks change on the last Sunday of March and of October at 01:00 UTC.
 */
const euClockChange = (year: number, month: 3 | 10): DateTime.Utc => {
  const lastDay = DateTime.makeUnsafe({ day: 31, hour: 1, month, year });

  return DateTime.subtract(lastDay, {
    days: DateTime.toPartsUtc(lastDay).weekDay,
  });
};

/** Every instant where a wrong boundary would show: window edges and clock changes, to the millisecond. */
export const probesOf = (year: number): readonly DateTime.Utc[] => {
  const spring = semesterWindow(vaar(year));
  const autumn = semesterWindow(host(year));

  const anchors = [
    spring.start,
    spring.end,
    autumn.start,
    autumn.end,
    euClockChange(year, 3),
    euClockChange(year, 10),
  ];

  return Arr.flatMap(anchors, (anchor) =>
    Arr.map([-3_600_000, -1, 0, 1, 3_600_000], (milliseconds) =>
      DateTime.add(anchor, { milliseconds })
    )
  );
};

/** The semesters one of whose windows can hold a probe of `year`. */
export const neighbours = (year: number): readonly Semester[] => [
  vaar(year - 1),
  host(year - 1),
  vaar(year),
  host(year),
  vaar(year + 1),
  host(year + 1),
];
