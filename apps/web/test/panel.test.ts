/**
 * RULE-033 exercised through web code: the panel's server-side view program answers the semester of the Oslo
 * calendar month, and the read writes no row (spec 0003). The rule's domain-level proof lives in
 * `packages/domain`. The control panel's content pages (static text, articles, sponsors) retired with spec
 * 0005: the CMS owns that content, so RULE-296 (who may edit a static text) is the CMS's role model, RULE-133
 * (rich text on a public page) is `portableTextView.test.tsx`, and the web upload path (RULE-130) went with the
 * forms that used it; `packages/domain/test/files` still proves the typing rule.
 */
import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect } from "effect";
import { TestClock } from "effect/testing";

import { dashboardView } from "../src/server/panel";
import { makeTables, memoryLayer } from "./support/memory";
import { ADMIN } from "./support/principals";
// ---------------------------------------------------------------- RULE-033

/** The RULE-033 cut-over: January–July is Vår, August–December is Høst. */
const SEMESTER_BY_OSLO_DATE = [
  {
    at: "2026-07-31T23:59:00+02:00",
    expected: { label: "Vår 2026", term: "VAR", year: 2026 },
  },
  {
    at: "2026-08-01T00:00:00+02:00",
    expected: { label: "Høst 2026", term: "HOST", year: 2026 },
  },
  {
    at: "2026-10-15T12:00:00+02:00",
    expected: { label: "Høst 2026", term: "HOST", year: 2026 },
  },
  {
    at: "2027-01-01T00:00:00+01:00",
    expected: { label: "Vår 2027", term: "VAR", year: 2027 },
  },
] as const;

describe("C1/C2 semesters through the panel", () => {
  it.effect(
    "RULE-033: the panel's current semester follows the Oslo calendar month, and the read writes no row (spec 0003)",
    () =>
      Effect.gen(function* currentSemesterEffect() {
        for (const { at, expected } of SEMESTER_BY_OSLO_DATE) {
          yield* TestClock.setTime(
            DateTime.toEpochMillis(DateTime.makeUnsafe(at))
          );

          const tables = makeTables();

          const view = yield* dashboardView.pipe(
            Effect.provide(memoryLayer(tables, ADMIN))
          );

          assert.strictEqual(view.currentSemester, expected.label, at);
          assert.deepStrictEqual(tables.semesters, [], at);
        }
      })
  );
});
