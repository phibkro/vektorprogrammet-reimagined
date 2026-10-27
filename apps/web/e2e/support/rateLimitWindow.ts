/**
 * The Workers `RateLimit` binding counts in fixed windows aligned to the wall clock (the local simulation
 * uses `floor(Date.now() / period)` as the bucket). Requests that straddle a window boundary meet a fresh
 * bucket and are never limited, so a probe of the limit must start with the whole probe inside one window.
 */

/** Room a probe needs: six sign-in attempts, generous for a loaded runner (issue #24). */
export const PROBE_BUDGET_MS = 20_000;

/** Milliseconds left in the fixed window that contains `nowMs`. */
const windowRemainingMs = (nowMs: number, periodMs: number): number =>
  periodMs - (nowMs % periodMs);

/** True when a probe of `budgetMs` that starts at `nowMs` ends in the window it starts in. */
export const windowHasRoom = (
  nowMs: number,
  periodMs: number,
  budgetMs: number
): boolean => windowRemainingMs(nowMs, periodMs) > budgetMs;
