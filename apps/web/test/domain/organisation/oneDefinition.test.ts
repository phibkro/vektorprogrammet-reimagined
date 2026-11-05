/**
 * Spec 0001, journey step 4: "the current semester" and "is admission open" have one answer
 * everywhere. These tests pin the agreement of the calendar rules.
 */
import { assert, describe, it } from "@effect/vitest";
import { Array as Arr, DateTime } from "effect";

import {
  hasOpenAdmission,
  isAdmissionOpen,
} from "../../../src/features/organisation/domain/admission.ts";
import type { Semester } from "../../../src/features/organisation/domain/semester.ts";
import {
  semesterForDate,
  semesterWindow,
} from "../../../src/features/organisation/domain/semester.ts";
import {
  YEARS,
  host,
  neighbours,
  probesOf,
  vaar,
} from "../support/calendar.ts";

const sameSemester = (left: Semester, right: Semester): boolean =>
  left.term === right.term && left.year === right.year;

describe("C2 one definition of now", () => {
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
