/**
 * Spec 0020, falsifier F11 (ADR 0015, section 10, rule 1): a program that requires an integration port does not
 * type-check as the argument of `Transactor.run`, and the same call after the transaction has committed does. The
 * refused cases carry `@ts-expect-error` (EX-0050), so `vp check` fails the day one of them starts to compile; the
 * controls suppress nothing. The last case is the limit: the rule reads a program's requirements, so a program that
 * builds its own provider inside is not refused.
 */
import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { expectTypeOf } from "vite-plus/test";

import type { Outbox } from "../../src/shared/outbox.ts";
import type {
  IntegrationPort,
  InTransaction,
} from "../../src/shared/transaction.ts";
import type { Transactor } from "../../src/shared/transactor.ts";
import type { CompanyEmail } from "../../src/workspace/companyEmail.ts";
import type { WorkspaceWriter } from "../../src/workspace/services.ts";
import { WorkspaceDirectory } from "../../src/workspace/services.ts";

declare const transactor: Transactor["Service"];

/** A command that writes: it needs the transaction and the outbox, which is a store port, not another system. */
declare const enqueue: Effect.Effect<void, never, InTransaction | Outbox>;

/** A call to the Google Workspace directory: provider I/O. */
const readsDirectory = Effect.gen(function* readsDirectory() {
  const directory = yield* WorkspaceDirectory;

  return yield* Effect.orDie(directory.accounts);
});

declare const appliesChange: Effect.Effect<void, never, WorkspaceWriter>;

describe("no integration call inside a transaction (spec 0020, F11)", () => {
  it("marks the ports of other systems and no store port", () => {
    expectTypeOf<WorkspaceDirectory>().toExtend<IntegrationPort>();
    expectTypeOf<WorkspaceWriter>().toExtend<IntegrationPort>();
    expectTypeOf<Outbox>().not.toExtend<IntegrationPort>();
  });

  it("refuses a program that requires an integration port", () => {
    // @ts-expect-error EX-0050: F11, the directory is called inside the transaction.
    const read = transactor.run(readsDirectory);

    // @ts-expect-error EX-0050: F11, the writer is called inside the transaction.
    const write = transactor.run(appliesChange);

    // @ts-expect-error EX-0050: F11, one port among others is enough.
    const both = transactor.run(Effect.andThen(enqueue, appliesChange));

    expectTypeOf([read, write, both]).not.toBeNever();
  });

  it("allows a program that requires store ports, and takes the transaction off its requirements", () => {
    const committed = transactor.run(enqueue);

    expectTypeOf<Effect.Services<typeof committed>>().toEqualTypeOf<Outbox>();
  });

  it("allows the same call after the transaction has committed", () => {
    const afterwards = transactor
      .run(enqueue)
      .pipe(Effect.andThen(readsDirectory));

    expectTypeOf<Effect.Services<typeof afterwards>>().toEqualTypeOf<
      Outbox | WorkspaceDirectory
    >();
  });

  it("does not see a provider that the program builds inside (the limit of the rule)", () => {
    const inside = readsDirectory.pipe(
      Effect.provideService(WorkspaceDirectory, {
        accounts: Effect.succeed<readonly CompanyEmail[]>([]),
        groups: Effect.succeed<readonly CompanyEmail[]>([]),
        members: () => Effect.succeed("missing"),
      })
    );

    expectTypeOf(transactor.run(inside)).toExtend<Effect.Effect<unknown>>();
  });
});
