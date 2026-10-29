/**
 * Spec 0008b: which stage has a queue. A Preview must neither produce to nor consume the base stage's queue, so it has
 * none, and the stages that have one name it for themselves. The type check cannot say this (`OUTBOX_QUEUE` is optional in
 * `WorkerEnv`), so this is where a change to the decision fails.
 */
import { assert, describe, it } from "@effect/vitest";
import { Option, String as Str } from "effect";

import {
  BASE_STAGE,
  DEAD_LETTER_SUFFIX,
  outboxQueuesFor,
} from "../worker.config";

describe("spec 0008b: the stage decides whether there is an outbox queue", () => {
  it("a Worker Preview has no queue and no dead-letter queue, whatever its stage is called", () => {
    for (const stage of ["pr-44", "pr-1", "preview", "staging", "Main"]) {
      assert.isTrue(Option.isNone(outboxQueuesFor(stage)), stage);
    }
  });

  it("the base stage and production each have a pair named for their own stage, and never each other's", () => {
    const base = Option.getOrThrow(outboxQueuesFor(BASE_STAGE));
    const production = Option.getOrThrow(outboxQueuesFor("production"));

    assert.deepStrictEqual(base, {
      deadLetter: "vp-outbox-main-dlq",
      queue: "vp-outbox-main",
    });
    assert.deepStrictEqual(production, {
      deadLetter: "vp-outbox-production-dlq",
      queue: "vp-outbox-production",
    });
    assert.isTrue(Str.endsWith(DEAD_LETTER_SUFFIX)(base.deadLetter));
    assert.notStrictEqual(base.queue, production.queue);
    assert.notStrictEqual(base.deadLetter, production.deadLetter);
  });
});
