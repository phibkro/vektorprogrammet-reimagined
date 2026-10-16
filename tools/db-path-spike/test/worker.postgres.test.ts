/**
 * Spec 0000, rehearsed locally: the Worker's checks against devenv's PostgreSQL 18, so a
 * deployed failure can be told from a bug in the checks themselves. Each negative control
 * changes the schema so that the check it guards must fail.
 */
import { assert, layer } from "@effect/vitest";
import { Array as Arr, Duration, Effect, Predicate, Random } from "effect";
import type { Schema } from "effect";

import { codecSamples } from "../src/fixtures.ts";
import * as Protocol from "../src/protocol.ts";
import { abortTransaction } from "../src/worker/checks.ts";
import { requestDatabase } from "../src/worker/database.ts";
import {
  LocalWorker,
  answerOf,
  localWorker,
  localWorkerVersion,
} from "./support/localWorker.ts";
import type { CallOptions } from "./support/localWorker.ts";

const CALLERS = 20;

const freshRun = Effect.map(
  Random.nextIntBetween(10_000_000, 99_999_999),
  (n) => `run-${n}`
);

const send = Effect.fnUntraced(function* send<A>(
  schema: Schema.Codec<A>,
  options: CallOptions
) {
  const worker = yield* LocalWorker;

  return yield* answerOf(schema)(yield* worker.call(options));
});

const labelsOf = (run: string) =>
  Effect.map(
    send(Protocol.Rows, {
      method: "GET",
      params: { run },
      path: Protocol.routes.rows,
    }),
    (rows) => rows.labels
  );

const postRun = <A>(schema: Schema.Codec<A>, path: string, run: string) =>
  send(schema, { method: "POST", params: { run }, path });

const upsertParams = (year: number, mode: "nothing" | "update") => ({
  mode,
  term: "HOST",
  year: String(year),
});

const upsert = (year: number, mode: "nothing" | "update") =>
  send(Protocol.Upserted, {
    method: "POST",
    params: upsertParams(year, mode),
    path: Protocol.routes.upsert,
  });

