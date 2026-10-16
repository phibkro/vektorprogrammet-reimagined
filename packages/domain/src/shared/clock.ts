/**
 * Calendar helpers. Every calendar computation runs in Europe/Oslo; instants are
 * stored and passed around as UTC `DateTime` values. The current time always
 * comes from Effect's `Clock` (`DateTime.now`), so tests control it with
 * `TestClock`; the functions here are pure and take the instant as an argument.
 */
import { DateTime } from "effect";

/** The organisation's calendar zone (spec 0001: "computes in Europe/Oslo explicitly"). */
export const OSLO: DateTime.TimeZone.Named =
  DateTime.zoneMakeNamedUnsafe("Europe/Oslo");

/** Wall-clock parts of an instant in Europe/Oslo. */
export const osloParts = (
  instant: DateTime.DateTime
): DateTime.DateTime.PartsWithWeekday =>
  DateTime.toParts(DateTime.setZone(instant, OSLO));

/** The Oslo calendar year of an instant. */
export const osloYear = (instant: DateTime.DateTime): number =>
  osloParts(instant).year;

/**
 * The UTC instant of an Oslo wall-clock time. Missing parts default to the
 * start of the unit (month 1, day 1, 00:00:00.000).
 */
export const osloWallClock = (parts: {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour?: number;
  readonly minute?: number;
  readonly second?: number;
}): DateTime.Utc =>
  DateTime.toUtc(
    DateTime.makeZonedUnsafe(
      {
        day: parts.day,
        hour: parts.hour ?? 0,
        millisecond: 0,
        minute: parts.minute ?? 0,
        month: parts.month,
        second: parts.second ?? 0,
        year: parts.year,
      },
      { adjustForTimeZone: true, timeZone: OSLO }
    )
  );

/** Calendar arithmetic in Oslo (a "week" or "30 days" follows Oslo wall-clock time across DST). */
export const addOsloCalendar = (
  instant: DateTime.DateTime,
  parts: Partial<DateTime.DateTime.PartsForMath>
): DateTime.Utc =>
  DateTime.toUtc(DateTime.add(DateTime.setZone(instant, OSLO), parts));

/** `a < b` on instants. */
export const isBefore = (a: DateTime.DateTime, b: DateTime.DateTime): boolean =>
  DateTime.toEpochMillis(a) < DateTime.toEpochMillis(b);
