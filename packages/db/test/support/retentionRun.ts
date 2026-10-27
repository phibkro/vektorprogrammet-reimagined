/**
 * The nightly retention run as the tests start it (spec 0007b R4): through the `RetentionRun` of the test database, so the
 * layer (`postgresJobDatabase("Apply")` or `("ReportOnly")`) decides what the run does and the test cannot.
 */
import {
  CurrentPrincipal,
  RetentionRun,
  retentionJob,
  systemPrincipal,
} from "@vektorprogrammet/domain";
import { DateTime, Effect } from "effect";
import { TestClock } from "effect/testing";

import { transactional } from "../../src/index.ts";

/** The run at `now`: what it did, and in which mode. Needs a transaction, as the job runs in one. */
export const nightlyOutcome = (now: DateTime.Utc) =>
  RetentionRun.use((run) => run.run(now));

/** The counts of the run at `now`: rows changed, or in a report rows that would be. */
export const nightlyCounts = (now: DateTime.Utc) =>
  Effect.map(nightlyOutcome(now), ({ counts }) => counts);

/** The retention job as the Worker's cron runs it: in a transaction, as `System("retention")`. */
export const runRetention = transactional(
  Effect.provideService(
    retentionJob,
    CurrentPrincipal,
    systemPrincipal("retention")
  )
);

/** Sets the test clock to `instant`. */
export const at = (instant: DateTime.Utc) =>
  TestClock.setTime(DateTime.toEpochMillis(instant));
