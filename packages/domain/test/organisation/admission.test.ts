import { assert, describe, it } from "@effect/vitest";
import { DateTime, Option, Predicate, Schema } from "effect";

import {
  AdmissionPeriod,
  DepartmentId,
  currentOrLatestAdmissionPeriod,
  hasOpenAdmission,
  isAdmissionOpen,
} from "../../src/index.ts";

const utc = (iso: string) => DateTime.makeUnsafe(iso);

const period = (name: string, start: string, end: string) => ({
  end: utc(end),
  name,
  start: utc(start),
});

const spring = period(
  "Vår 2026",
  "2026-01-10T08:00:00Z",
  "2026-01-31T22:00:00Z"
);

const autumn = period(
  "Høst 2026",
  "2026-08-20T08:00:00Z",
  "2026-09-05T22:00:00Z"
);

const nextSpring = period(
  "Vår 2027",
  "2027-01-10T08:00:00Z",
  "2027-01-31T22:00:00Z"
);

describe("C2 admission decisions", () => {
  it("RULE-119: open iff start <= now < end (half-open; the end instant is closed)", () => {
    assert.isFalse(isAdmissionOpen(spring, utc("2026-01-10T07:59:59.999Z")));
    assert.isTrue(isAdmissionOpen(spring, utc("2026-01-10T08:00:00Z")));
    assert.isTrue(isAdmissionOpen(spring, utc("2026-01-31T21:59:59.999Z")));
    assert.isFalse(isAdmissionOpen(spring, utc("2026-01-31T22:00:00Z")));
  });

  it("RULE-119: one definition serves every caller", () => {
    const now = utc("2026-08-25T12:00:00Z");
    assert.strictEqual(
      hasOpenAdmission([spring, autumn], now),
      isAdmissionOpen(autumn, now)
    );
    assert.isFalse(hasOpenAdmission([spring, autumn], autumn.end));
  });

  it("RULE-015: CURRENT is the period whose window contains now", () => {
    const selection = currentOrLatestAdmissionPeriod(
      [spring, autumn, nextSpring],
      utc("2026-08-25T12:00:00Z")
    );

    assert.deepStrictEqual(
      Option.map(selection, (s) => [s._tag, s.period.name]),
      Option.some(["Current", "Høst 2026"])
    );
  });

  it("RULE-015: otherwise LATEST is the most recent start already in the past", () => {
    const selection = currentOrLatestAdmissionPeriod(
      [autumn, spring, nextSpring],
      utc("2026-10-15T12:00:00Z")
    );

    assert.deepStrictEqual(
      Option.map(selection, (s) => [s._tag, s.period.name]),
      Option.some(["Latest", "Høst 2026"])
    );
  });

  it("RULE-015: a period that has not started is never current or latest", () => {
    // Legacy defect: a Vår 2027 period created early became "latest" before it began.
    const selection = currentOrLatestAdmissionPeriod(
      [nextSpring, spring],
      utc("2026-03-01T12:00:00Z")
    );

    assert.deepStrictEqual(
      Option.map(selection, (s) => s.period.name),
      Option.some("Vår 2026")
    );
    assert.isTrue(
      Option.isNone(
        currentOrLatestAdmissionPeriod(
          [nextSpring],
          utc("2026-03-01T12:00:00Z")
        )
      )
    );
  });

  it("RULE-015: overlapping open windows resolve deterministically to the latest start", () => {
    const early = period(
      "early",
      "2026-01-01T00:00:00Z",
      "2026-03-01T00:00:00Z"
    );

    const late = period("late", "2026-02-01T00:00:00Z", "2026-02-15T00:00:00Z");
    const now = utc("2026-02-10T00:00:00Z");

    for (const order of [
      [early, late],
      [late, early],
    ]) {
      assert.deepStrictEqual(
        Option.map(
          currentOrLatestAdmissionPeriod(order, now),
          (s) => s.period.name
        ),
        Option.some("late")
      );
    }
  });

  it("RULE-119: a stored admission period must end after it starts", () => {
    const decode = Schema.decodeUnknownExit(AdmissionPeriod);

    const base = {
      departmentId: DepartmentId.make(1),
      semester: { term: "VAR", year: 2026 },
      start: utc("2026-01-10T08:00:00Z"),
    };

    assert.isTrue(
      Predicate.isTagged(
        decode({ ...base, end: utc("2026-01-31T22:00:00Z") }),
        "Success"
      )
    );
    assert.isTrue(
      Predicate.isTagged(decode({ ...base, end: base.start }), "Failure")
    );
  });
});
