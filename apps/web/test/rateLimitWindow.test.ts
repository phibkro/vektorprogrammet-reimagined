/** Issue #24: the sign-in probe must not straddle a fixed rate-limit window. */
import { assert, describe, it } from "@effect/vitest";
import { Array as Arr } from "effect";

import {
  PROBE_BUDGET_MS,
  windowHasRoom,
} from "../e2e/support/rateLimitWindow.ts";
import { CONTACT_RATE_LIMIT } from "../worker.config.ts";

const PERIOD_MS = CONTACT_RATE_LIMIT.period * 1000;

/** The local simulation's bucket: `Math.floor(Date.now() / (period * 1e3))` (miniflare ratelimit-object.worker.js). */
const bucketOf = (nowMs: number): number => Math.floor(nowMs / PERIOD_MS);

/** Start instants over three windows, every 7 ms: 25,714 rounds, each a different place in the window. */
const STARTS = Arr.makeBy(25_714, (round) => 1_700_000_000_000 + round * 7);

const straddles = (startMs: number): boolean =>
  bucketOf(startMs) !== bucketOf(startMs + PROBE_BUDGET_MS);

describe("spec 0007 R15: rate-limit probe window", () => {
  it("a probe started at once straddles a window boundary for some start instants (negative control)", () => {
    const straddling = Arr.filter(STARTS, straddles);

    // The old probe started wherever the test happened to be: PROBE_BUDGET_MS / PERIOD_MS of the starts straddle.
    assert.isAbove(straddling.length, 0);
  });

  it("a probe started only once the window has room ends in the window it started in, at every start instant", () => {
    const admitted = Arr.filter(STARTS, (start) =>
      windowHasRoom(start, PERIOD_MS, PROBE_BUDGET_MS)
    );

    assert.isAbove(admitted.length, 0);
    assert.deepStrictEqual(Arr.filter(admitted, straddles), []);
  });

  it("every instant that has no room reaches one that has, within one period", () => {
    const stuck = Arr.filter(
      STARTS,
      (start) =>
        !Arr.some(Arr.range(0, PERIOD_MS / 1000), (second) =>
          windowHasRoom(start + second * 1000, PERIOD_MS, PROBE_BUDGET_MS)
        )
    );

    assert.deepStrictEqual(stuck, []);
  });
});
