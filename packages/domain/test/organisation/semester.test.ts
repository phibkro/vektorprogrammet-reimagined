import { assert, describe, it } from "@effect/vitest";
import { DateTime } from "effect";
import {
  OSLO,
  isBetween,
  selectableYears,
  semesterForDate,
  semesterLabel,
  semesterWindow,
  sortNewestFirst,
  windowContains,
  type Semester,
} from "../../src/index.ts";

/** An Oslo wall-clock time as an instant. */
const oslo = (local: string): DateTime.Zoned =>
  DateTime.makeZonedUnsafe(local, { timeZone: "Europe/Oslo", adjustForTimeZone: true });

const vaar = (year: number): Semester => ({ term: "VAR", year });
const host = (year: number): Semester => ({ term: "HOST", year });

describe("C2 semester primitives", () => {
  it("RULE-033: the calendar month in Oslo decides Vår or Høst", () => {
    assert.deepStrictEqual(semesterForDate(oslo("2026-10-15T12:00:00")), host(2026));
    assert.deepStrictEqual(semesterForDate(oslo("2026-07-31T12:00:00")), vaar(2026));
    assert.deepStrictEqual(semesterForDate(oslo("2026-08-01T12:00:00")), host(2026));
  });

  it("RULE-033: the boundary follows Oslo midnight, not UTC midnight", () => {
    // 2026-07-31T22:30Z is already 2026-08-01 00:30 in Oslo (CEST, +02:00).
    assert.deepStrictEqual(
      semesterForDate(DateTime.makeUnsafe("2026-07-31T22:30:00Z")),
      host(2026),
    );
    // 2026-12-31T23:30Z is 2027-01-01 00:30 in Oslo (CET, +01:00).
    assert.deepStrictEqual(
      semesterForDate(DateTime.makeUnsafe("2026-12-31T23:30:00Z")),
      vaar(2027),
    );
  });

  it("RULE-022: Vår and Høst windows are half-open at Oslo midnight", () => {
    const spring = semesterWindow(vaar(2026));
    const autumn = semesterWindow(host(2026));
    assert.strictEqual(DateTime.formatIso(spring.start), "2025-12-31T23:00:00.000Z");
    assert.strictEqual(DateTime.formatIso(spring.end), "2026-07-31T22:00:00.000Z");
    assert.strictEqual(DateTime.formatIso(autumn.start), "2026-07-31T22:00:00.000Z");
    assert.strictEqual(DateTime.formatIso(autumn.end), "2026-12-31T23:00:00.000Z");
  });

  it("RULE-022: 2026-07-31T23:59:59 Oslo is in Vår, 2026-08-01T00:00:00 Oslo is in Høst", () => {
    const lastLegacySecond = oslo("2026-07-31T23:59:59");
    const firstAutumnInstant = oslo("2026-08-01T00:00:00");
    assert.isTrue(windowContains(semesterWindow(vaar(2026)), lastLegacySecond));
    assert.isFalse(windowContains(semesterWindow(host(2026)), lastLegacySecond));
    assert.isFalse(windowContains(semesterWindow(vaar(2026)), firstAutumnInstant));
    assert.isTrue(windowContains(semesterWindow(host(2026)), firstAutumnInstant));
  });

  it("RULE-022: the window spans the March DST change (start +01:00, end +02:00)", () => {
    const spring = semesterWindow(vaar(2026));
    // Oslo switches to summer time on 2026-03-29; both sides of the change are in Vår.
    assert.isTrue(windowContains(spring, oslo("2026-03-29T01:59:59")));
    assert.isTrue(windowContains(spring, oslo("2026-03-29T03:00:00")));
    assert.strictEqual(
      DateTime.formatIsoOffset(DateTime.setZone(spring.start, OSLO)),
      "2026-01-01T00:00:00.000+01:00",
    );
    assert.strictEqual(
      DateTime.formatIsoOffset(DateTime.setZone(spring.end, OSLO)),
      "2026-08-01T00:00:00.000+02:00",
    );
  });

  it("RULE-051: calendar boundaries equal the legacy inclusive 23:59:59 ends", () => {
    for (const year of [2012, 2024, 2026]) {
      const spring = semesterWindow(vaar(year));
      const autumn = semesterWindow(host(year));
      const lastSecond = (end: DateTime.Utc) => DateTime.subtract(end, { seconds: 1 });
      assert.strictEqual(
        DateTime.formatIso(spring.start),
        DateTime.formatIso(DateTime.toUtc(oslo(`${year}-01-01T00:00:00`))),
      );
      assert.strictEqual(
        DateTime.formatIso(lastSecond(spring.end)),
        DateTime.formatIso(DateTime.toUtc(oslo(`${year}-07-31T23:59:59`))),
      );
      assert.strictEqual(
        DateTime.formatIso(autumn.start),
        DateTime.formatIso(DateTime.toUtc(oslo(`${year}-08-01T00:00:00`))),
      );
      assert.strictEqual(
        DateTime.formatIso(lastSecond(autumn.end)),
        DateTime.formatIso(DateTime.toUtc(oslo(`${year}-12-31T23:59:59`))),
      );
      // The sub-second gap after 23:59:59 that legacy left uncovered now belongs to Vår.
      assert.isTrue(
        windowContains(spring, DateTime.add(lastSecond(spring.end), { milliseconds: 500 })),
      );
    }
  });

  it("RULE-050: isBetween includes both bounds; Vår before Høst within a year", () => {
    assert.isTrue(isBetween(vaar(2026), host(2025), vaar(2026)));
    assert.isTrue(isBetween(host(2025), host(2025), vaar(2026)));
    assert.isFalse(isBetween(host(2026), host(2025), vaar(2026)));
    assert.isFalse(isBetween(vaar(2025), host(2025), vaar(2026)));
  });

  it("RULE-050: a missing (null) bound is open-ended", () => {
    assert.isTrue(isBetween(host(2026), host(2025), null));
    assert.isTrue(isBetween(vaar(2012), null, vaar(2026)));
    assert.isTrue(isBetween(vaar(1999), null, null));
    assert.isFalse(isBetween(vaar(2025), host(2025), null));
  });

  it("RULE-050: same-year comparison works on numeric years (legacy int-vs-string defect)", () => {
    // Legacy compared year with ===, so an int 2026 and a string "2026" were "different years".
    assert.isFalse(isBetween(host(2026), vaar(2026), vaar(2026)));
    assert.isTrue(isBetween(vaar(2026), vaar(2026), host(2026)));
  });

  it("RULE-084: semester lists are ordered newest first", () => {
    const sorted = sortNewestFirst([vaar(2026), host(2026), host(2025)]);
    assert.deepStrictEqual(sorted.map(semesterLabel), ["Høst 2026", "Vår 2026", "Høst 2025"]);
  });

  it("RULE-190: selectable years run from next year down to 2012", () => {
    const years = selectableYears(oslo("2026-10-15T12:00:00"));
    assert.strictEqual(years[0], 2027);
    assert.strictEqual(years[1], 2026);
    assert.strictEqual(years.at(-1), 2012);
    assert.strictEqual(years.length, 2027 - 2012 + 1);
  });

  it("RULE-190: the year is the Oslo year (New Year's Eve 23:30 UTC is already next year)", () => {
    assert.strictEqual(selectableYears(DateTime.makeUnsafe("2026-12-31T23:30:00Z"))[0], 2028);
  });
});
