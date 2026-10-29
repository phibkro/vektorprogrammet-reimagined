/**
 * Every scheduled job, declared once (spec 0008). The registry is closed over `SystemJob`: a job that is a principal
 * has a declaration here, a runner in `apps/web/src/server/jobRunners.ts` and a row in the generated table of
 * `docs/system/administration.md`, and `test/jobs/registry.test.ts` fails until all four agree. A later spec adds its
 * job by adding its name to `SystemJob`, a declaration below and a runner.
 *
 * Cadence is the operator's decision. The ten-minute tick is inherited and approved, and so is the retention run's
 * nightly cron (spec 0007b); a proposed cadence does not run or install a trigger until the operator approves it.
 * Explicit requests still use the existing approved tick.
 *
 * This is the catalog (ADR 0015, spec 0022 R6). A service declares the job it owns beside its commands, as `workspace`
 * does (`workspace/job.ts`), and this file imports it; the other declarations stay here, because Privacy (`alumniConsent`,
 * `retention`) sits above the catalog and cannot be imported by it.
 */
import { ENDING_SOON_WEEKS } from "../teams/endingSoon.ts";
import { workspaceSync } from "../workspace/job.ts";
import { DueWhen, TICK_CRON, make } from "./job.ts";

/** Keeps the current and the next semester present (spec 0003, RULE-237). */
export const semesters = make({
  chunkSize: 1,
  chunksPerTick: 1,
  dueWhen: [DueWhen.cases.PerSemester.make({})],
  leaseSeconds: 120,
  maxAttempts: 3,
  name: "semesters",
  schedule: { cron: TICK_CRON, status: "approved" },
  summary: "Keeps the current and the next semester present.",
});

/**
 * The safety net of the outbox queue (spec 0008b): puts the ids of the rows that no queue message covers any more back on
 * the queue. A command's rows are published right after its commit and a job's after its chunk's, so the sweep finds
 * only what a crash or a lost message left behind: rows pending longer than `DeliveryPolicy.requeueAfter`. The rows are
 * the record of what must be sent; the consumer delivers them (spec 0006 R1, spec 0007 R1).
 */
export const outboxSweep = make({
  chunkSize: 50,
  chunksPerTick: 4,
  dueWhen: [DueWhen.cases.EveryTick.make({})],
  leaseSeconds: 120,
  maxAttempts: 1,
  name: "outboxSweep",
  schedule: { cron: TICK_CRON, status: "approved" },
  summary:
    "Puts the ids of outbox rows that no queue message covers any more (a crash between commit and enqueue, a lost message) back on the queue.",
});

/** The digest of memberships that end this semester (spec 0006). The ledger makes each leader's mail once. */
export const endingSoon = make({
  chunkSize: 1,
  chunksPerTick: 1,
  dueWhen: [DueWhen.cases.BeforeSemesterEnd.make({ weeks: ENDING_SOON_WEEKS })],
  leaseSeconds: 120,
  maxAttempts: 3,
  name: "endingSoon",
  schedule: { cron: TICK_CRON, status: "approved" },
  summary: `In the last ${ENDING_SOON_WEEKS} weeks of the semester, e-mails each team leader the memberships that end.`,
});

/**
 * The alumni consent mail (spec 0007b): when a person's last engagement ends, one request and one `IssueCode`
 * message in one transaction; the sweep that follows in the tick mints the code and sends the mail. One request per
 * person and engagement end, so a tick that finds nobody new changes nothing.
 */
export const alumniConsent = make({
  chunkSize: 1,
  chunksPerTick: 1,
  dueWhen: [DueWhen.cases.EveryTick.make({})],
  leaseSeconds: 120,
  maxAttempts: 3,
  name: "alumniConsent",
  schedule: { cron: TICK_CRON, status: "approved" },
  summary:
    "When a person's last engagement ends, queues the e-mail that asks them the two alumni questions, once for each end.",
});

/**
 * The nightly retention run (spec 0007b): deletes or anonymises what has reached the end of its declared period, in one
 * transaction. It has a cron of its own, 02:17 UTC (03:17 or 04:17 in Oslo: a quiet hour, and not a minute that the tick
 * also runs at), and the schedule is approved. The period approval is a separate gate: which mode the run has (apply,
 * or count only) is fixed by the database layer that `retentionModeFor` chooses (`apps/web/src/server/retentionMode.ts`),
 * so production only counts and audits what it would change until every period that the run applies is approved.
 */
export const retention = make({
  chunkSize: 1,
  chunksPerTick: 1,
  dueWhen: [DueWhen.cases.EveryTick.make({})],
  leaseSeconds: 600,
  maxAttempts: 3,
  name: "retention",
  schedule: { cron: "17 2 * * *", status: "approved" },
  summary:
    "Deletes or anonymises the data that has reached the end of its declared retention period. In production it only counts until every period that it applies is approved.",
});

/**
 * In the order that a tick runs them in. The jobs before the outbox sweep publish the rows that their chunks enqueued
 * as soon as the chunk commits (spec 0008b), so the sweep's place is no longer what delivers them in the same tick. The
 * retention run has its own cron, so it never runs in a tick of the others.
 */
export const Jobs = [
  semesters,
  endingSoon,
  alumniConsent,
  workspaceSync,
  outboxSweep,
  retention,
] as const;

/** The names that have a declaration. The runners of `apps/web` are typed over exactly these. */
export type RegisteredJob = (typeof Jobs)[number]["name"];
