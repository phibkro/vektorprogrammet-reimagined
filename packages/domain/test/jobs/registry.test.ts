/**
 * Spec 0008, falsifier 6 (the registry is complete) and the pure half of falsifier 9 (what is due, and when). The
 * registry is data, so each check has a negative control: one change to the data that makes exactly that check
 * report.
 */
import { assert, describe, it } from "@effect/vitest";
import { Array as Arr, DateTime, Order } from "effect";

import {
  Declarations,
  Job,
  JobRegistry,
  OutboxSweep,
  Periods,
  SystemJob,
  afterDuration,
  jobProblems,
  systemPrincipal,
} from "../../src/index.ts";
import { semesterWindow } from "../../src/organisation/semester.ts";
import { oslo } from "../support/calendar.ts";

const at = (local: string): DateTime.Utc => DateTime.toUtc(oslo(local));

const sortedNames = (list: readonly string[]): readonly string[] =>
  Arr.sort(list, Order.String);

/** Periods as the rules name them, branded. */
const periods = (...values: readonly string[]) =>
  Arr.map(values, (value) => Job.JobPeriod.make(value));

const { Jobs, semesters, workspaceSync } = JobRegistry;

describe("spec 0008 falsifier 6: the job registry is complete", () => {
  it("every System principal has a declaration, and every declaration a command", () => {
    assert.deepStrictEqual(jobProblems(Jobs, Declarations), []);
  });

  it("the registry names exactly the System principals, each with the principal its name gives", () => {
    assert.deepStrictEqual(
      sortedNames(Arr.map(Jobs, (job) => job.name)),
      sortedNames(SystemJob.literals)
    );

    for (const job of Jobs) {
      assert.deepStrictEqual(job.principal, systemPrincipal(job.name));
    }
  });

  it("negative control: a System principal without a declaration is reported", () => {
    assert.deepStrictEqual(
      jobProblems(
        Arr.filter(Jobs, (job) => job.name !== "endingSoon"),
        Declarations
      ),
      ["endingSoon is a System principal and the registry has no declaration"]
    );
  });

  it("negative control: a name declared twice is reported", () => {
    assert.deepStrictEqual(jobProblems([...Jobs, semesters], Declarations), [
      "semesters is declared twice",
    ]);
  });

  it("negative control: a declaration whose command is gone is reported", () => {
    assert.deepStrictEqual(
      jobProblems(
        Jobs,
        Arr.filter(
          Declarations,
          (domain) => domain !== OutboxSweep.OutboxDomain
        )
      ),
      ["outboxSweep is declared and no command is its job's command"]
    );
  });
});

