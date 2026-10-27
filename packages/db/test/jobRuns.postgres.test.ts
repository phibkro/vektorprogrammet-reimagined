/**
 * `JobRuns` on real PostgreSQL (spec 0008): a period is claimed by exactly one of any number of concurrent callers
 * (falsifier 7), a taken-over runner is fenced out, and a chunk's cursor commits with the chunk or not at all
 * (falsifier 8's repository half). Race tests repeat the race in fresh state, name their round count and print each
 * failing round's cause; the control removes the constraint that the claim rests on and fails every time.
 */
import { assert, layer } from "@effect/vitest";
import { Job, JobRun } from "@vektorprogrammet/domain";
import { and, eq } from "drizzle-orm";
import { Array as Arr, Cause, DateTime, Effect, Exit, Predicate } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { TestClock } from "effect/testing";

import { schema, transactional } from "../src/index.ts";
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
    LEASE
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
                    runs.claim("workspaceSync", value, LEASE)
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
                    runs.claim("workspaceSync", value, LEASE)
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
            (yield* runs.claim("workspaceSync", done, LEASE))._tag,
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
            (yield* runs.claim("workspaceSync", flaky, LEASE))._tag,
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

    it.layer(TestClock.layer())((layerTest) => {
      layerTest.effect(
        "a live lease is Taken, an expired one is taken over, and the runner that lost it is fenced out",
        () =>
          Effect.gen(function* leases() {
            yield* TestClock.setTime(DateTime.toEpochMillis(AT));

            const runs = yield* JobRun.JobRuns;
            const value = period("lease");
            const first = yield* claimHeld(value);

            assert.strictEqual(
              (yield* runs.claim("workspaceSync", value, LEASE))._tag,
              "Taken"
            );
            assert.deepStrictEqual(yield* runs.resumable("workspaceSync"), []);

            yield* TestClock.adjust(`${LEASE + 1} seconds`);

            assert.deepStrictEqual(yield* runs.resumable("workspaceSync"), [
              value,
            ]);

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
                      LEASE
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
