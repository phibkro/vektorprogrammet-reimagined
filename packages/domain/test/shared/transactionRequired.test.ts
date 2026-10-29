/**
 * Spec 0018, falsifier 1 (the ADR's falsifier): a program that calls one of these methods outside a transaction does
 * not type-check, because it requires `InTransaction` and nothing provides it; the same program through
 * `Transactor.run` has no such requirement. The cases are positive type assertions that suppress nothing, in the
 * style of `transactor.test.ts`. `vp check` is what fails when a signature loses its requirement.
 *
 * The 21 methods are the four of the ADR (`Outbox.enqueue`, `AuditLog.record`, `DigestLedger.claim`,
 * `AlumniRequests.claim`) and the 17 that take a `Locked` token. The controls are the methods that stay standalone:
 * they show no requirement, so the test tells the two apart.
 */
import { describe, it } from "@effect/vitest";
import type { Effect } from "effect";
import { expectTypeOf } from "vite-plus/test";

import type { CodeRepository } from "../../src/accounts/codeRepository.ts";
import type { AccountRepository } from "../../src/accounts/services.ts";
import type { AuditLog } from "../../src/audit/auditLog.ts";
import type { JobRuns } from "../../src/jobs/runs.ts";
import type { OutboxDelivery } from "../../src/outbox/delivery.ts";
import type {
  AlumniRequests,
  ConsentRepository,
} from "../../src/personalData/services.ts";
import type { Outbox } from "../../src/shared/outbox.ts";
import type { InTransaction } from "../../src/shared/transaction.ts";
import type { Transactor } from "../../src/shared/transactor.ts";
import type {
  AdminGrantRepository,
  DigestLedger,
  MembershipRepository,
  PersonRepository,
} from "../../src/teams/services.ts";

/** The call (the Effect that a method returns) of every method that must require the transaction. */
interface MustRequire {
  readonly "AccountRepository.findLocked": ReturnType<
    AccountRepository["Service"]["findLocked"]
  >;
  readonly "AccountRepository.invite": ReturnType<
    AccountRepository["Service"]["invite"]
  >;
  readonly "AccountRepository.isLastActiveAdmin": ReturnType<
    AccountRepository["Service"]["isLastActiveAdmin"]
  >;
  readonly "AccountRepository.transition": ReturnType<
    AccountRepository["Service"]["transition"]
  >;
  readonly "AccountRepository.verifyEmail": ReturnType<
    AccountRepository["Service"]["verifyEmail"]
  >;
  readonly "AdminGrantRepository.create": ReturnType<
    AdminGrantRepository["Service"]["create"]
  >;
  readonly "AdminGrantRepository.revoke": ReturnType<
    AdminGrantRepository["Service"]["revoke"]
  >;
  readonly "AlumniRequests.claim": ReturnType<
    AlumniRequests["Service"]["claim"]
  >;
  readonly "AuditLog.record": ReturnType<AuditLog["Service"]["record"]>;
  readonly "CodeRepository.acknowledge": ReturnType<
    CodeRepository["Service"]["acknowledge"]
  >;
  readonly "CodeRepository.consume": ReturnType<
    CodeRepository["Service"]["consume"]
  >;
  readonly "CodeRepository.issue": ReturnType<
    CodeRepository["Service"]["issue"]
  >;
  readonly "ConsentRepository.ofLocked": ReturnType<
    ConsentRepository["Service"]["ofLocked"]
  >;
  readonly "ConsentRepository.record": ReturnType<
    ConsentRepository["Service"]["record"]
  >;
  readonly "DigestLedger.claim": ReturnType<DigestLedger["Service"]["claim"]>;
  readonly "MembershipRepository.findLocked": ReturnType<
    MembershipRepository["Service"]["findLocked"]
  >;
  readonly "MembershipRepository.insert": ReturnType<
    MembershipRepository["Service"]["insert"]
  >;
  readonly "MembershipRepository.listLocked": ReturnType<
    MembershipRepository["Service"]["listLocked"]
  >;
  readonly "MembershipRepository.remove": ReturnType<
    MembershipRepository["Service"]["remove"]
  >;
  readonly "MembershipRepository.setEnd": ReturnType<
    MembershipRepository["Service"]["setEnd"]
  >;
  readonly "Outbox.enqueue": ReturnType<Outbox["Service"]["enqueue"]>;
  readonly "PersonRepository.findLocked": ReturnType<
    PersonRepository["Service"]["findLocked"]
  >;
}

