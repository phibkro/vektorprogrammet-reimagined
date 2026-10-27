/**
 * Every scheduled job, declared once (spec 0008). The registry is closed over `SystemJob`: a job that is a principal
 * has a declaration here, a runner in `apps/web/src/server/jobRunners.ts` and a row in the generated table of
 * `docs/system/administration.md`, and `test/jobs/registry.test.ts` fails until all four agree. A later spec adds its
 * job by adding its name to `SystemJob`, a declaration below and a runner.
 *
 * Cadence is the operator's decision. The ten-minute tick is the one that specs 0003 and 0006 already run on, so the
 * jobs that inherit it are `approved`; a value that the operator has not yet accepted is `proposed` and is marked so
 * in the documentation. Approving it changes that one word.
 */
import { ENDING_SOON_WEEKS } from "../teams/endingSoon.ts";
import { DueWhen, make } from "./job.ts";

/** The ten-minute tick: the one trigger of the Worker. Jobs that are not due at a tick do nothing at it. */
const TICK = "*/10 * * * *";

/** Keeps the current and the next semester present (spec 0003, RULE-237). */
export const semesters = make({
  chunkSize: 1,
  chunksPerTick: 1,
  dueWhen: [DueWhen.cases.PerSemester.make({})],
  leaseSeconds: 120,
  maxAttempts: 3,
  name: "semesters",
  schedule: { cron: TICK, status: "approved" },
  summary: "Keeps the current and the next semester present.",
});

/** Delivers what the commands queued in the outbox (spec 0006 R1, spec 0007 R1). The rows are its work queue. */
export const outboxSweep = make({
  chunkSize: 50,
  chunksPerTick: 4,
  dueWhen: [DueWhen.cases.EveryTick.make({})],
  leaseSeconds: 120,
  maxAttempts: 1,
  name: "outboxSweep",
  schedule: { cron: TICK, status: "approved" },
  summary:
    "Delivers e-mails, Slack posts and credential and Workspace intents that a request could not send.",
});

/** The digest of memberships that end this semester (spec 0006). The ledger makes each leader's mail once. */
export const endingSoon = make({
  chunkSize: 1,
  chunksPerTick: 1,
  dueWhen: [DueWhen.cases.BeforeSemesterEnd.make({ weeks: ENDING_SOON_WEEKS })],
  leaseSeconds: 120,
  maxAttempts: 3,
  name: "endingSoon",
  schedule: { cron: TICK, status: "approved" },
  summary: `In the last ${ENDING_SOON_WEEKS} weeks of the semester, e-mails each team leader the memberships that end.`,
});

/**
 * The Google Workspace projection (spec 0008): the intended account and group changes, recorded as a report, and
 * applied only when the operator has switched writes on. The nightly window is a proposal (the operator decides the
 * hour); an administrator can also ask for a run at any time, which is a request row that the next tick takes. A run
 * that would remove more than `limits.removals` members from managed groups changes nothing and reports the diff; a
 * higher limit is the operator's decision after a fresh diff.
 */
export const workspaceSync = make({
  chunkSize: 10,
  chunksPerTick: 5,
  dueWhen: [DueWhen.cases.Daily.make({ hour: 2 })],
  leaseSeconds: 120,
  limits: { removals: 20 },
  maxAttempts: 5,
  name: "workspaceSync",
  schedule: { cron: TICK, status: "proposed" },
  summary:
    "Compares the Google Workspace groups and accounts with the active memberships and records the changes it would make.",
});

/**
 * In the order that a tick runs them in. The outbox sweep is last on purpose: it delivers what the jobs before it
 * queued (the digest, the Workspace changes) in the same tick instead of the next one.
 */
export const Jobs = [
  semesters,
  endingSoon,
  workspaceSync,
  outboxSweep,
] as const;

/** The names that have a declaration. The runners of `apps/web` are typed over exactly these. */
export type RegisteredJob = (typeof Jobs)[number]["name"];
