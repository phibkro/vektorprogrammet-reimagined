import { assert, describe, it } from "@effect/vitest";
import { Array as Arr } from "effect";

import { sortSponsorsForFooter } from "../../src/index.ts";

describe("C6 sponsors", () => {
  it("the footer lists large, then medium, then small, and by name within a size", () => {
    const sorted = sortSponsorsForFooter([
      { name: "Liten", size: "small" },
      { name: "Stor B", size: "large" },
      { name: "Middels", size: "medium" },
      { name: "Stor A", size: "large" },
    ] as const);

    assert.deepStrictEqual(
      Arr.map(sorted, (sponsor) => sponsor.name),
      ["Stor A", "Stor B", "Middels", "Liten"]
    );
  });
});
