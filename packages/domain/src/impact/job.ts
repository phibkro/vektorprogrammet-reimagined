/**
 * The close of the ended semesters, declared by the service that owns it (spec 0027 D8, ADR 0015 stage 2). The registry
 * (`jobs/registry.ts`) lists it with the other jobs, so `impact` imports no catalog.
 */
import { DueWhen, TICK_CRON, make } from "../jobs/job.ts";

/**
 * Freezes the cells of a semester that has ended, once: from the first tick after the semester's end, `closeImpact`
 * writes each cell that a source answers and leaves the rest. With the only source that ships (it answers Unavailable
 * for every cell) the job writes nothing. The cadence is a proposal: it installs no trigger and runs only when asked,
 * until the operator approves it with one word here.
 */
export const impactClose = make({
  chunkSize: 1,
  chunksPerTick: 1,
  dueWhen: [DueWhen.cases.PerSemester.make({})],
  leaseSeconds: 120,
  maxAttempts: 3,
  name: "impactClose",
  schedule: { cron: TICK_CRON, status: "proposed" },
  summary:
    "Closes the cells of the ended semesters that a source answers: a closed cell never changes.",
});
