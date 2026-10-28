/**
 * Spec 0017, falsifiers 3 and 9: what `@vektorprogrammet/db` exports. The adapter's root is the Layers that a
 * composition root provides, plus the three helpers that `tools/db-path-spike` (an adapter-level harness) uses. It owns
 * no port, which the domain declares, and it does not export the Drizzle schema, so nothing outside the package can
 * write a table by name. Adding an export means editing this list, which is the review.
 */
import { assert, describe, it } from "@effect/vitest";
import { Array as Arr, Order, Record as Rec } from "effect";

import * as root from "../src/index.ts";

const EXPORTS = [
  "DatabaseLive",
  "ImportDatabaseLive",
  "JobDatabaseLive",
  "UniqueConstraint",
  "classifySqlFailure",
  "transactional",
];

describe("the package root of @vektorprogrammet/db (spec 0017)", () => {
  it("exports the Layers and the harness helpers, and no port and no schema", () => {
    assert.deepStrictEqual(
      Arr.sort(Rec.keys(root), Order.String),
      Arr.sort(EXPORTS, Order.String)
    );
  });
});
