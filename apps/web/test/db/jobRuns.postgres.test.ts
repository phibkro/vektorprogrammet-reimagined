/**
 * `JobRuns` on real PostgreSQL (spec 0008): a period is claimed by exactly one of any number of concurrent callers
 * (falsifier 7), a taken-over runner is fenced out, and a chunk's cursor commits with the chunk or not at all
 * (falsifier 8's repository half). Race tests repeat the race in fresh state, name their round count and print each
 * failing round's cause; the control removes the constraint that the claim rests on and fails every time.
 */
import { assert, layer } from "@effect/vitest";
import { and, eq } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import {
  Array as Arr,
  Cause,
  DateTime,
  Effect,
  Exit,
  Predicate,
  Option,
} from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { TestClock } from "effect/testing";

import * as schema from "../../src/adapters/db/schema.ts";
import { transactional } from "../../src/adapters/db/transactional.ts";
import * as Job from "../../src/core/jobs/job";
import * as JobRun from "../../src/core/jobs/runs";
import { Drizzle, postgresDatabase } from "./support/database.ts";
import { AT } from "./support/fixtures.ts";
import { race } from "./support/race.ts";

const ROUNDS = 100;
const RACERS = 20;
const LEASE = 60;

const period = (value: string) => Job.JobPeriod.make(value);

const rowsOf = Effect.fnUntraced(function* rowsOf(
  job: "workspaceSync",
  value: Job.JobPeriod
) {
  const db = yield* Drizzle;

  return yield* db
    .select()
    .from(schema.jobRun)
    .where(and(eq(schema.jobRun.job, job), eq(schema.jobRun.period, value)));
});

const claimed = (claims: readonly JobRun.Claim[]) =>
  Arr.filter(claims, (claim) => Predicate.isTagged(claim, "Claimed"));

/** `claim`, held to the one that a test names; a period that no one claimed is a failed test, not a null. */
const claimHeld = Effect.fnUntraced(function* claimHeld(value: Job.JobPeriod) {
  const claim = yield* (yield* JobRun.JobRuns).claim(
    "workspaceSync",
    value,
    LEASE,
    3
  );

  if (!Predicate.isTagged(claim, "Claimed")) {
    return yield* Effect.die(`${value} was not claimed: ${claim._tag}`);
  }

  return claim.held;
});

