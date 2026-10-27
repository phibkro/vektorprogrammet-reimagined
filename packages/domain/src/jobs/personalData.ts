/**
 * What the scheduler declares about its stored columns (spec 0008, on the declarations of spec 0007b): one row per job
 * period. The row is bookkeeping, apart from the reason of a failed attempt, which is what a provider or a defect said and
 * can name an address. The row is also the claim that makes a period run once, so the one period (`Periods.jobRuns`) is
 * for the row, and it is longer than the longest period of a job.
 */
import {
  Rules,
  columns,
  notPersonal,
  personal,
  table,
} from "../personalData/declaration.ts";
import { Periods } from "../personalData/periods.ts";
import { afterColumn } from "../personalData/retentions.ts";

const jobRun = table({
  columns: {
    last_error: personal({
      legalBasis: "legitimateInterest",
      onExpiry: Rules.Delete,
      purpose: "jobs",
      retention: afterColumn("lease_until", Periods.jobRuns, {
        en: "the run's lease ended",
        no: "kjøringens leie utløp",
      }),
    }),
    ...columns(
      notPersonal(
        "Scheduler bookkeeping: the job and period it ran for, counts, times and the outcome, and a cursor that is a position in a run (a step and a team id). The row is the claim that makes a period run once, so it goes only with the retention of its failure reason, which is longer than the longest period (a semester)"
      ),
      [
        "attempt",
        "counts",
        "cursor",
        "ended_at",
        "job",
        "lease_until",
        "outcome",
        "period",
        "started_at",
      ]
    ),
  },
  person: null,
});

export const JobTables = { job_run: jobRun } as const;
