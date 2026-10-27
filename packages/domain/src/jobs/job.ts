/**
 * A scheduled job as data (spec 0008). One declaration states a job's name (the `System` principal it runs as), the
 * cron that wakes it, the rules that make it due, and how much work one tick may do. The Worker's cron triggers, the
 * dispatcher, the completeness tests and the generated table of `docs/system/administration.md` all read the
 * declarations in `registry.ts`; nothing else states when a job runs.
 *
 * A rule returns the *periods* that are due at a tick. A period names one unit of work (the tick, the Oslo day, the
 * semester); `job_run` claims `(job, period)` once, so a period is run by one runner at a time and a finished one is
 * not run again.
 */
import { Array as Arr, DateTime, Match, Schema } from "effect";

import { SystemJob, systemPrincipal } from "../kernel/principal.ts";
import type { SystemPrincipal } from "../kernel/principal.ts";
import { inLastWeeksOf, semesterForDate } from "../organisation/semester.ts";
import { OSLO } from "../shared/clock.ts";

const Hour = Schema.Int.check(Schema.isBetween({ maximum: 23, minimum: 0 }));

const Weeks = Schema.Int.check(Schema.isBetween({ maximum: 26, minimum: 1 }));

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

/** When a job is due. Every rule is a pure function of the tick (`duePeriods`). */
export const DueWhen = Schema.TaggedUnion({
  /** In the last `weeks` weeks of the current semester, at every tick. */
  BeforeSemesterEnd: { weeks: Weeks },
  /** Once a day, from `hour` on (Europe/Oslo). */
  Daily: { hour: Hour },
  /** At every tick. */
  EveryTick: {},
  /** Once per semester, from its first tick. */
  PerSemester: {},
});

export type DueWhen = typeof DueWhen.Type;

/**
 * Whether the operator has accepted a job's cadence. A `proposed` value runs like an `approved` one and is marked in
 * the generated documentation; approving it is the change of this one word in the declaration.
 */
export const ScheduleStatus = Schema.Literals(["approved", "proposed"]);

export type ScheduleStatus = typeof ScheduleStatus.Type;

/** A five-field cron expression, as Cloudflare's triggers take it. */
const Cron = Schema.String.check(
  Schema.isPattern(/^\S+ \S+ \S+ \S+ \S+$/u, {
    expected: "a cron expression of five fields",
  })
);

export const Schedule = Schema.Struct({ cron: Cron, status: ScheduleStatus });

export type Schedule = typeof Schedule.Type;

/** What the author of a declaration writes. */
const JobFields = Schema.Struct({
  /** Rows (or groups, or teams) that one chunk handles. */
  chunkSize: PositiveInt,
  /** Chunks that one invocation may run before it leaves the rest for the next tick. */
  chunksPerTick: PositiveInt,
  dueWhen: Schema.NonEmptyArray(DueWhen),
  /** How long a runner holds a period before another may take it over. */
  leaseSeconds: PositiveInt,
  /** Named ceilings that the job's own rules enforce (the Workspace sync's removals per run), data and not code. */
  limits: Schema.optionalKey(Schema.Record(Schema.String, PositiveInt)),
  /** Failed attempts of one period after which it is left for the next period. */
  maxAttempts: PositiveInt,
  name: SystemJob,
  schedule: Schedule,
  /** What the job does, in one plain sentence (the generated table's line). */
  summary: Schema.NonEmptyString,
});

export type JobFields = typeof JobFields.Encoded;

export interface Job<Name extends SystemJob = SystemJob> extends Omit<
  JobFields,
  "limits" | "name"
> {
  readonly limits: Readonly<Record<string, number>>;
  readonly name: Name;
  /** The principal the job runs as; derived from `name`, so it cannot differ from it. */
  readonly principal: SystemPrincipal;
}

/** Declares one job. An invalid declaration fails when the module loads, which the first test run finds. */
export const make = <const Name extends SystemJob>(
  fields: Omit<JobFields, "name"> & { readonly name: Name }
): Job<Name> => {
  const decoded = JobFields.make(fields);

  return {
    ...decoded,
    limits: decoded.limits ?? {},
    name: fields.name,
    principal: systemPrincipal(fields.name),
  };
};

/** The name of a job's unit of work: a time, a day, a semester, or a request. */
export const JobPeriod = Schema.NonEmptyString.pipe(Schema.brand("JobPeriod"));

export type JobPeriod = typeof JobPeriod.Type;

/** The period of a tick: its scheduled instant, to the minute. Two triggers of one tick name one period. */
export const tickPeriod = (at: DateTime.Utc): JobPeriod =>
  JobPeriod.make(DateTime.formatIso(DateTime.startOf(at, "minute")));

/** A request for a run is its own period (`request:<n>`), so asking again never collides with a finished one. */
export const requestPeriod = (key: string): JobPeriod =>
  JobPeriod.make(`request:${key}`);

/**
 * The periods of `dueWhen` that are due at the tick `at`, each once, in the order of the rules: the tick itself, the
 * Oslo calendar day (`2026-11-03`) or the semester (`2026-HOST`).
 */
export const duePeriods = (
  dueWhen: readonly DueWhen[],
  at: DateTime.Utc
): readonly JobPeriod[] => {
  const semester = semesterForDate(at);
  const oslo = DateTime.setZone(at, OSLO);

  return Arr.dedupe(
    Arr.flatMap(dueWhen, (rule): readonly JobPeriod[] =>
      Match.value(rule).pipe(
        Match.tagsExhaustive({
          BeforeSemesterEnd: ({ weeks }) =>
            inLastWeeksOf(semester, weeks, at) ? [tickPeriod(at)] : [],
          Daily: ({ hour }) =>
            DateTime.toParts(oslo).hour >= hour
              ? [JobPeriod.make(DateTime.formatIsoDate(oslo))]
              : [],
          EveryTick: () => [tickPeriod(at)],
          PerSemester: () => [
            JobPeriod.make(`${semester.year}-${semester.term}`),
          ],
        })
      )
    )
  );
};

/** The rule in words, for the generated table. */
export const describeDueWhen = (rule: DueWhen): string =>
  Match.value(rule).pipe(
    Match.tagsExhaustive({
      BeforeSemesterEnd: ({ weeks }) =>
        `every tick in the last ${weeks} weeks of the semester`,
      Daily: ({ hour }) =>
        `once a day from ${String(hour).padStart(2, "0")}:00 (Europe/Oslo)`,
      EveryTick: () => "every tick",
      PerSemester: () => "once per semester",
    })
  );

/** The distinct crons of `jobs`, in declaration order: the Worker's triggers, generated and never listed by hand. */
export const cronTriggers = (jobs: readonly Job[]): readonly string[] =>
  Arr.dedupe(Arr.map(jobs, (job) => job.schedule.cron));
