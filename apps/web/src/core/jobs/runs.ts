/**
 * The record of a job's periods (spec 0008): single-flight, resumable, and the same row whether a tick found the
 * period due or a command asked for it. `packages/db` implements it with one row per `(job, period)`.
 *
 * Contract (FX009, FX010):
 * - A new period is claimed by recording it if absent (CL1). A partial or expired running period is taken over
 *   atomically only below maxAttempts; otherwise that same statement commits failed and returns Finished.
 *   A live running period is Taken, including its final attempt. Exactly one caller is Claimed (CL2).
 * - Every write carries its claim's attempt fence. A superseded chunk gets LeaseLost and rolls back;
 *   release/fail return lost instead of claiming an outcome their update did not commit.
 * - `advance` and `finish` require `InTransaction`: the chunk's rows and its cursor commit together, or neither
 *   does. A run that is killed between chunks therefore resumes at the cursor and repeats nothing.
 * - Ordering: none across periods. A tick runs the periods of one job in the order `resumable` then `due`.
 * - Every instant is the `Clock`'s.
 */
import { Context, Schema } from "effect";
import type { Effect } from "effect";

import { SystemJob } from "../kernel/principal.ts";
import type { InTransaction } from "../transactions/transaction.ts";
import { JobPeriod } from "./job.ts";

/** `running`: held by a runner. `partial`: left for a later tick (a budget ended, a request waits, an attempt failed). */
export const RunOutcome = Schema.Literals([
  "running",
  "partial",
  "done",
  "failed",
]);

export type RunOutcome = typeof RunOutcome.Type;

/** What a run has done so far: integer counts, never a value (the counts are logged and shown). */
export const Counts = Schema.Record(Schema.String, Schema.Int);

export type Counts = typeof Counts.Type;

/** A period that this runner holds. `attempt` is the fence that every later write carries. */
export const Held = Schema.Struct({
  attempt: Schema.Int,
  counts: Counts,
  /** The runner decodes it with its own schema: a stored cursor is untrusted on read. */
  cursor: Schema.NullOr(Schema.Json),
  job: SystemJob,
  period: JobPeriod,
});

export type Held = typeof Held.Type;

/** What a claim got: the period (`Claimed`), or why not: it is `Finished`, or `Taken` by a live runner. */
export const Claim = Schema.TaggedUnion({
  Claimed: { held: Held },
  Finished: {},
  Taken: {},
});

export type Claim = typeof Claim.Type;

/** The period was taken over while this runner held it: nothing it wrote may stand. */
export class LeaseLost extends Schema.TaggedError<
  LeaseLost,
  { readonly brand: unique symbol }
>()("LeaseLost", { job: SystemJob, period: JobPeriod }) {}

/** A failure report describes only a committed update; lost means the fence matched no row. */
export type Failure = "retry" | "failed" | "lost";

/** Requests may proceed while an operator has not approved the automatic schedule. */
export type ResumeScope = "all" | "requests";

export class JobRuns extends Context.Service<
  JobRuns,
  {
    readonly claim: (
      job: SystemJob,
      period: JobPeriod,
      leaseSeconds: number,
      maxAttempts: number
    ) => Effect.Effect<Claim>;
    /** Partial or expired periods, restricted to explicit requests when the schedule is unapproved. */
    readonly resumable: (
      job: SystemJob,
      scope: ResumeScope
    ) => Effect.Effect<readonly JobPeriod[]>;
    /** Asks for a run of `period`: a `partial` row with no cursor. True when the request was new. */
    readonly request: (
      job: SystemJob,
      period: JobPeriod
    ) => Effect.Effect<boolean, never, InTransaction>;
    /** Records a chunk's cursor and counts and renews the lease, in the chunk's own transaction. */
    readonly advance: (
      held: Held,
      progress: { readonly cursor: Schema.Json; readonly counts: Counts },
      leaseSeconds: number
    ) => Effect.Effect<void, LeaseLost, InTransaction>;
    /** Ends the period as `done`, in the transaction of its last chunk. */
    readonly finish: (
      held: Held,
      counts: Counts
    ) => Effect.Effect<void, LeaseLost, InTransaction>;
    /** Commits partial when still held; lost means no row changed. */
    readonly release: (held: Held) => Effect.Effect<"partial" | "lost">;
    /** Commits partial until maxAttempts, then failed; lost means no row changed. */
    readonly fail: (
      held: Held,
      reason: string,
      maxAttempts: number
    ) => Effect.Effect<Failure>;
  }
>()("@vektorprogrammet/domain/jobs/JobRuns") {}