layer(localWorker(), { excludeTestServices: true })(
  "the spike checks on a local PostgreSQL",
  (it) => {
    it.effect(
      "CHECK-1: select 1 through the SqlClient and through Drizzle, as vp_app",
      () =>
        Effect.gen(function* check1() {
          const connect = yield* send(Protocol.Connect, {
            method: "GET",
            path: Protocol.routes.connect,
          });

          assert.strictEqual(connect.sqlOne, 1);
          assert.strictEqual(connect.drizzleOne, 1);
          assert.strictEqual(connect.user, "vp_app");
          assert.strictEqual(connect.hyperdriveHost, "127.0.0.1");
          assert.match(connect.version, /^PostgreSQL 18\./u);
          assert.strictEqual(connect.workerVersion, localWorkerVersion);
        })
    );

    it.effect(
      "CHECK-2: a committed transaction is visible to a later request",
      () =>
        Effect.gen(function* check2() {
          const run = yield* freshRun;

          const committed = yield* postRun(
            Protocol.Committed,
            Protocol.routes.commit,
            run
          );

          assert.isTrue(committed.committed);
          assert.deepStrictEqual(yield* labelsOf(run), ["commit"]);
        })
    );

    it.effect("CHECK-3a: a typed failure rolls the Drizzle write back", () =>
      Effect.gen(function* check3a() {
        const run = yield* freshRun;

        const rolledBack = yield* postRun(
          Protocol.RolledBack,
          Protocol.routes.rollbackTyped,
          run
        );

        assert.strictEqual(rolledBack.failure, "SpikeRollback");
        assert.deepStrictEqual(yield* labelsOf(run), []);
      })
    );

    it.effect(
      "CHECK-3b: an aborted request rolls the open transaction back",
      () =>
        Effect.gen(function* check3b() {
          const worker = yield* LocalWorker;
          const run = yield* freshRun;

          // Leaving the scope aborts the request's signal: the client hangs up mid-transaction.
          const first = yield* Effect.scoped(
            Effect.gen(function* hangUp() {
              const signal = yield* Effect.abortSignal;

              const response = yield* worker.call({
                method: "POST",
                params: { run },
                path: Protocol.routes.abort,
                signal,
              });

              const reader = (yield* Effect.fromNullishOr(
                response.body
              )).getReader();

              return yield* Effect.promise(async () => await reader.read());
            })
          );

          assert.strictEqual(
            new TextDecoder().decode(first.value),
            `${Protocol.ABORT_READY_LINE}\n`
          );

          yield* worker.settle;

          const probe = yield* postRun(
            Protocol.AbortProbe,
            Protocol.routes.abortProbe,
            run
          );

          assert.isTrue(probe.free);
          assert.deepStrictEqual(yield* labelsOf(run), []);
        })
    );

    it.effect(
      "CHECK-3b negative control: a transaction nobody interrupts commits, and the probe sees the key taken",
      () =>
        Effect.gen(function* check3bControl() {
          const worker = yield* LocalWorker;
          const run = yield* freshRun;

          yield* abortTransaction(run, Effect.void, Duration.millis(100)).pipe(
            Effect.provide(requestDatabase(worker.env))
          );

          const probe = yield* postRun(
            Protocol.AbortProbe,
            Protocol.routes.abortProbe,
            run
          );

          assert.isFalse(probe.free);
          assert.deepStrictEqual(yield* labelsOf(run), ["abort"]);
        })
    );

    it.effect(
      "CHECK-4: the inner savepoint rolls back and the outer commit stays",
      () =>
        Effect.gen(function* check4() {
          const run = yield* freshRun;

          const nested = yield* postRun(
            Protocol.RolledBack,
            Protocol.routes.savepoint,
            run
          );

          assert.strictEqual(nested.failure, "SpikeRollback");
          assert.deepStrictEqual(yield* labelsOf(run), ["outer"]);
        })
    );

    it.effect(
      "CHECK-5: DO NOTHING returns the row, then none; DO UPDATE returns the row, then the same row",
      () =>
        Effect.gen(function* check5() {
          const year = 20_000 + (yield* Random.nextIntBetween(0, 9999));

          const created = yield* upsert(year, "nothing");
          const again = yield* upsert(year, "nothing");

          assert.strictEqual(created.row?.year, year);
          assert.strictEqual(again.row, null);

          const viaUpdate = yield* upsert(year + 1, "update");
          const viaUpdateAgain = yield* upsert(year + 1, "update");

          assert.isNotNull(viaUpdate.row);
          assert.deepStrictEqual(viaUpdateAgain.row, viaUpdate.row);
        })
    );

    it.effect(
      "CHECK-6: a unique violation is AlreadyExists, not a defect",
      () =>
        Effect.gen(function* check6() {
          const year = 30_000 + (yield* Random.nextIntBetween(0, 9999));

          const unique = yield* send(Protocol.Unique, {
            method: "POST",
            params: { term: "VAR", year: String(year) },
            path: Protocol.routes.unique,
          });

          assert.deepStrictEqual(
            unique.classified,
            Protocol.ClassifiedAlreadyExists.make({
              entity: "Semester",
              key: `VAR ${year}`,
            })
          );
        })
    );

    it.effect(
      "CHECK-7: timestamptz, date, jsonb and numeric round trip through Drizzle and the SqlClient",
      () =>
        Effect.gen(function* check7() {
          const run = yield* freshRun;

          const { reads } = yield* postRun(
            Protocol.Codec,
            Protocol.routes.codec,
            run
          );

          assert.strictEqual(reads.length, codecSamples.length * 2);

          for (const read of reads) {
            const sample = codecSamples[Math.floor(read.slot / 2)];

            const expected = {
              amount: sample?.amount,
              at: sample?.at,
              day: sample?.day,
              doc: sample?.doc,
            };

            assert.deepStrictEqual(read.drizzle, expected);
            assert.deepStrictEqual(read.sql, expected);
          }
        })
    );

    it.effect(
      "CHECK-8: 20 concurrent upserts of one key give exactly one row",
      () =>
        Effect.gen(function* check8() {
          const year = 40_000 + (yield* Random.nextIntBetween(0, 9999));

          const answers = yield* Effect.forEach(
            Arr.range(1, CALLERS),
            () => upsert(year, "update"),
            { concurrency: "unbounded" }
          );

          const rows = yield* send(Protocol.Semesters, {
            method: "GET",
            params: { term: "HOST", year: String(year) },
            path: Protocol.routes.semesters,
          });

          assert.strictEqual(rows.rows.length, 1);
          assert.isTrue(
            Arr.every(answers, (answer) => answer.row?.id === rows.rows[0]?.id)
          );
        })
    );

    it.effect(
      "CHECK-11: every write is read back at once, within and across requests",
      () =>
        Effect.gen(function* check11() {
          const run = yield* freshRun;

          for (const from of [1, 6]) {
            const { rounds } = yield* send(Protocol.Cache, {
              method: "POST",
              params: { from: String(from), run },
              path: Protocol.routes.cache,
            });

            assert.strictEqual(rounds.length, 5);
            assert.isTrue(
              Arr.every(rounds, (round) => round.read === round.wrote)
            );
          }
        })
    );

    it.effect(
      "an undecodable parameter and an unknown route are 400 bad requests",
      () =>
        Effect.gen(function* badRequests() {
          const worker = yield* LocalWorker;

          const badRun = yield* worker.call({
            method: "POST",
            params: { run: "x" },
            path: Protocol.routes.commit,
          });

          const unknown = yield* worker.call({
            method: "GET",
            path: "/nowhere",
          });

          for (const response of [badRun, unknown]) {
            const body = yield* answerOf(Protocol.ErrorBody)(response);

            assert.strictEqual(response.status, 400);
            assert.strictEqual(body.error.kind, "bad-request");
          }
        })
    );
  }
);

layer(
  localWorker({
    surgery: [
      "alter table spike_0000.spike_semester drop constraint semester_term_year_unique",
    ],
  }),
  { excludeTestServices: true }
)("negative control: without the unique constraint", (it) => {
  it.effect("CHECK-8 must fail: the 20-way upsert no longer succeeds", () =>
    Effect.gen(function* check8Control() {
      const answers = yield* Effect.forEach(
        Arr.range(1, CALLERS),
        () =>
          LocalWorker.use((worker) =>
            worker.call({
              method: "POST",
              params: upsertParams(50_000, "update"),
              path: Protocol.routes.upsert,
            })
          ),
        { concurrency: "unbounded" }
      );

      assert.isTrue(Arr.some(answers, (response) => response.status !== 200));
    })
  );
});

layer(
  localWorker({
    surgery: [
      "alter table spike_0000.spike_semester rename constraint semester_term_year_unique to spike_other_unique",
    ],
  }),
  { excludeTestServices: true }
)("negative control: a constraint classifySqlFailure does not know", (it) => {
  it.effect("CHECK-6 must fail: the violation is a defect", () =>
    Effect.gen(function* check6Control() {
      const unique = yield* send(Protocol.Unique, {
        method: "POST",
        params: { term: "VAR", year: "60000" },
        path: Protocol.routes.unique,
      });

      assert.isTrue(Predicate.isTagged(unique.classified, "Defect"));
    })
  );
});