layer(postgresDatabase(), { excludeTestServices: true })(
  "job runs on PostgreSQL",
  (it) => {
    it.effect(
      "F-c: PostgreSQL refuses done without ended_at for insert and update",
      () =>
        Effect.gen(function* completionCheck() {
          const sql = yield* SqlClient;

          const inserted = yield* Effect.exit(
            sql`insert into job_run (job, period, outcome, lease_until) values ('workspaceSync', 'invalid-done', 'done', now())`
          );

          assert.isTrue(Exit.isFailure(inserted));

          if (Exit.isFailure(inserted)) {
            assert.include(Cause.pretty(inserted.cause), "job_run_done_ended");
          }

          const held = yield* claimHeld(period("invalid-update"));

          const updated = yield* Effect.exit(
            sql`update job_run set outcome = 'done' where job = ${held.job} and period = ${held.period}`
          );

          assert.isTrue(Exit.isFailure(updated));

          if (Exit.isFailure(updated)) {
            assert.include(Cause.pretty(updated.cause), "job_run_done_ended");
          }

          yield* transactional((yield* JobRun.JobRuns).finish(held, {}));
        })
    );
    it.effect(
      `falsifier 7: ${RACERS} concurrent claims of one period, in each of ${ROUNDS} fresh rounds, leave one winner and one row`,
      () =>
        Effect.gen(function* claimRounds() {
          const runs = yield* JobRun.JobRuns;

          const losers = yield* Effect.forEach(
            Arr.range(1, ROUNDS),
            (round) =>
              Effect.gen(function* oneRound() {
                const value = period(`race-${round}`);

                const exits = yield* race(
                  Arr.makeBy(RACERS, () =>
                    runs.claim("workspaceSync", value, LEASE, 3)
                  )
                );

                const failures = Arr.flatMap(exits, (exit) =>
                  Exit.isFailure(exit)
                    ? [`round ${round}: ${Cause.pretty(exit.cause)}`]
                    : []
                );

                const wins = claimed(
                  Arr.flatMap(exits, (exit) =>
                    Exit.isSuccess(exit) ? [exit.value] : []
                  )
                );

                const rows = yield* rowsOf("workspaceSync", value);

                return wins.length === 1 && rows.length === 1
                  ? failures
                  : [
                      ...failures,
                      `round ${round}: ${wins.length} winners, ${rows.length} rows`,
                    ];
              }),
            { concurrency: 1 }
          );

          assert.deepStrictEqual(Arr.flatten(losers), []);
        }),
      { timeout: 120_000 }
    );

    it.effect(
      `a requested period is taken over by exactly one of ${RACERS} racers, in each of ${ROUNDS} fresh rounds`,
      () =>
        Effect.gen(function* takeOverRounds() {
          const runs = yield* JobRun.JobRuns;

          const wrong = yield* Effect.forEach(
            Arr.range(1, ROUNDS),
            (round) =>
              Effect.gen(function* oneRound() {
                const value = period(`request:${round}`);

                assert.isTrue(
                  yield* transactional(runs.request("workspaceSync", value))
                );
                assert.isFalse(
                  yield* transactional(runs.request("workspaceSync", value)),
                  "asking again for the same period adds nothing"
                );

                const exits = yield* race(
                  Arr.makeBy(RACERS, () =>
                    runs.claim("workspaceSync", value, LEASE, 3)
                  )
                );

                const wins = claimed(
                  Arr.flatMap(exits, (exit) =>
                    Exit.isSuccess(exit) ? [exit.value] : []
                  )
                );

                return wins.length === 1 &&
                  Predicate.isTagged(wins[0], "Claimed") &&
                  wins[0].held.attempt === 1
                  ? []
                  : [`round ${round}: ${wins.length} winners`];
              }),
            { concurrency: 1 }
          );

          assert.deepStrictEqual(Arr.flatten(wrong), []);
        }),
      { timeout: 120_000 }
    );

    it.effect(
      "a finished period is Finished, a failed attempt leaves it partial until the last, and then failed",
      () =>
        Effect.gen(function* lifecycle() {
          const runs = yield* JobRun.JobRuns;
          const done = period("lifecycle-done");
          const held = yield* claimHeld(done);

          yield* transactional(runs.finish(held, { rows: 3 }));

          assert.strictEqual(
            (yield* runs.claim("workspaceSync", done, LEASE, 3))._tag,
            "Finished"
          );
          assert.deepStrictEqual(
            (yield* rowsOf("workspaceSync", done))[0]?.counts,
            {
              rows: 3,
            }
          );

          const flaky = period("lifecycle-flaky");

          const first = yield* claimHeld(flaky);

          assert.strictEqual(
            yield* runs.fail(first, "provider down", 2),
            "retry"
          );

          const second = yield* claimHeld(flaky);

          assert.strictEqual(second.attempt, 2);
          assert.strictEqual(
            yield* runs.fail(second, "provider down", 2),
            "failed"
          );
          assert.strictEqual(
            (yield* runs.claim("workspaceSync", flaky, LEASE, 3))._tag,
            "Finished",
            "a failed period is left for the next period"
          );
          assert.strictEqual(
            (yield* rowsOf("workspaceSync", flaky))[0]?.outcome,
            "failed"
          );
        })
    );

    it.effect("a chunk and its cursor commit together, or not at all", () =>
      Effect.gen(function* chunkAndCursor() {
        const runs = yield* JobRun.JobRuns;
        const sql = yield* SqlClient;
        const value = period("atomic");
        const held = yield* claimHeld(value);

        yield* sql`create table if not exists job_run_probe (n integer)`;

        const attempt = (fail: boolean) =>
          Effect.exit(
            transactional(
              Effect.gen(function* chunk() {
                yield* sql`insert into job_run_probe (n) values (1)`;
                yield* runs.advance(
                  held,
                  { counts: { rows: 1 }, cursor: { after: 7 } },
                  LEASE
                );

                yield* fail
                  ? Effect.fail("the chunk failed after its cursor")
                  : Effect.void;
              })
            )
          );

        assert.isTrue(Exit.isFailure(yield* attempt(true)));
        assert.strictEqual(
          (yield* rowsOf("workspaceSync", value))[0]?.cursor,
          null,
          "a rolled-back chunk leaves no cursor"
        );
        assert.strictEqual(
          (yield* sql`select count(*)::int as n from job_run_probe`)[0]?.n,
          0,
          "and no row"
        );

        assert.isTrue(Exit.isSuccess(yield* attempt(false)));
        assert.deepStrictEqual(
          (yield* rowsOf("workspaceSync", value))[0]?.cursor,
          { after: 7 }
        );
        assert.strictEqual(
          (yield* sql`select count(*)::int as n from job_run_probe`)[0]?.n,
          1
        );
      })
    );

    it.effect(
      "falsifier 8 negative control: a chunk committed separately from its cursor leaves an orphan after failure",
      () =>
        Effect.gen(function* splitCommit() {
          const runs = yield* JobRun.JobRuns;
          const sql = yield* SqlClient;
          const value = period("split-control");
          const held = yield* claimHeld(value);
          yield* sql`create table if not exists job_run_probe (n integer)`;
          yield* sql`delete from job_run_probe where n = 2`;
          yield* sql`insert into job_run_probe (n) values (2)`;

          const failed = yield* Effect.exit(
            transactional(
              Effect.gen(function* badCursor() {
                yield* runs.advance(
                  held,
                  { counts: { rows: 1 }, cursor: { after: 2 } },
                  LEASE
                );

                return yield* Effect.fail("crash before cursor commits");
              })
            )
          );

          assert.isTrue(Exit.isFailure(failed));
          assert.strictEqual(
            (yield* rowsOf("workspaceSync", value))[0]?.cursor,
            null
          );
          assert.strictEqual(
            (yield* sql`select count(*)::int as n from job_run_probe where n = 2`)[0]
              ?.n,
            1
          );
        })
    );

    it.layer(TestClock.layer())((layerTest) => {
      layerTest.effect(
        "F-a: crash-only takeovers stop at maxAttempts without killing a live final lease",
        () =>
          Effect.gen(function* boundedCrashes() {
            yield* TestClock.setTime(DateTime.toEpochMillis(AT));
            const runs = yield* JobRun.JobRuns;
            const value = period("bounded-crashes");

            for (const attempt of [1, 2]) {
              const claim = yield* runs.claim("workspaceSync", value, LEASE, 2);
              assert.isTrue(Predicate.isTagged(claim, "Claimed"));

              if (Predicate.isTagged(claim, "Claimed")) {
                assert.strictEqual(claim.held.attempt, attempt);
              }

              assert.strictEqual(
                (yield* runs.claim("workspaceSync", value, LEASE, 2))._tag,
                "Taken"
              );
              yield* TestClock.adjust(`${LEASE + 1} seconds`);
            }

            const claims = yield* Effect.all(
              Arr.makeBy(RACERS, () =>
                runs.claim("workspaceSync", value, LEASE, 2)
              ),
              { concurrency: "unbounded" }
            );

            assert.isTrue(Arr.every(claims, Predicate.isTagged("Finished")));
            const [row] = yield* rowsOf("workspaceSync", value);
            assert.strictEqual(row?.attempt, 2);
            assert.strictEqual(row?.outcome, "failed");
            assert.strictEqual(
              row?.endedAt?.getTime(),
              DateTime.toEpochMillis(yield* DateTime.now)
            );
            assert.strictEqual(row?.lastError, "maximum attempts exhausted");
          })
      );

      layerTest.effect(
        "F-a: a budget release at the limit is terminalized by the next claim",
        () =>
          Effect.gen(function* boundedRelease() {
            const runs = yield* JobRun.JobRuns;
            const value = period("bounded-release");
            const claim = yield* runs.claim("workspaceSync", value, LEASE, 1);
            assert.isTrue(Predicate.isTagged(claim, "Claimed"));

            if (Predicate.isTagged(claim, "Claimed")) {
              assert.strictEqual(yield* runs.release(claim.held), "partial");
            }

            assert.strictEqual(
              (yield* runs.claim("workspaceSync", value, LEASE, 1))._tag,
              "Finished"
            );
            assert.strictEqual(
              (yield* rowsOf("workspaceSync", value))[0]?.attempt,
              1
            );
            assert.strictEqual(
              (yield* rowsOf("workspaceSync", value))[0]?.outcome,
              "failed"
            );
          })
      );

      layerTest.effect(
        "F-b: superseded release and both failure branches report lost without changing the successor",
        () =>
          Effect.gen(function* honestLostReports() {
            const runs = yield* JobRun.JobRuns;
            const value = period("lost-reports");
            const first = yield* claimHeld(value);
            yield* TestClock.adjust(`${LEASE + 1} seconds`);
            const second = yield* claimHeld(value);
            const before = yield* rowsOf("workspaceSync", value);
            assert.strictEqual(yield* runs.release(first), "lost");
            assert.strictEqual(
              yield* runs.fail(first, "stale retry", 3),
              "lost"
            );
            assert.strictEqual(
              yield* runs.fail(first, "stale failure", 1),
              "lost"
            );
            assert.deepStrictEqual(
              yield* rowsOf("workspaceSync", value),
              before
            );
            yield* transactional(runs.finish(second, {}));
            const finished = yield* rowsOf("workspaceSync", value);
            assert.strictEqual(yield* runs.release(second), "lost");
            assert.strictEqual(
              yield* runs.fail(second, "already finished", 1),
              "lost"
            );
            assert.deepStrictEqual(
              yield* rowsOf("workspaceSync", value),
              finished
            );
          })
      );
      layerTest.effect(
        "a live lease is Taken, an expired one is taken over, and the runner that lost it is fenced out",
        () =>
          Effect.gen(function* leases() {
            yield* TestClock.setTime(DateTime.toEpochMillis(AT));

            const runs = yield* JobRun.JobRuns;
            const value = period("lease");
            const first = yield* claimHeld(value);

            assert.strictEqual(
              (yield* runs.claim("workspaceSync", value, LEASE, 3))._tag,
              "Taken"
            );
            assert.deepStrictEqual(
              yield* runs.resumable("workspaceSync", "all"),
              []
            );

            yield* TestClock.adjust(`${LEASE + 1} seconds`);

            assert.deepStrictEqual(
              yield* runs.resumable("workspaceSync", "all"),
              [value]
            );

            const second = yield* claimHeld(value);

            assert.strictEqual(second.attempt, first.attempt + 1);

            const stale = yield* Effect.exit(
              transactional(
                runs.advance(
                  first,
                  { counts: { rows: 99 }, cursor: { after: 99 } },
                  LEASE
                )
              )
            );

            assert.isTrue(
              Exit.isFailure(stale) &&
                Predicate.isTagged(Cause.squash(stale.cause), "LeaseLost"),
              "the runner that lost the lease cannot advance"
            );
            assert.isTrue(
              Exit.isFailure(
                yield* Effect.exit(transactional(runs.finish(first, {})))
              ),
              "nor finish"
            );

            yield* transactional(
              runs.advance(
                second,
                { counts: { rows: 2 }, cursor: { after: 2 } },
                LEASE
              )
            );

            const [row] = yield* rowsOf("workspaceSync", value);

            assert.deepStrictEqual(row?.cursor, { after: 2 });
            assert.strictEqual(row?.attempt, 2);
          })
      );
    });
  }
);

