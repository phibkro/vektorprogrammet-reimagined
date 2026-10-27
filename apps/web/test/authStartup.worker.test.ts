/** The actual startup validator runs before workerd can accept requests. */
import { assert, it } from "@effect/vitest";
import { Effect, Exit } from "effect";

import { testWorker } from "./support/workerRuntime";

type TestBindings = Readonly<Record<string, string>>;

const invalidBindings: readonly TestBindings[] = [
  {},
  { BETTER_AUTH_SECRET: "short" },
];

it.effect(
  "a missing or short signing secret prevents Worker startup; a valid key starts it",
  () =>
    Effect.gen(function* startupChecks() {
      for (const bindings of invalidBindings) {
        const result = yield* Effect.gen(function* rejectedWorker() {
          const worker = yield* testWorker("authStartup.worker.ts", bindings);

          return yield* Effect.tryPromise(() =>
            worker.dispatchFetch("http://startup.test/")
          );
        }).pipe(Effect.scoped, Effect.exit);

        assert.isTrue(Exit.isFailure(result), "the Worker must fail to start");
      }

      const worker = yield* testWorker("authStartup.worker.ts", {
        BETTER_AUTH_SECRET: "local-test-signing-secret-at-least-32-bytes",
      });

      const response = yield* Effect.promise(() =>
        worker.dispatchFetch("http://startup.test/")
      );

      assert.strictEqual(response.status, 200);
      assert.strictEqual(yield* Effect.promise(() => response.text()), "ready");
    }).pipe(Effect.scoped),
  30_000
);
