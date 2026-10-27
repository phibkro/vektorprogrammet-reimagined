import { describe, expect, it } from "vite-plus/test";

import { finiteNumbers } from "../scripts/finiteNumbers.ts";

describe("finite number generation", () => {
  it("changes schema references without touching descriptions or unrelated members", () => {
    const source =
      'const description = "ø Schema.Number"; const a = Schema.Number.check(Schema.isInt()); const b = Other.Number;';

    expect(finiteNumbers(source)).toBe(
      'const description = "ø Schema.Number"; const a = Schema.Finite.check(Schema.isInt()); const b = Other.Number;'
    );
  });
});