layer(postgresDatabase(), { excludeTestServices: true })(
  "job runs on PostgreSQL, negative control",
  (it) => {
    it.effect(
      `falsifier 7, negative control: without the primary key, the same ${RACERS}-way race gives every racer the period, every time`,
      () =>
        Effect.gen(function* withoutKey() {
          const sql = yield* SqlClient;
          const runs = yield* JobRun.JobRuns;

          // The claim rests on this constraint: `INSERT … ON CONFLICT DO NOTHING` has nothing to conflict with
          // once it is gone, and every insert wins.
          yield* sql`alter table job_run drop constraint job_run_pk`;

          const wins = yield* Effect.forEach(
            Arr.range(1, 5),
            (round) =>
              Effect.map(
                race(
                  Arr.makeBy(RACERS, () =>
                    runs.claim(
                      "workspaceSync",
                      period(`unkeyed-${round}`),
                      LEASE,
                      3
                    )
                  )
                ),
                (exits) =>
                  claimed(
                    Arr.flatMap(exits, (exit) =>
                      Exit.isSuccess(exit) ? [exit.value] : []
                    )
                  ).length
              ),
            { concurrency: 1 }
          );

          assert.isTrue(
            Arr.every(wins, (count) => count > 1),
            `every round had more than one winner: ${Arr.join(Arr.map(wins, String), ", ")}`
          );
        }),
      { timeout: 60_000 }
    );
  }
);

