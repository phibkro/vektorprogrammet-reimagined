/**
 * The Workspace sync job, declared by the service that owns it (ADR 0015 stage 2, spec 0022 R6). The registry
 * (`jobs/registry.ts`) lists it with the other jobs; the handlers in `commands.ts` read its chunk size and limits here,
 * so `workspace` imports no catalog.
 */
import { DueWhen, TICK_CRON, make } from "../jobs/job.ts";

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
  schedule: { cron: TICK_CRON, status: "proposed" },
  summary:
    "Compares the Google Workspace groups and accounts with the active memberships and records the changes it would make.",
});