describe("spec 0008 falsifier 9, pure half: when a job is due", () => {
  it("an every-tick job is due at each tick, named by the minute, and two triggers of one tick name one period", () => {
    const rule = [Job.DueWhen.cases.EveryTick.make({})];

    assert.deepStrictEqual(
      Job.duePeriods(rule, DateTime.makeUnsafe("2026-10-27T12:13:45.250Z")),
      periods("2026-10-27T12:13:00.000Z")
    );
    assert.deepStrictEqual(
      Job.duePeriods(rule, DateTime.makeUnsafe("2026-10-27T12:13:00.000Z")),
      Job.duePeriods(rule, DateTime.makeUnsafe("2026-10-27T12:13:59.999Z"))
    );
  });

  it("a daily job is due from its hour on the Oslo calendar, once per Oslo day, in winter and summer time", () => {
    const nightly = [Job.DueWhen.cases.Daily.make({ hour: 2 })];

    // Winter time (UTC+1): 02:00 in Oslo is 01:00 UTC.
    assert.deepStrictEqual(
      Job.duePeriods(nightly, at("2026-11-03T01:59:59")),
      []
    );
    assert.deepStrictEqual(
      Job.duePeriods(nightly, at("2026-11-03T02:00:00")),
      periods("2026-11-03")
    );
    assert.deepStrictEqual(
      Job.duePeriods(nightly, at("2026-11-03T23:59:59")),
      periods("2026-11-03")
    );
    // Midnight in Oslo starts a new day that is not due before its own 02:00.
    assert.deepStrictEqual(
      Job.duePeriods(nightly, at("2026-11-04T00:00:00")),
      []
    );
    // Summer time (UTC+2): 02:00 in Oslo is 00:00 UTC.
    assert.deepStrictEqual(
      Job.duePeriods(nightly, DateTime.makeUnsafe("2026-07-02T00:00:00Z")),
      periods("2026-07-02")
    );
    assert.deepStrictEqual(
      Job.duePeriods(nightly, DateTime.makeUnsafe("2026-07-01T23:59:59Z")),
      []
    );
  });

  it("a per-semester job is due in the Oslo semester that the tick falls in, from the first instant of it", () => {
    const rule = [Job.DueWhen.cases.PerSemester.make({})];

    assert.deepStrictEqual(
      Job.duePeriods(rule, at("2026-07-31T23:59:59")),
      periods("2026-VAR")
    );
    assert.deepStrictEqual(
      Job.duePeriods(rule, at("2026-08-01T00:00:00")),
      periods("2026-HOST")
    );
  });

  it("a before-semester-end job is due in the last weeks only, the end excluded", () => {
    const rule = [Job.DueWhen.cases.BeforeSemesterEnd.make({ weeks: 4 })];

    assert.deepStrictEqual(Job.duePeriods(rule, at("2026-12-03T23:59:59")), []);
    assert.strictEqual(
      Job.duePeriods(rule, at("2026-12-04T00:00:00")).length,
      1
    );
    assert.strictEqual(
      Job.duePeriods(rule, at("2026-12-31T23:59:59")).length,
      1
    );
    assert.deepStrictEqual(Job.duePeriods(rule, at("2027-01-01T00:00:00")), []);
  });

  it("two rules that name one period give it once", () => {
    const both = [
      Job.DueWhen.cases.EveryTick.make({}),
      Job.DueWhen.cases.EveryTick.make({}),
    ];

    assert.strictEqual(
      Job.duePeriods(both, DateTime.makeUnsafe("2026-10-27T12:13:00Z")).length,
      1
    );
  });

  it("the Worker's triggers are the registry's crons, each once and in declaration order", () => {
    assert.deepStrictEqual(Job.cronTriggers(Jobs), [
      "*/10 * * * *",
      "17 2 * * *",
    ]);

    const nightly = Job.make({
      ...workspaceSync,
      name: "workspaceSync",
      schedule: { cron: "0 1 * * *", status: "proposed" },
    });

    assert.deepStrictEqual(Job.cronTriggers([semesters, nightly, semesters]), [
      "*/10 * * * *",
    ]);
  });

  it("a proposed cron is not installed until the operator approves it", () => {
    const proposed = Job.make({
      ...workspaceSync,
      name: "workspaceSync",
      schedule: { cron: "0 1 * * *", status: "proposed" },
    });

    const approved = Job.make({
      ...proposed,
      name: "workspaceSync",
      schedule: { ...proposed.schedule, status: "approved" },
    });

    assert.deepStrictEqual(Job.cronTriggers([proposed]), []);
    assert.deepStrictEqual(Job.cronTriggers([approved]), ["0 1 * * *"]);
  });

  it("a declaration that cannot run is refused when it loads", () => {
    const valid = {
      chunkSize: 1,
      chunksPerTick: 1,
      dueWhen: [Job.DueWhen.cases.EveryTick.make({})],
      leaseSeconds: 60,
      maxAttempts: 1,
      name: "semesters",
      schedule: { cron: "*/10 * * * *", status: "approved" },
      summary: "A job.",
    } as const;

    assert.strictEqual(Job.make(valid).name, "semesters");
    assert.throws(() => {
      Job.make({ ...valid, chunksPerTick: 0 });
    });
    assert.throws(() => {
      Job.make({
        ...valid,
        dueWhen: [Job.DueWhen.cases.Daily.make({ hour: 24 })],
      });
    });
    assert.throws(() => {
      Job.make({ ...valid, schedule: { cron: "daily", status: "approved" } });
    });
  });
});

describe("spec 0008 with spec 0007b: the two jobs of the personal data engine are registered", () => {
  it("the retention run has a cron of its own, approved, and runs at each tick of it; the alumni mail runs at the tick", () => {
    const { alumniConsent, retention } = JobRegistry;

    assert.strictEqual(retention.schedule.cron, "17 2 * * *");
    assert.strictEqual(retention.schedule.status, "approved");
    assert.notStrictEqual(retention.schedule.cron, semesters.schedule.cron);
    assert.strictEqual(alumniConsent.schedule.cron, semesters.schedule.cron);
    assert.strictEqual(alumniConsent.schedule.cron, JobRegistry.TICK_CRON);

    for (const job of [retention, alumniConsent]) {
      assert.deepStrictEqual(job.dueWhen, [
        Job.DueWhen.cases.EveryTick.make({}),
      ]);
    }
  });

  it("the sweep is the last job of the tick, so it delivers what the alumni mail and the digest queued", () => {
    const tick = Arr.map(
      Arr.filter(
        JobRegistry.Jobs,
        (job) => job.schedule.cron === JobRegistry.TICK_CRON
      ),
      (job) => job.name
    );

    assert.deepStrictEqual(Arr.takeRight(tick, 1), ["outboxSweep"]);
  });

  it("the ledger of runs is kept longer than a period lasts: a claim made when a semester starts is held until it ends", () => {
    // `semesters` is due once per semester and its claim is the row that says so. A row that retention forgot before the
    // semester ended would let the job claim the semester again.
    for (const term of ["VAR", "HOST"] as const) {
      const { end, start } = semesterWindow({ term, year: 2026 });

      assert.isTrue(
        DateTime.isGreaterThan(
          afterDuration(start, Periods.jobRuns.duration),
          end
        ),
        `${term}: Periods.jobRuns must outlast the semester`
      );
    }
  });
});