const completionMigration = Option.getOrThrow(
  Arr.findFirst(
    readMigrationFiles({
      migrationsFolder: new URL("../../drizzle/", import.meta.url).pathname,
    }),
    (migration) => migration.name === "20261112175014_job_run_done_ended"
  )
);

layer(postgresDatabase(), { excludeTestServices: true })(
  "job-run completion migration",
  (it) => {
    it.effect(
      "F-c: migration preflight refuses old violations unchanged, then accepts valid rows",
      () =>
        Effect.gen(function* completionPreflight() {
          const sql = yield* SqlClient;

          yield* sql`alter table job_run drop constraint job_run_done_ended`;
          yield* sql`insert into job_run (job, period, outcome, lease_until) values ('workspaceSync', 'old-invalid-done', 'done', now())`;

          const apply = transactional(
            Effect.forEach(
              completionMigration.sql,
              (statement) => sql.unsafe(statement),
              { discard: true }
            )
          );

          const refused = yield* Effect.exit(apply);
          assert.isTrue(Exit.isFailure(refused));

          if (Exit.isFailure(refused)) {
            assert.include(
              Cause.pretty(refused.cause),
              "job_run_done_ended preflight"
            );
          }

          const [unchanged] =
            yield* sql`select outcome, ended_at from job_run where period = 'old-invalid-done'`;

          assert.deepStrictEqual(unchanged, {
            ended_at: null,
            outcome: "done",
          });
          // Explicit synthetic fixture correction, not migration behavior.
          yield* sql`update job_run set ended_at = now() where period = 'old-invalid-done'`;
          yield* apply;

          const invalid = yield* Effect.exit(
            sql`update job_run set ended_at = null where period = 'old-invalid-done'`
          );

          assert.isTrue(Exit.isFailure(invalid));
        })
    );
  }
);