/** Controls: the calls of methods that stay standalone. */
interface Standalone {
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
  call: MustRequire["Outbox.enqueue"]
) => transactor.run(call);

/** What a call needs bare, and what it needs once `Transactor.run` has wrapped it. */
interface Needs<Call> {
  readonly outside: Effect.Services<Call>;
  readonly inside: Effect.Services<Run<Call>>;
}

/** The calls of `Calls` that need something other than `want` outside a transaction, or need anything inside one. */
type Wrong<Calls, Want> = {
  [Label in keyof Calls]: Needs<Calls[Label]> extends {
    readonly outside: Want;
    readonly inside: never;
  }
    ? [Want] extends [Needs<Calls[Label]>["outside"]]
      ? never
      : Label
    : Label;
}[keyof Calls];

describe("a call outside a transaction does not type-check (spec 0018)", () => {
  it("falsifier 1: Transactor.run makes of a call what `Run` says", () => {
    expectTypeOf(runEnqueue).returns.toEqualTypeOf<
      Run<MustRequire["Outbox.enqueue"]>
    >();
  });

  it("falsifier 1: Outbox.enqueue needs the transaction, and Transactor.run provides it", () => {
    expectTypeOf<Needs<MustRequire["Outbox.enqueue"]>>().toEqualTypeOf<{
      readonly outside: InTransaction;
      readonly inside: never;
    }>();
  });

  it("falsifier 1: AuditLog.record needs the transaction, and Transactor.run provides it", () => {
    expectTypeOf<Needs<MustRequire["AuditLog.record"]>>().toEqualTypeOf<{
      readonly outside: InTransaction;
      readonly inside: never;
    }>();
  });

  it("falsifier 1: DigestLedger.claim needs the transaction, and Transactor.run provides it", () => {
    expectTypeOf<Needs<MustRequire["DigestLedger.claim"]>>().toEqualTypeOf<{
      readonly outside: InTransaction;
      readonly inside: never;
    }>();
  });

  it("falsifier 1: AlumniRequests.claim needs the transaction, and Transactor.run provides it", () => {
    expectTypeOf<Needs<MustRequire["AlumniRequests.claim"]>>().toEqualTypeOf<{
      readonly outside: InTransaction;
      readonly inside: never;
    }>();
  });

  it("falsifier 1: every one of the 21 methods needs the transaction outside, and nothing inside Transactor.run", () => {
    expectTypeOf<Wrong<MustRequire, InTransaction>>().toEqualTypeOf<never>();
  });

  it("falsifier 1: a program that calls one of them bare is not one that a runtime can run", () => {
    expectTypeOf<MustRequire["Outbox.enqueue"]>().not.toExtend<
      Effect.Effect<unknown, unknown>
    >();

    expectTypeOf<Run<MustRequire["Outbox.enqueue"]>>().toExtend<
      Effect.Effect<unknown, unknown>
    >();
  });

  it("falsifier 1, control: a standalone method shows no requirement, so the test tells the two apart", () => {
    expectTypeOf<Needs<Standalone["JobRuns.claim"]>>().toEqualTypeOf<{
      readonly outside: never;
      readonly inside: never;
    }>();

    expectTypeOf<
      Needs<Standalone["OutboxDelivery.markQueued"]>
    >().toEqualTypeOf<{
      readonly outside: never;
      readonly inside: never;
    }>();

    expectTypeOf<Wrong<Standalone, InTransaction>>().toEqualTypeOf<
      "JobRuns.claim" | "OutboxDelivery.markQueued"
    >();
  });
});
