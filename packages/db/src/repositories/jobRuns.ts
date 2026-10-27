/**
 * `JobRuns` (spec 0008): one row per `(job, period)`. The contract is the domain's (`jobs/runs.ts`); this is how
 * PostgreSQL keeps it, with no advisory lock, no `LISTEN` and no session state (Hyperdrive):
 *
 * - A new period is claimed by `INSERT … ON CONFLICT DO NOTHING RETURNING`: of any number of concurrent callers, the
 *   primary key lets exactly one insert, and the others get no row.
 * - A `partial` period, and a `running` one whose lease ran out, is taken over by one conditional `UPDATE … RETURNING`
 *   that adds one to `attempt`. Two callers cannot both match the row's state after the first one's update.
 * - `advance`, `finish`, `release` and `fail` write only `WHERE attempt = $held`, so a runner whose period was taken
 *   over matches no row. `advance` and `finish` are chunk-transaction writes (`InTransaction`): they commit with the
 *   chunk's own rows, so a cursor never stands without its chunk, nor a chunk without its cursor.
 * - Every timestamp comes from Effect's `Clock`.
 */
import { InTransaction, Job, JobRun } from "@vektorprogrammet/domain";
import { and, asc, eq, lte, or, sql } from "drizzle-orm";
import { Array as Arr, DateTime, Effect, Layer, Schema } from "effect";

import { Drizzle, decodeWith } from "../internal/drizzle.ts";
import { jobRun } from "../schema.ts";

const heldColumns = {
  attempt: jobRun.attempt,
  counts: jobRun.counts,
  cursor: jobRun.cursor,
};

/** What a claim reads back: stored JSON is untrusted, so counts and cursor are decoded here. */
const HeldRow = Schema.Struct({
  attempt: Schema.Int,
  counts: JobRun.Counts,
  cursor: Schema.NullOr(Schema.Json),
});

/** The longest failure reason kept: a provider's message, cut. */
const REASON_LENGTH = 300;

/** `seconds` after `now`, as the driver's date. */
const later = (now: DateTime.Utc, seconds: number): Date =>
  DateTime.toDateUtc(DateTime.add(now, { seconds }));

