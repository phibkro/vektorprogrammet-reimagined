import { assert, describe, it } from "@effect/vitest";

import { ALL_TEXT_SLOTS } from "../src/lib/textSlots";

describe("public text slots", () => {
  it("names each editable slot once", () => {
    assert.isAbove(ALL_TEXT_SLOTS.length, 0);
    assert.strictEqual(new Set(ALL_TEXT_SLOTS).size, ALL_TEXT_SLOTS.length);
  });
});
