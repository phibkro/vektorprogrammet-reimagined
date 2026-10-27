/**
 * The scheduler on real PostgreSQL (spec 0008, falsifiers 7, 8 and 9): concurrent ticks of one period run it once, a
 * run that is killed after a committed chunk resumes at its cursor and reaches what an uninterrupted run reaches, a
 * job stays within its chunk budget and continues on the next tick, and one job's failure does not stop another. The
 * jobs here are test declarations with synthetic runners that write one probe row per chunk, so a duplicated or lost
 * chunk is visible as a duplicated or missing row.
 */
import { assert, layer } from "@effect/vitest";
import { DatabaseLive } from "@vektorprogrammet/db";
import {
  TestDatabaseUrl,
  migratedTestDatabase,
} from "@vektorprogrammet/db/testing";
import { Job } from "@vektorprogrammet/domain";
import type { SystemJob } from "@vektorprogrammet/domain";
import {
  Array as Arr,
  DateTime,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Ref,
  Schema,
} from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { TestClock } from "effect/testing";

import { dispatchTick } from "../src/server/jobs";
import type { Runner } from "../src/server/jobs";
import { transactorLayer } from "../src/server/transactor";

const T0 = DateTime.makeUnsafe("2026-10-27T12:00:00Z");

const tickAt = (minutes: number) => DateTime.add(T0, { minutes });

const live = Layer.unwrap(
  Effect.map(Effect.service(TestDatabaseUrl), (url) =>
    transactorLayer.pipe(
      Layer.provideMerge(DatabaseLive({ maxConnections: 30, url }))
    )
  )
).pipe(Layer.provideMerge(migratedTestDatabase), Layer.orDie);

/** A test job: due at every tick, with the budget and attempts a test sets. */
const declared = <const Name extends SystemJob>(
  name: Name,
  options: { readonly chunksPerTick: number; readonly maxAttempts?: number }
) =>
  Job.make({
    chunkSize: 1,
    chunksPerTick: options.chunksPerTick,
    dueWhen: [Job.DueWhen.cases.EveryTick.make({})],
    leaseSeconds: 120,
    maxAttempts: options.maxAttempts ?? 3,
    name,
    schedule: { cron: "*/10 * * * *", status: "approved" },
    summary: "A test job.",
  });

const CursorOf = Schema.NullOr(Schema.Int);

/**
 * A runner of `total` chunks. A chunk's cursor is the number of chunks done. Preparing a chunk counts a call and may
 * wait at a gate; committing it writes one probe row in the chunk's own transaction.
 */
const probeRunner = (options: {
  readonly total: number;
  readonly prepared: Ref.Ref<readonly string[]>;
  readonly gate?: (chunk: number) => Effect.Effect<unknown>;
}): Runner<SqlClient> => ({
  prepare: (held) =>
    Effect.map(
      Effect.gen(function* prepareChunk() {
        const done =
          (yield* Effect.orDie(
            Schema.decodeUnknownEffect(CursorOf)(held.cursor)
          )) ?? 0;

        yield* Ref.update(options.prepared, (calls) => [
          ...calls,
          `${held.period}#${done + 1}`,
        ]);
        yield* options.gate?.(done + 1) ?? Effect.void;

        return done;
      }),
      (done) =>
        Effect.gen(function* commitChunk() {
          const sql = yield* SqlClient;

          yield* Effect.orDie(
            sql`insert into job_effects (period, n) values (${held.period}, ${done + 1})`
          );

          return {
            counts: { chunks: done + 1 },
            cursor: done + 1,
            done: done + 1 === options.total,
          };
        })
    ),
});

interface ProbeRow {
  readonly period: string;
  readonly n: number;
}

const probeRows = Effect.gen(function* probeRows() {
  const sql = yield* SqlClient;

  const rows =
    yield* sql<ProbeRow>`select period, n from job_effects order by period, n`;

  return Arr.map(rows, (row) => `${row.period}#${row.n}`);
});

interface RunRow {
  readonly job: string;
  readonly period: string;
  readonly outcome: string;
  readonly attempt: number;
  readonly cursor: unknown;
  readonly counts: unknown;
  readonly last_error: string | null;
}

const jobRuns = Effect.gen(function* jobRuns() {
  const sql = yield* SqlClient;

  return yield* sql<RunRow>`select job, period, outcome, attempt, cursor, counts, last_error from job_run order by job, period`;
});

const runOf = (rows: readonly RunRow[], job: string, marker = "") =>
  Option.getOrThrow(
    Arr.findFirst(rows, (row) => row.job === job && row.period.includes(marker))
  );

