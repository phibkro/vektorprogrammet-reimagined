/**
 * Spec 0018, falsifier 1 (the ADR's falsifier): a program that calls one of these methods outside a transaction does
 * not type-check, because it requires `InTransaction` and nothing provides it; the same program through
 * `Transactor.run` has no such requirement. The cases are positive type assertions (no `@ts-expect-error`), in the
 * style of `transactor.test.ts`. `vp check` is what fails when a signature loses its requirement.
 *
 * The controls are the methods that stay standalone: they show no requirement, so the test tells the two apart.
 */
import { describe, it } from "@effect/vitest";
import type { Effect } from "effect";
import { expectTypeOf } from "vite-plus/test";

import type { AuditLog } from "../../src/audit/auditLog.ts";
import type { JobRuns } from "../../src/jobs/runs.ts";
import type { OutboxDelivery } from "../../src/outbox/delivery.ts";
import type { AlumniRequests } from "../../src/personalData/services.ts";
import type { Outbox } from "../../src/shared/outbox.ts";
import type { InTransaction } from "../../src/shared/transaction.ts";
import type { Transactor } from "../../src/shared/transactor.ts";
import type { DigestLedger } from "../../src/teams/services.ts";

interface Calls {
  readonly "AlumniRequests.claim": ReturnType<
    AlumniRequests["Service"]["claim"]
  >;
  readonly "AuditLog.record": ReturnType<AuditLog["Service"]["record"]>;
  readonly "DigestLedger.claim": ReturnType<DigestLedger["Service"]["claim"]>;
  readonly "Outbox.enqueue": ReturnType<Outbox["Service"]["enqueue"]>;
  // Controls: standalone methods.
  readonly "JobRuns.claim": ReturnType<JobRuns["Service"]["claim"]>;
  readonly "OutboxDelivery.markQueued": ReturnType<
    OutboxDelivery["Service"]["markQueued"]
  >;
}

/**
 * What `Transactor.run` makes of a call: it takes `InTransaction` off the requirements and nothing else. The law is
 * pinned for every program by `transactor.test.ts`, and the first case below ties this type to the real `run`.
 */
type Run<Call> =
  Call extends Effect.Effect<infer A, infer E, infer R>
    ? Effect.Effect<A, E, Exclude<R, InTransaction>>
    : never;

const runEnqueue = (
  transactor: Transactor["Service"],
  call: Calls["Outbox.enqueue"]
) => transactor.run(call);

/** What a call needs bare, and what it needs once `Transactor.run` has wrapped it. */
interface Needs<Call> {
  readonly outside: Effect.Services<Call>;
  readonly inside: Effect.Services<Run<Call>>;
}

type Outside<Call> = Effect.Services<Call> extends never ? never : Call;

describe("a call outside a transaction does not type-check (spec 0018)", () => {
  it("falsifier 1: Transactor.run makes of a call what `Run` says", () => {
    expectTypeOf(runEnqueue).returns.toEqualTypeOf<
      Run<Calls["Outbox.enqueue"]>
    >();
  });

  it("falsifier 1: Outbox.enqueue needs the transaction, and Transactor.run provides it", () => {
    expectTypeOf<Needs<Calls["Outbox.enqueue"]>>().toEqualTypeOf<{
      readonly outside: InTransaction;
      readonly inside: never;
    }>();
  });

  it("falsifier 1: AuditLog.record needs the transaction, and Transactor.run provides it", () => {
    expectTypeOf<Needs<Calls["AuditLog.record"]>>().toEqualTypeOf<{
      readonly outside: InTransaction;
      readonly inside: never;
    }>();
  });

  it("falsifier 1: DigestLedger.claim needs the transaction, and Transactor.run provides it", () => {
    expectTypeOf<Needs<Calls["DigestLedger.claim"]>>().toEqualTypeOf<{
      readonly outside: InTransaction;
      readonly inside: never;
    }>();
  });

  it("falsifier 1: AlumniRequests.claim needs the transaction, and Transactor.run provides it", () => {
    expectTypeOf<Needs<Calls["AlumniRequests.claim"]>>().toEqualTypeOf<{
      readonly outside: InTransaction;
      readonly inside: never;
    }>();
  });

  it("falsifier 1: a program that calls one of them bare is not one that a runtime can run", () => {
    expectTypeOf<Calls["Outbox.enqueue"]>().not.toExtend<
      Effect.Effect<unknown, unknown>
    >();

    expectTypeOf<Run<Calls["Outbox.enqueue"]>>().toExtend<
      Effect.Effect<unknown, unknown>
    >();
  });

  it("falsifier 1, control: a standalone method shows no requirement, so the test tells the two apart", () => {
    expectTypeOf<Needs<Calls["JobRuns.claim"]>>().toEqualTypeOf<{
      readonly outside: never;
      readonly inside: never;
    }>();

    expectTypeOf<Needs<Calls["OutboxDelivery.markQueued"]>>().toEqualTypeOf<{
      readonly outside: never;
      readonly inside: never;
    }>();

    expectTypeOf<Outside<Calls["JobRuns.claim"]>>().toEqualTypeOf<never>();
  });
});
