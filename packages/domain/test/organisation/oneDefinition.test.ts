/**
 * Spec 0001, journey step 4: "the current semester" and "is admission open" have one answer
 * everywhere. Every caller reaches them through the package root, so the surface of the root and the
 * agreement of the rules behind it are what these tests pin.
 */
import { assert, describe, it } from "@effect/vitest";
import { Array as Arr, DateTime, Predicate } from "effect";

import * as domain from "../../src/index.ts";
import { hasOpenAdmission, isAdmissionOpen } from "../../src/index.ts";
import type { Semester } from "../../src/index.ts";
import {
  semesterForDate,
  semesterWindow,
} from "../../src/organisation/semester.ts";
import {
  YEARS,
  host,
  neighbours,
  probesOf,
  vaar,
} from "../support/calendar.ts";

/** What a caller may ask: the answers. */
const ANSWERS = [
  "currentSemester",
  "semesterJob",
  "isAdmissionOpen",
  "hasOpenAdmission",
  "currentOrLatestAdmissionPeriod",
] as const;

/** What the answers are built from: only the organisation module may use it. */
const WINDOW_ARITHMETIC = [
  "semesterForDate",
  "semesterWindow",
  "windowContains",
] as const;

const sameSemester = (left: Semester, right: Semester): boolean =>
  left.term === right.term && left.year === right.year;

describe("C2 one definition of now", () => {
  it("RULE-033/022/119: the package root exports the answers, not the window arithmetic they are built from", () => {
    for (const name of ANSWERS) {
      assert.isTrue(Predicate.hasProperty(domain, name), `${name} is exported`);
    }

    for (const name of WINDOW_ARITHMETIC) {
      assert.isFalse(
        Predicate.hasProperty(domain, name),
        `${name} stays inside the domain`
      );
    }
  });

  it("RULE-119: a window that is exactly a semester is open at an instant iff RULE-033 puts the instant in that semester", () => {
    for (const year of YEARS) {
      for (const probe of probesOf(year)) {
        for (const semester of neighbours(year)) {
          assert.strictEqual(
            isAdmissionOpen(semesterWindow(semester), probe),
            sameSemester(semesterForDate(probe), semester),
            `${semester.term} ${semester.year} at ${DateTime.formatIso(probe)}`
          );
        }
      }
    }
  });

  it("RULE-119: hasOpenAdmission is isAdmissionOpen over the department's periods, at every edge", () => {
    for (const year of YEARS) {
      const periods = [semesterWindow(vaar(year)), semesterWindow(host(year))];

      for (const probe of probesOf(year)) {
        assert.strictEqual(
          hasOpenAdmission(periods, probe),
          Arr.some(periods, (period) => isAdmissionOpen(period, probe)),
          DateTime.formatIso(probe)
        );
      }
    }
  });
});
