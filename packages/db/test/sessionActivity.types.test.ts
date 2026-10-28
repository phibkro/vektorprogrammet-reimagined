/**
 * Spec 0017: `SessionActivity` is the domain's type and the adapter's row codec decodes into exactly it. The driver's
 * `Date`s are the adapter's business (`StoredSession`); what the port hands out is `DateTime.Utc`.
 */
import { describe, it } from "@effect/vitest";
import type { SessionActivity } from "@vektorprogrammet/domain";
import type { DateTime } from "effect";
import { expectTypeOf } from "vite-plus/test";

import type { StoredSession } from "../src/repositories/sessions.ts";

describe("SessionActivity (spec 0017)", () => {
  it("the adapter's row codec decodes into the domain's type", () => {
    expectTypeOf<typeof StoredSession.Type>().toEqualTypeOf<SessionActivity>();
  });

  it("the stored side is a driver Date and the domain side an instant (the control: they differ)", () => {
    expectTypeOf<
      typeof StoredSession.Encoded.createdAt
    >().toEqualTypeOf<Date>();
    expectTypeOf<SessionActivity["createdAt"]>().toEqualTypeOf<DateTime.Utc>();
  });
});