export const JobRunsLive = Layer.effect(
  JobRun.JobRuns,
  Effect.gen(function* JobRunsLive() {
    const db = yield* Drizzle;
    const decodeHeld = decodeWith(HeldRow);
    const decodePeriods = decodeWith(Schema.Array(Job.JobPeriod));

    const claim = Effect.fn("JobRuns.claim")(function* claim(
      name: JobRun.Held["job"],
      period: JobRun.Held["period"],
      leaseSeconds: number
    ) {
      const now = yield* DateTime.now;
      const nowDate = DateTime.toDateUtc(now);
      const leaseUntil = later(now, leaseSeconds);

      const claimed = (held: typeof HeldRow.Type) =>
        JobRun.Claim.cases.Claimed.make({
          held: { ...held, job: name, period },
        });

      const [fresh] = yield* db
        .insert(jobRun)
        .values({
          attempt: 1,
          job: name,
          leaseUntil,
          outcome: "running",
          period,
          startedAt: nowDate,
        })
        .onConflictDoNothing()
        .returning(heldColumns)
        .pipe(Effect.orDie);

      if (fresh !== undefined) {
        return claimed(yield* decodeHeld(fresh));
      }

      const [taken] = yield* db
        .update(jobRun)
        .set({
          attempt: sql`${jobRun.attempt} + 1`,
          leaseUntil,
          outcome: "running",
          startedAt: sql`coalesce(${jobRun.startedAt}, ${nowDate}::timestamptz)`,
        })
        .where(
          and(
            eq(jobRun.job, name),
            eq(jobRun.period, period),
            or(
              eq(jobRun.outcome, "partial"),
              and(
                eq(jobRun.outcome, "running"),
                lte(jobRun.leaseUntil, nowDate)
              )
            )
          )
        )
        .returning(heldColumns)
        .pipe(Effect.orDie);

      if (taken !== undefined) {
        return claimed(yield* decodeHeld(taken));
      }

      const [existing] = yield* db
        .select({ outcome: jobRun.outcome })
        .from(jobRun)
        .where(and(eq(jobRun.job, name), eq(jobRun.period, period)))
        .pipe(Effect.orDie);

      return existing?.outcome === "running"
        ? JobRun.Claim.cases.Taken.make({})
        : JobRun.Claim.cases.Finished.make({});
    });

    const resumable = Effect.fn("JobRuns.resumable")(function* resumable(
      name: JobRun.Held["job"]
    ) {
      const nowDate = DateTime.toDateUtc(yield* DateTime.now);

      const rows = yield* db
        .select({ period: jobRun.period })
        .from(jobRun)
        .where(
          and(
            eq(jobRun.job, name),
            or(
              eq(jobRun.outcome, "partial"),
              and(
                eq(jobRun.outcome, "running"),
                lte(jobRun.leaseUntil, nowDate)
              )
            )
          )
        )
        .orderBy(asc(jobRun.leaseUntil), asc(jobRun.period))
        .limit(20)
        .pipe(Effect.orDie);

      return yield* decodePeriods(Arr.map(rows, (row) => row.period));
    });

    const request = Effect.fn("JobRuns.request")(function* request(
      name: JobRun.Held["job"],
      period: JobRun.Held["period"]
    ) {
      yield* InTransaction;
      const now = DateTime.toDateUtc(yield* DateTime.now);

      const rows = yield* db
        .insert(jobRun)
        .values({
          attempt: 0,
          job: name,
          leaseUntil: now,
          outcome: "partial",
          period,
        })
        .onConflictDoNothing()
        .returning({ period: jobRun.period })
        .pipe(Effect.orDie);

      return rows.length > 0;
    });

    /** The one statement that changes a run that this runner holds: nothing matches once the period was taken over. */
    const write = Effect.fnUntraced(function* write(
      held: JobRun.Held,
      changes: Partial<typeof jobRun.$inferInsert>
    ) {
      const rows = yield* db
        .update(jobRun)
        .set(changes)
        .where(
          and(
            eq(jobRun.job, held.job),
            eq(jobRun.period, held.period),
            eq(jobRun.attempt, held.attempt),
            eq(jobRun.outcome, "running")
          )
        )
        .returning({ period: jobRun.period })
        .pipe(Effect.orDie);

      return rows.length === 1;
    });

    /** `write`, failing with `LeaseLost` when the period is no longer this runner's. */
    const writeHeld = (
      held: JobRun.Held,
      changes: Partial<typeof jobRun.$inferInsert>
    ) =>
      Effect.filterOrFail(
        write(held, changes),
        (recorded) => recorded,
        () => new JobRun.LeaseLost({ job: held.job, period: held.period })
      );

    const advance = Effect.fn("JobRuns.advance")(function* advance(
      held: JobRun.Held,
      progress: {
        readonly cursor: Schema.Json;
        readonly counts: JobRun.Counts;
      },
      leaseSeconds: number
    ) {
      yield* InTransaction;
      const now = yield* DateTime.now;

      yield* writeHeld(held, {
        counts: progress.counts,
        cursor: progress.cursor,
        leaseUntil: later(now, leaseSeconds),
      });
    });

    const finish = Effect.fn("JobRuns.finish")(function* finish(
      held: JobRun.Held,
      counts: JobRun.Counts
    ) {
      yield* InTransaction;
      const now = DateTime.toDateUtc(yield* DateTime.now);

      yield* writeHeld(held, {
        counts,
        endedAt: now,
        leaseUntil: now,
        outcome: "done",
      });
    });

    const release = Effect.fn("JobRuns.release")(function* release(
      held: JobRun.Held
    ) {
      const now = DateTime.toDateUtc(yield* DateTime.now);

      yield* write(held, { leaseUntil: now, outcome: "partial" });
    });

    const fail = Effect.fn("JobRuns.fail")(function* fail(
      held: JobRun.Held,
      reason: string,
      maxAttempts: number
    ) {
      const now = DateTime.toDateUtc(yield* DateTime.now);
      const dead = held.attempt >= maxAttempts;

      yield* write(held, {
        endedAt: dead ? now : null,
        lastError: reason.slice(0, REASON_LENGTH),
        leaseUntil: now,
        outcome: dead ? "failed" : "partial",
      });

      const outcome: JobRun.Failure = dead ? "failed" : "retry";

      return outcome;
    });

    return JobRun.JobRuns.of({
      advance,
      claim,
      fail,
      finish,
      release,
      request,
      resumable,
    });
  })
);
