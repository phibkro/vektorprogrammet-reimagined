/**
 * Spec 0027 D5 and F3's control: the type of a released cell cannot carry a count below the minimum. A published value is
 * a `ReleasedCount`, which only `releasedCount` makes (and only `release` calls it: `impactRawCounts.test.ts`), so a plain
 * number is not assignable to it and `Released.cases.Published.make({ value: 3 })` does not compile. Widening the field
 * back to a plain count fails these assertions at type-check time, as `vp check` runs them; they need no suppression.
 */
import { describe, it } from "@effect/vitest";
import { expectTypeOf } from "vite-plus/test";

import type { Released, ReleasedCount } from "../../src/impact/measures.ts";

type Published = Extract<Released, { readonly _tag: "Published" }>;

type Hidden = Extract<Released, { readonly _tag: "Suppressed" }>;

type Unavailable = Extract<Released, { readonly _tag: "Unavailable" }>;

describe("spec 0027 D5: a published count is a ReleasedCount", () => {
  it("the value of a published cell is the brand, and a plain number is not assignable to it", () => {
    expectTypeOf<Published["value"]>().toEqualTypeOf<ReleasedCount>();
    expectTypeOf<number>().not.toExtend<Published["value"]>();
    expectTypeOf<ReleasedCount>().toExtend<number>();
  });

  it("a hidden cell has no value at all, and an unavailable one only its reason", () => {
    expectTypeOf<Published>().toHaveProperty("value");
    expectTypeOf<Hidden>().not.toHaveProperty("value");
    expectTypeOf<Unavailable>().not.toHaveProperty("value");
  });
});
