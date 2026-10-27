/**
 * The scheduler (spec 0008): one `scheduled` tick runs every job of the registry that is due, in declaration order,
 * each as its own `System` principal, each isolated from the others' failures.
 *
 * A job is due for the periods its rules name (`Job.duePeriods`) and for the periods that an earlier tick left
 * `partial` (`JobRuns.resumable`: a budget that ended, a request that waits, an attempt that failed, a lease that ran
 * out). `JobRuns.claim` gives each period to exactly one caller; the rest skip it. A claimed period runs chunk by
 * chunk until it is done or the job's `chunksPerTick` is spent, and then it is released `partial` for the next tick.
 *
 * A runner has one shape: `prepare` reads providers (or does work that manages its own statements, as the outbox
 * sweep does), outside any transaction, and returns the program that commits the chunk. The scheduler runs that
 * program and the cursor write (`JobRuns.advance`, or `finish` for the last chunk) in ONE transaction, so a chunk and
 * its cursor commit together or not at all.
 */
import { CurrentPrincipal, Job, JobRun } from "@vektorprogrammet/domain";
import type {
  DomainError,
  InTransaction,
  SystemJob,
  WorkspaceProviderFailed,
} from "@vektorprogrammet/domain";
import type { DateTime, Schema } from "effect";
import { Array as Arr, Cause, Effect, Exit, Predicate } from "effect";

import { Transactor } from "./transactor";

/** What a runner can fail with; any other failure is a defect and is recorded the same way. */
export type RunnerFailure = DomainError | WorkspaceProviderFailed;

export interface ChunkResult {
  readonly done: boolean;
  readonly cursor: Schema.Json;
  readonly counts: JobRun.Counts;
}

/**
 * `R` is what the tick's Layer provides. A runner may also need the job's own principal, which the scheduler
 * provides, and its commit needs the transaction that the scheduler opens.
 */
export interface Runner<R> {
  readonly prepare: (
    held: JobRun.Held
  ) => Effect.Effect<
    Effect.Effect<
      ChunkResult,
      RunnerFailure,
      R | CurrentPrincipal | InTransaction
    >,
    RunnerFailure,
    R | CurrentPrincipal
  >;
}

/** How one claimed period ended. `lost`: the lease was taken over while it ran, so none of it stands. */
export type PeriodResult = "done" | "partial" | "retry" | "failed" | "lost";

export interface PeriodReport {
  readonly period: Job.JobPeriod;
  readonly result: PeriodResult | "finished" | "taken";
}

export interface JobReport {
  readonly job: SystemJob;
  readonly periods: readonly PeriodReport[];
  /** Set when the job could not even be started (reading its due periods failed). */
  readonly failure: string | null;
}

interface Progress {
  readonly remaining: number;
  readonly result: PeriodResult;
}

/** The reason kept with a failed attempt: the cause, cut by the repository. */
const reasonOf = (cause: Cause.Cause<unknown>): string => Cause.pretty(cause);

/** One chunk: prepare outside the transaction, then commit it and its cursor together. */
const oneChunk = <R>(job: Job.Job, runner: Runner<R>, held: JobRun.Held) =>
  Effect.gen(function* chunkOfRun() {
    const runs = yield* JobRun.JobRuns;
    const transactor = yield* Transactor;
    const commit = yield* runner.prepare(held);

    return yield* transactor.run(
      Effect.gen(function* committed() {
        const result = yield* commit;

        yield* result.done
          ? runs.finish(held, result.counts)
          : runs.advance(
              held,
              { counts: result.counts, cursor: result.cursor },
              job.leaseSeconds
            );

        return result;
      })
    );
  });

/** Runs chunks of a claimed period while the budget lasts. */
const runPeriod = <R>(
  job: Job.Job,
  runner: Runner<R>,
  claimed: JobRun.Held,
  budget: number
) =>
  Effect.gen(function* chunksOfPeriod() {
    const runs = yield* JobRun.JobRuns;
    let held = claimed;
    let remaining = budget;

    while (remaining > 0) {
      remaining -= 1;
      const exit = yield* Effect.exit(oneChunk(job, runner, held));

      if (Exit.isFailure(exit)) {
        return Predicate.isTagged(Cause.squash(exit.cause), "LeaseLost")
          ? ({ remaining, result: "lost" } satisfies Progress)
          : ({
              remaining,
              result: yield* runs.fail(
                claimed,
                reasonOf(exit.cause),
                job.maxAttempts
              ),
            } satisfies Progress);
      }

      if (exit.value.done) {
        return { remaining, result: "done" } satisfies Progress;
      }

      held = {
        attempt: held.attempt,
        counts: exit.value.counts,
        cursor: exit.value.cursor,
        job: held.job,
        period: held.period,
      };
    }

    yield* runs.release(held);

    return { remaining: 0, result: "partial" } satisfies Progress;
  });

/** Claims the periods of `job` that are due or waiting, and runs them while the budget lasts. */
const runDue = <R>(job: Job.Job, runner: Runner<R>, at: DateTime.Utc) =>
  Effect.gen(function* periodsOfJob() {
    const runs = yield* JobRun.JobRuns;

    const periods = Arr.dedupe([
      ...(yield* runs.resumable(job.name)),
      ...Job.duePeriods(job.dueWhen, at),
    ]);

    const reports: PeriodReport[] = [];
    let budget = job.chunksPerTick;

    for (const period of periods) {
      if (budget <= 0) {
        break;
      }

      const claim = yield* runs.claim(job.name, period, job.leaseSeconds);

      if (Predicate.isTagged(claim, "Claimed")) {
        const progress = yield* runPeriod(job, runner, claim.held, budget);

        budget = progress.remaining;
        reports.push({ period, result: progress.result });
      } else {
        reports.push({
          period,
          result: Predicate.isTagged(claim, "Finished") ? "finished" : "taken",
        });
      }
    }

    return reports;
  });

export interface TickOptions {
  /** The instant of the tick: the scheduled time that the platform passed, which names the tick's period. */
  readonly at: DateTime.Utc;
  /** The cron that fired; empty or absent (the local trigger) runs every job's due check. */
  readonly cron?: string | undefined;
  /** Runs only these jobs (an explicit invocation against fake data). */
  readonly only?: readonly SystemJob[] | undefined;
}

/**
 * One tick over `jobs`. A job that fails or dies is reported and logged and does not stop the next one: each runs in
 * its own `System` principal and its own `Effect.exit`, which an interruption of the whole tick still passes through.
 */
export const dispatchTick = <Names extends SystemJob, R>(
  jobs: readonly Job.Job<Names>[],
  runners: Readonly<Record<Names, Runner<R>>>,
  tick: TickOptions
) =>
  Effect.forEach(
    Arr.filter(
      jobs,
      (job) =>
        (tick.cron === undefined ||
          tick.cron === "" ||
          job.schedule.cron === tick.cron) &&
        (tick.only === undefined || Arr.contains(tick.only, job.name))
    ),
    (job) =>
      runDue(job, runners[job.name], tick.at).pipe(
        Effect.provideService(CurrentPrincipal, job.principal),
        Effect.exit,
        Effect.map((exit): JobReport =>
          Exit.isSuccess(exit)
            ? { failure: null, job: job.name, periods: exit.value }
            : { failure: reasonOf(exit.cause), job: job.name, periods: [] }
        ),
        Effect.tap((report) =>
          Effect.logInfo("scheduled job ran").pipe(
            Effect.annotateLogs({
              failed: report.failure !== null,
              job: report.job,
              periods: report.periods.length,
            })
          )
        )
      ),
    { concurrency: 1 }
  );
