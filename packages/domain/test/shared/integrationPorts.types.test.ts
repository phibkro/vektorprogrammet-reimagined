/**
 * Spec 0020, falsifier F11 (ADR 0015, section 10, rule 1): a program that requires an integration port does not
 * type-check as the argument of `Transactor.run`, and the same call after the transaction has committed does.
 *
 * `Accepts<R>` asks the call-site question of the real signature of `run`: is it assignable to a function that takes a
 * program with requirements `R`? TypeScript infers the type parameters of `run` from that parameter and, when `R`
 * breaks the bound, falls back to the bound, which no such program matches. So the refused cases are positive type
 * assertions that suppress nothing, in the style of `transactionRequired.test.ts`, and `vp check` fails the day one of
 * them flips (removing the bound from `run`, or the marker from a port, makes them fail). The last case is the limit:
 * the rule reads a program's requirements, so a program that builds its own provider inside is not refused.
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

type Run = Transactor["Service"];

/** Whether `Transactor.run` takes a program whose requirements are `R`. */
type Accepts<R> = Run["run"] extends (
  program: Effect.Effect<void, never, R>
) => Effect.Effect<void, never, Exclude<R, InTransaction>>
  ? true
  : false;

/** A command that writes: it needs the transaction and the outbox, which is a store port, not another system. */
declare const enqueue: Effect.Effect<void, never, InTransaction | Outbox>;

/** A call to the Google Workspace directory: provider I/O. */
const readsDirectory = Effect.gen(function* readsDirectory() {
  const directory = yield* WorkspaceDirectory;

  return yield* Effect.orDie(directory.accounts);
});

const committed = (transactor: Run) => transactor.run(enqueue);

/** The same read, after the transaction has committed. */
const afterwards = (transactor: Run) =>
  transactor.run(enqueue).pipe(Effect.andThen(readsDirectory));

/** A program that builds its provider inside: it requires nothing, so `run` takes it. */
const providedInside = (transactor: Run) =>
  transactor.run(
    readsDirectory.pipe(
      Effect.provideService(WorkspaceDirectory, {
        accounts: Effect.succeed<readonly CompanyEmail[]>([]),
        groups: Effect.succeed<readonly CompanyEmail[]>([]),
        members: () => Effect.succeed("missing"),
      })
    )
  );

describe("no integration call inside a transaction (spec 0020, F11)", () => {
  it("marks the ports of other systems and no store port", () => {
    expectTypeOf<WorkspaceDirectory>().toExtend<IntegrationPort>();
    expectTypeOf<WorkspaceWriter>().toExtend<IntegrationPort>();
    expectTypeOf<Outbox>().not.toExtend<IntegrationPort>();
  });

  it("refuses a program that requires an integration port, alone or among others", () => {
    expectTypeOf<Accepts<WorkspaceDirectory>>().toEqualTypeOf<false>();
    expectTypeOf<Accepts<WorkspaceWriter>>().toEqualTypeOf<false>();
    expectTypeOf<Accepts<Outbox | WorkspaceWriter>>().toEqualTypeOf<false>();
  });

  it("control: it takes a program that requires store ports or nothing, and takes the transaction off its requirements", () => {
    expectTypeOf<Accepts<Outbox>>().toEqualTypeOf<true>();
    expectTypeOf<Accepts<InTransaction | Outbox>>().toEqualTypeOf<true>();
    expectTypeOf<Accepts<never>>().toEqualTypeOf<true>();

    expectTypeOf<
      Effect.Services<ReturnType<typeof committed>>
    >().toEqualTypeOf<Outbox>();
  });

  it("control: the same call after the transaction has committed type-checks and keeps its requirements", () => {
    expectTypeOf<
      Effect.Services<ReturnType<typeof afterwards>>
    >().toEqualTypeOf<Outbox | WorkspaceDirectory>();
  });

  it("does not see a provider that the program builds inside (the limit of the rule)", () => {
    expectTypeOf<
      Effect.Services<ReturnType<typeof providedInside>>
    >().toEqualTypeOf<never>();
  });
});
