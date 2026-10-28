/**
 * Spec 0017 falsifier 3: what `Transactor.run` does to a program's requirements, as types. The port takes `InTransaction`
 * off and nothing else, so a command that needs the outbox still needs it after `run` (a `run` that erased the whole
 * requirement set would let a program through that no layer satisfies).
 */
import { describe, it } from "@effect/vitest";
import type { Effect } from "effect";
import { expectTypeOf } from "vite-plus/test";

import type { Outbox } from "../../src/shared/outbox.ts";
import type { InTransaction } from "../../src/shared/transaction.ts";
import type { Transactor } from "../../src/shared/transactor.ts";

const run = (
  transactor: Transactor["Service"],
  program: Effect.Effect<number, "refused", InTransaction | Outbox>
) => transactor.run(program);

describe("Transactor (spec 0017)", () => {
  it("run takes InTransaction off a program's requirements and keeps every other", () => {
    expectTypeOf(run).returns.toEqualTypeOf<
      Effect.Effect<number, "refused", Outbox>
    >();

    // The control: the two ways it could go wrong are different types.
    expectTypeOf(run).returns.not.toEqualTypeOf<
      Effect.Effect<number, "refused">
    >();

    expectTypeOf(run).returns.not.toEqualTypeOf<
      Effect.Effect<number, "refused", InTransaction | Outbox>
    >();
  });
});
