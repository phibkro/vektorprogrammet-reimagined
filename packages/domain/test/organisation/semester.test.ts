import { assert, describe, it } from "@effect/vitest";
import { Array as Arr, DateTime, pipe } from "effect";

import {
  OSLO,
  isBetween,
  nextSemester,
  selectableYears,
  semesterLabel,
  sortNewestFirst,
} from "../../src/index.ts";
import {
  semesterForDate,
  semesterWindow,
  windowContains,
} from "../../src/organisation/semester.ts";
import {
  YEARS,
  host,
  neighbours,
  oslo,
  probesOf,
  vaar,
} from "../support/calendar.ts";

const lastSecond = (end: DateTime.Utc) =>
  DateTime.subtract(end, { seconds: 1 });

describe("C2 semester primitives", () => {
  it("RULE-033: the calendar month in Oslo decides Vår or Høst", () => {
    assert.deepStrictEqual(
      semesterForDate(oslo("2026-10-15T12:00:00")),
      host(2026)
    );
    assert.deepStrictEqual(
      semesterForDate(oslo("2026-07-31T12:00:00")),
      vaar(2026)
    );
    assert.deepStrictEqual(
      semesterForDate(oslo("2026-08-01T12:00:00")),
      host(2026)
    );
  });

  it("RULE-033: the boundary follows Oslo midnight, not UTC midnight", () => {
    // 2026-07-31T22:30Z is already 2026-08-01 00:30 in Oslo (CEST, +02:00).
    assert.deepStrictEqual(
      semesterForDate(DateTime.makeUnsafe("2026-07-31T22:30:00Z")),
      host(2026)
    );
    // 2026-12-31T23:30Z is 2027-01-01 00:30 in Oslo (CET, +01:00).
    assert.deepStrictEqual(
      semesterForDate(DateTime.makeUnsafe("2026-12-31T23:30:00Z")),
      vaar(2027)
    );
  });

  it("RULE-022: Vår and Høst windows are half-open at Oslo midnight", () => {
    const spring = semesterWindow(vaar(2026));
    const autumn = semesterWindow(host(2026));
    assert.strictEqual(
      DateTime.formatIso(spring.start),
      "2025-12-31T23:00:00.000Z"
    );
    assert.strictEqual(
      DateTime.formatIso(spring.end),
      "2026-07-31T22:00:00.000Z"
    );
    assert.strictEqual(
      DateTime.formatIso(autumn.start),
      "2026-07-31T22:00:00.000Z"
    );
    assert.strictEqual(
      DateTime.formatIso(autumn.end),
      "2026-12-31T23:00:00.000Z"
    );
  });

  it("RULE-022: 2026-07-31T23:59:59 Oslo is in Vår, 2026-08-01T00:00:00 Oslo is in Høst", () => {
    const lastLegacySecond = oslo("2026-07-31T23:59:59");
    const firstAutumnInstant = oslo("2026-08-01T00:00:00");
    assert.isTrue(windowContains(semesterWindow(vaar(2026)), lastLegacySecond));
    assert.isFalse(
      windowContains(semesterWindow(host(2026)), lastLegacySecond)
    );
    assert.isFalse(
      windowContains(semesterWindow(vaar(2026)), firstAutumnInstant)
    );
    assert.isTrue(
      windowContains(semesterWindow(host(2026)), firstAutumnInstant)
    );
  });

  it("RULE-022: the window spans the March DST change (start +01:00, end +02:00)", () => {
    const spring = semesterWindow(vaar(2026));
    // Oslo switches to summer time on 2026-03-29; both sides of the change are in Vår.
    assert.isTrue(windowContains(spring, oslo("2026-03-29T01:59:59")));
    assert.isTrue(windowContains(spring, oslo("2026-03-29T03:00:00")));
    assert.strictEqual(
      DateTime.formatIsoOffset(DateTime.setZone(spring.start, OSLO)),
      "2026-01-01T00:00:00.000+01:00"
    );
    assert.strictEqual(
      DateTime.formatIsoOffset(DateTime.setZone(spring.end, OSLO)),
      "2026-08-01T00:00:00.000+02:00"
    );
  });

  it("RULE-051: calendar boundaries equal the legacy inclusive 23:59:59 ends", () => {
    for (const year of [2012, 2024, 2026]) {
      const spring = semesterWindow(vaar(year));
      const autumn = semesterWindow(host(year));

      assert.strictEqual(
        DateTime.formatIso(spring.start),
        DateTime.formatIso(DateTime.toUtc(oslo(`${year}-01-01T00:00:00`)))
      );
      assert.strictEqual(
        DateTime.formatIso(lastSecond(spring.end)),
        DateTime.formatIso(DateTime.toUtc(oslo(`${year}-07-31T23:59:59`)))
      );
      assert.strictEqual(
        DateTime.formatIso(autumn.start),
        DateTime.formatIso(DateTime.toUtc(oslo(`${year}-08-01T00:00:00`)))
      );
      assert.strictEqual(
        DateTime.formatIso(lastSecond(autumn.end)),
        DateTime.formatIso(DateTime.toUtc(oslo(`${year}-12-31T23:59:59`)))
      );
      // The sub-second gap after 23:59:59 that legacy left uncovered now belongs to Vår.
      assert.isTrue(
        windowContains(
          spring,
          DateTime.add(lastSecond(spring.end), { milliseconds: 500 })
        )
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
    assert.deepStrictEqual(pipe(sorted, Arr.map(semesterLabel)), [
      "Høst 2026",
      "Vår 2026",
      "Høst 2025",
    ]);
  });

  it("RULE-190: selectable years run from next year down to 2012", () => {
    const years = selectableYears(oslo("2026-10-15T12:00:00"));
    assert.strictEqual(years[0], 2027);
    assert.strictEqual(years[1], 2026);
    assert.strictEqual(years.at(-1), 2012);
    assert.strictEqual(years.length, 2027 - 2012 + 1);
  });

  it("RULE-190: the year is the Oslo year (New Year's Eve 23:30 UTC is already next year)", () => {
    assert.strictEqual(
      selectableYears(DateTime.makeUnsafe("2026-12-31T23:30:00Z"))[0],
      2028
    );
  });
});

const epoch = DateTime.toEpochMillis;

const HOUR = 3_600_000;

describe("C2 semester boundaries across clock changes", () => {
  it("RULE-022: Vår 2026 is 5087 hours: the spring clock change makes it an hour shorter than 212 days", () => {
    const spring = semesterWindow(vaar(2026));

    assert.strictEqual(
      (epoch(spring.end) - epoch(spring.start)) / HOUR,
      212 * 24 - 1
    );
    assert.strictEqual(
      DateTime.formatIsoOffset(DateTime.setZone(spring.start, OSLO)),
      "2026-01-01T00:00:00.000+01:00"
    );
  });

  it("RULE-022: Høst 2026 spans the October clock change: start +02:00, end +01:00, both 02:30s inside, 3673 hours long", () => {
    const autumn = semesterWindow(host(2026));
    // Oslo returns to winter time on 2026-10-25 at 03:00 CEST: 02:30 happens twice.
    const firstTwoThirty = DateTime.makeUnsafe("2026-10-25T00:30:00Z");
    const secondTwoThirty = DateTime.makeUnsafe("2026-10-25T01:30:00Z");

    assert.strictEqual(
      DateTime.formatIsoOffset(DateTime.setZone(autumn.start, OSLO)),
      "2026-08-01T00:00:00.000+02:00"
    );
    assert.strictEqual(
      DateTime.formatIsoOffset(DateTime.setZone(autumn.end, OSLO)),
      "2027-01-01T00:00:00.000+01:00"
    );
    assert.strictEqual(
      (epoch(autumn.end) - epoch(autumn.start)) / HOUR,
      153 * 24 + 1
    );
    assert.isTrue(windowContains(autumn, firstTwoThirty));
    assert.isTrue(windowContains(autumn, secondTwoThirty));
    assert.deepStrictEqual(semesterForDate(firstTwoThirty), host(2026));
    assert.deepStrictEqual(semesterForDate(secondTwoThirty), host(2026));
  });

  it("RULE-022: 2026-07-31T23:59:59 Oslo is Vår 2026 and 2026-08-01T00:00:00 Oslo is Høst 2026, by the window and by the calendar", () => {
    const lastLegacySecond = oslo("2026-07-31T23:59:59");
    const firstAutumnInstant = oslo("2026-08-01T00:00:00");

    assert.deepStrictEqual(semesterForDate(lastLegacySecond), vaar(2026));
    assert.deepStrictEqual(semesterForDate(firstAutumnInstant), host(2026));
    assert.strictEqual(
      epoch(firstAutumnInstant) - epoch(lastLegacySecond),
      1000
    );
  });

  it("RULE-022: each window ends exactly where the next begins, in every year from 2012 to 2040", () => {
    for (const year of YEARS) {
      assert.strictEqual(
        epoch(semesterWindow(vaar(year)).end),
        epoch(semesterWindow(host(year)).start),
        `Vår ${year} ends where Høst ${year} begins`
      );
      assert.strictEqual(
        epoch(semesterWindow(host(year)).end),
        epoch(semesterWindow(vaar(year + 1)).start),
        `Høst ${year} ends where Vår ${year + 1} begins`
      );
    }
  });

  it("RULE-022: every window edge and every clock change from 2012 to 2040, to the millisecond, lies in exactly one semester, and RULE-033 names that one", () => {
    for (const year of YEARS) {
      for (const probe of probesOf(year)) {
        const holders = Arr.filter(neighbours(year), (semester) =>
          windowContains(semesterWindow(semester), probe)
        );

        assert.strictEqual(holders.length, 1, DateTime.formatIso(probe));
        assert.deepStrictEqual(
          holders[0],
          semesterForDate(probe),
          DateTime.formatIso(probe)
        );
      }
    }
  });
});

describe("C2 semester succession", () => {
  it("RULE-050: Vår Y is followed by Høst Y, Høst Y by Vår Y+1", () => {
    assert.deepStrictEqual(nextSemester(vaar(2026)), host(2026));
    assert.deepStrictEqual(nextSemester(host(2026)), vaar(2027));
  });

  it("RULE-050: the successor is the next one in the newest-first order, so no semester lies between", () => {
    const all = Arr.flatMap(YEARS, (year) => [vaar(year), host(year)]);
    const newestFirst = sortNewestFirst(all);

    for (const [index, semester] of newestFirst.entries()) {
      const following = newestFirst[index - 1];

      if (following !== undefined) {
        assert.deepStrictEqual(nextSemester(semester), following);
      }
    }
  });
});
