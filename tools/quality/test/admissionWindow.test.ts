/**
 * Spec 0009 F1: there is one window. `isAdmissionOpen` (`organisation/admission.ts`) is the only definition of when
 * admission is open, and `admissionState` is derived beside it; no other file compares an admission period's dates with
 * the clock. The scan reads the source of the packages and the web app for the three ways to restate the window: a
 * Drizzle comparison of the period's date columns, a SQL comparison of them, and a comparison of a period's `start` or
 * `end` with a clock value. A file that has one and is not listed fails, and so does a listing that no file needs, so
 * the list can only shrink.
 *
 * The two listed in the database are conditional writes: `extend` and `cancel` put the same half-open window in their
 * `WHERE`, so that the decision holds under a race between two commands (the domain reads the period, decides by
 * `admissionState`, and the write confirms that the period still has the state it was decided in). They agree with
 * `isAdmissionOpen` by `admission.postgres.test.ts`, which runs both at the boundaries; they are declared here and not
 * hidden.
 *
 * What it does not see: a comparison through a variable that does not hold `start` or `end` by name, or one written with
 * an operator on a date object's numeric value. It is the early signal at review time, as the other scans of this
 * directory are.
 */
import { assert, describe, it } from "@effect/vitest";
import { Array as Arr, Order } from "effect";

import {
  assertCleanScan,
  repositoryRoot,
  signFindings,
} from "./support/sources.ts";
import type { Sign, Source } from "./support/sources.ts";

const SIGNS = {
  "a Drizzle comparison of an admission period's date": {
    allowed: {
      "packages/db/src/repositories/organisation.ts":
        "extend (`ends_at > now`) and cancel (`starts_at > now`) are conditional writes: the window in the WHERE holds under a race",
    },
    pattern:
      /\b(?:gt|gte|lt|lte|between)\(\s*admissionPeriod\.(?:startsAt|endsAt)\b/u,
  },
  "a SQL comparison of an admission period's date": {
    allowed: {
      "packages/db/src/personalData/sql.ts":
        "the retention run's `PeriodEnd` trigger: when an application's period ended, plus the retention period (not the window)",
    },
    pattern: /col\("admission_period", "(?:starts_at|ends_at)"\)/u,
  },
  "a period's start or end compared with a clock value": {
    allowed: {
      "packages/domain/src/organisation/admission.ts":
        "the definition itself: `isAdmissionOpen`, `admissionState` and the pick of the current period",
    },
    pattern:
      /\b(?:isBefore|DateTime\.(?:isLessThan|isGreaterThan|isLessThanOrEqualTo|isGreaterThanOrEqualTo|isBetween))\w*\(\s*(?:now\s*,\s*\w+\.(?:start|end)|\w+\.(?:start|end)\s*,\s*now)\b/u,
  },
} satisfies Readonly<Record<string, Sign>>;

/** The source that the scan reads: the `src` of the packages and of the web app. */
const isSource = (path: string): boolean =>
  /^(?:packages|apps)\/[^/]+\/src\/.*\.tsx?$/u.test(path);

const { stale, unlisted } = signFindings(SIGNS);

describe("spec 0009 F1: one window", () => {
  it("control: a second comparison of the window is reported, the definition and the listed writes are not", () => {
    const sources: readonly Source[] = [
      {
        path: "apps/web/src/server/ny.ts",
        text: "const open = isBefore(now, period.end);",
      },
      {
        path: "packages/db/src/repositories/ny.ts",
        text: "where(gt(admissionPeriod.endsAt, now))",
      },
      {
        path: "packages/db/src/personalData/ny.ts",
        text: 'sql(col("admission_period", "ends_at"), "<", now)',
      },
      {
        path: "packages/domain/src/organisation/admission.ts",
        text: "return !isBefore(now, period.start);",
      },
      {
        path: "packages/domain/src/admission/ok.ts",
        text: "if (!DateTime.isGreaterThan(end, period.end)) {}",
      },
    ];

    assert.deepStrictEqual(Arr.sort(unlisted(sources), Order.String), [
      "apps/web/src/server/ny.ts has a period's start or end compared with a clock value",
      "packages/db/src/personalData/ny.ts has a SQL comparison of an admission period's date",
      "packages/db/src/repositories/ny.ts has a Drizzle comparison of an admission period's date",
    ]);
  });

  it("control: an allowance whose file no longer has the sign is reported", () => {
    assert.isAbove(
      stale([
        {
          path: "packages/domain/src/organisation/admission.ts",
          text: "export {};",
        },
      ]).length,
      0
    );
  });

  it.effect(
    "the real tree: every comparison is in a listed file, and every listing is used",
    () => assertCleanScan(repositoryRoot, isSource, { stale, unlisted })
  );
});