layer(live, { excludeTestServices: true })(
  "the scheduler on PostgreSQL",
  (it) => {
    it.effect("setup: the probe table that the synthetic runners write", () =>
      Effect.gen(function* setup() {
        const sql = yield* SqlClient;
        yield* sql`create table job_effects (period text not null, n integer not null)`;
      })
    );

    it.layer(TestClock.layer())((layerTest) => {
      layerTest.effect(
        "falsifier 7: twenty concurrent ticks of one job and period run it once and write one set of effects",
        () =>
          Effect.gen(function* concurrentTicks() {
            yield* TestClock.setTime(DateTime.toEpochMillis(T0));

            const prepared = yield* Ref.make<readonly string[]>([]);
            const job = declared("semesters", { chunksPerTick: 1 });

            const tick = dispatchTick(
              [job],
              { semesters: probeRunner({ prepared, total: 1 }) },
              { at: T0 }
            );

            const reports = yield* Effect.all(
              Arr.makeBy(20, () => tick),
              { concurrency: "unbounded" }
            );

            const outcomes = Arr.flatMap(reports, (jobs) =>
              Arr.flatMap(jobs, (report) =>
                Arr.map(report.periods, (period) => period.result)
              )
            );

            assert.strictEqual(
              Arr.filter(outcomes, (result) => result === "done").length,
              1,
              `one tick ran it: ${Arr.join(outcomes, ", ")}`
            );
            assert.strictEqual((yield* Ref.get(prepared)).length, 1);
            assert.deepStrictEqual(yield* probeRows, [
              "2026-10-27T12:00:00.000Z#1",
            ]);
            assert.strictEqual(
              Arr.filter(yield* jobRuns, (row) => row.job === "semesters")
                .length,
              1
            );
          })
      );

      layerTest.effect(
        "falsifier 8: a run killed after a committed chunk resumes at its cursor and reaches what an uninterrupted run reaches",
        () =>
          Effect.gen(function* killedRun() {
            yield* TestClock.setTime(DateTime.toEpochMillis(tickAt(10)));

            const total = 4;
            const job = declared("endingSoon", { chunksPerTick: 10 });

            // Uninterrupted, at its own tick.
            const calmPrepared = yield* Ref.make<readonly string[]>([]);

            yield* dispatchTick(
              [job],
              { endingSoon: probeRunner({ prepared: calmPrepared, total }) },
              { at: tickAt(10) }
            );

            // Killed: the third chunk waits at a gate, and the tick is interrupted while it waits.
            const reached = yield* Deferred.make<null>();
            const killedPrepared = yield* Ref.make<readonly string[]>([]);

            const killed = probeRunner({
              gate: (chunk) =>
                chunk === 3
                  ? Effect.andThen(
                      Deferred.succeed(reached, null),
                      Effect.never
                    )
                  : Effect.void,
              prepared: killedPrepared,
              total,
            });

            const fiber = yield* Effect.forkChild(
              dispatchTick([job], { endingSoon: killed }, { at: tickAt(20) })
            );

            yield* Deferred.await(reached);
            yield* Fiber.interrupt(fiber);

            const running = runOf(yield* jobRuns, "endingSoon", "12:20");

            assert.strictEqual(running.outcome, "running");
            assert.strictEqual(
              running.cursor,
              2,
              "two chunks committed with their cursor"
            );

            // The lease runs out; the next tick resumes the killed period at its cursor.
            yield* TestClock.adjust("3 minutes");

            const resumedPrepared = yield* Ref.make<readonly string[]>([]);

            const resumed = yield* dispatchTick(
              [job],
              { endingSoon: probeRunner({ prepared: resumedPrepared, total }) },
              { at: tickAt(30) }
            );

            assert.isTrue(
              Arr.some(
                resumed[0]?.periods ?? [],
                (period) => period.result === "done"
              )
            );
            assert.deepStrictEqual(
              Arr.filter(yield* Ref.get(resumedPrepared), (call) =>
                call.includes("12:20")
              ),
              ["2026-10-27T12:20:00.000Z#3", "2026-10-27T12:20:00.000Z#4"],
              "the resumed run prepared only chunks 3 and 4 of the killed period"
            );

            const rows = yield* probeRows;

            const chunksOf = (marker: string) =>
              Arr.map(
                Arr.filter(rows, (row) => row.includes(marker)),
                (row) => row.slice(row.indexOf("#"))
              );

            assert.deepStrictEqual(chunksOf("12:10"), ["#1", "#2", "#3", "#4"]);
            assert.deepStrictEqual(
              chunksOf("12:20"),
              ["#1", "#2", "#3", "#4"],
              "the killed run has each chunk once: none lost, none doubled"
            );

            // The tick at 12:30 also started its own period; the two that this test compares are 12:10 and 12:20.
            const finished = Arr.filter(
              yield* jobRuns,
              (row) =>
                row.job === "endingSoon" &&
                (row.period.includes("12:10") || row.period.includes("12:20"))
            );

            assert.deepStrictEqual(
              Arr.map(finished, (row) => [row.outcome, row.counts]),
              [
                ["done", { chunks: 4 }],
                ["done", { chunks: 4 }],
              ]
            );
          })
      );

      layerTest.effect(
        "falsifier 9: a job above its chunk budget continues on the next tick, and no tick runs more chunks than declared",
        () =>
          Effect.gen(function* budget() {
            yield* TestClock.setTime(DateTime.toEpochMillis(tickAt(100)));

            const job = declared("workspaceSync", { chunksPerTick: 2 });
            const prepared = yield* Ref.make<readonly string[]>([]);
            const runner = probeRunner({ prepared, total: 5 });

            const calls: number[] = [];
            const results: string[] = [];

            for (const minutes of [100, 110, 120]) {
              const before = (yield* Ref.get(prepared)).length;

              const reports = yield* dispatchTick(
                [job],
                { workspaceSync: runner },
                { at: tickAt(minutes) }
              );

              calls.push((yield* Ref.get(prepared)).length - before);
              results.push(
                Arr.join(
                  Arr.map(reports[0]?.periods ?? [], (period) => period.result),
                  "+"
                )
              );
            }

            // Tick 3 finishes the first period (one chunk) and the tick's own period starts with the chunk that is left.
            assert.deepStrictEqual(
              calls,
              [2, 2, 2],
              "no tick runs more chunks than declared"
            );
            assert.deepStrictEqual(results, [
              "partial",
              "partial",
              "done+partial",
            ]);

            const run = runOf(yield* jobRuns, "workspaceSync");

            assert.deepStrictEqual(
              [run.outcome, run.counts, run.attempt],
              ["done", { chunks: 5 }, 3]
            );
          })
      );

      layerTest.effect(
        "falsifier 9: one job's failure does not cancel another due job, and the failed attempt is recorded for a later tick",
        () =>
          Effect.gen(function* isolation() {
            yield* TestClock.setTime(DateTime.toEpochMillis(tickAt(200)));

            const failing = declared("outboxSweep", {
              chunksPerTick: 1,
              maxAttempts: 2,
            });

            const healthy = declared("semesters", { chunksPerTick: 1 });
            const prepared = yield* Ref.make<readonly string[]>([]);

            const broken: Runner<SqlClient> = {
              prepare: () => Effect.die("the provider blew up"),
            };

            const reports = yield* dispatchTick(
              [failing, healthy],
              {
                outboxSweep: broken,
                semesters: probeRunner({ prepared, total: 1 }),
              },
              { at: tickAt(200) }
            );

            assert.deepStrictEqual(
              Arr.map(reports, (report) => [
                report.job,
                Arr.join(
                  Arr.map(report.periods, (period) => period.result),
                  ","
                ),
              ]),
              [
                ["outboxSweep", "retry"],
                ["semesters", "done"],
              ]
            );
            assert.strictEqual((yield* Ref.get(prepared)).length, 1);

            const row = runOf(yield* jobRuns, "outboxSweep");

            assert.strictEqual(row.outcome, "partial");
            assert.include(row.last_error ?? "", "the provider blew up");
          })
      );

      layerTest.effect(
        "falsifier 9: only the named jobs run in an explicit invocation, a cron that no job declares runs none, and no cron runs every job",
        () =>
          Effect.gen(function* explicit() {
            yield* TestClock.setTime(DateTime.toEpochMillis(tickAt(300)));

            const prepared = yield* Ref.make<readonly string[]>([]);
            const first = declared("semesters", { chunksPerTick: 1 });
            const second = declared("endingSoon", { chunksPerTick: 1 });

            const runners = {
              endingSoon: probeRunner({ prepared, total: 1 }),
              semesters: probeRunner({ prepared, total: 1 }),
            };

            const only = yield* dispatchTick([first, second], runners, {
              at: tickAt(300),
              only: ["endingSoon"],
            });

            assert.deepStrictEqual(
              Arr.map(only, (report) => report.job),
              ["endingSoon"]
            );

            const elsewhere = yield* dispatchTick([first, second], runners, {
              at: tickAt(310),
              cron: "0 4 * * *",
            });

            assert.deepStrictEqual(elsewhere, []);

            const everything = yield* dispatchTick([first, second], runners, {
              at: tickAt(320),
              cron: "",
            });

            assert.deepStrictEqual(
              Arr.map(everything, (report) => report.job),
              ["semesters", "endingSoon"],
              "the local trigger passes no cron, and then every job's due check runs, in declaration order"
            );
          })
      );
    });
  }
);
