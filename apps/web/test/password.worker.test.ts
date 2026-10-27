/** Spec 0007 falsifier 1: the actual bcrypt adapter bundled and executed in workerd. */
import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { testWorker } from "./support/workerRuntime";

const WorkerAnswer = Schema.Struct({
  defaultRejected: Schema.Boolean,
  newHashCost12: Schema.Boolean,
  newHashVerifies: Schema.Boolean,
  overLimitRejected: Schema.Boolean,
  truncatedRejected: Schema.Boolean,
  variants: Schema.Array(
    Schema.Struct({ matches: Schema.Boolean, wrong: Schema.Boolean })
  ),
});

it.effect(
  "RULE-024: PHP, $2a$, $2b$, truncation and default-verifier negative control in workerd",
  () =>
    Effect.gen(function* workerPasswordTest() {
      const worker = yield* testWorker("password.worker.ts");

      const response = yield* Effect.promise(() =>
        worker.dispatchFetch("http://password.test/")
      );

      assert.strictEqual(response.status, 200);
      const json = yield* Effect.promise(() => response.json());

      const answer = yield* Schema.decodeUnknownEffect(WorkerAnswer)(json).pipe(
        Effect.orDie
      );

      assert.deepStrictEqual(answer.variants, [
        { matches: true, wrong: false },
        { matches: true, wrong: false },
        { matches: true, wrong: false },
      ]);
      assert.isTrue(answer.truncatedRejected);
      assert.isTrue(answer.overLimitRejected);
      assert.isTrue(answer.newHashCost12);
      assert.isTrue(answer.newHashVerifies);
      assert.isTrue(answer.defaultRejected);

      return yield* Effect.void;
    }).pipe(Effect.scoped),
  30_000
);
