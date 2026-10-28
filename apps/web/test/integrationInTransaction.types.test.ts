/**
 * Spec 0020, falsifier F11 for the ports that `apps/web` declares: mail and Slack (`MessageSender`), Turnstile and
 * Better Auth. Each carries the `IntegrationPort` marker, so none satisfies `NotAnIntegration`, the bound of
 * `Transactor.run`, and a program that requires one does not type-check there (the domain's
 * `packages/domain/test/shared/integrationPorts.types.test.ts` asks that of the real signature of `run`, with the
 * domain's own ports). The same calls after the transaction has committed type-check and keep their requirements.
 * Nothing is suppressed.
 */
import { describe, it } from "@effect/vitest";
import type {
  InTransaction,
  IntegrationPort,
  NotAnIntegration,
  Outbox,
  Transactor,
} from "@vektorprogrammet/domain";
import { Effect } from "effect";
import { expectTypeOf } from "vite-plus/test";

import type { Auth } from "../src/server/auth";
import type { MessageSender } from "../src/server/senders";
import type { TurnstileVerifier } from "../src/server/turnstile";

type Run = Transactor["Service"];

declare const enqueue: Effect.Effect<void, never, InTransaction | Outbox>;
declare const sendsMail: Effect.Effect<void, never, MessageSender>;
declare const verifiesCaptcha: Effect.Effect<void, never, TurnstileVerifier>;
declare const readsSession: Effect.Effect<void, never, Auth>;

/** The calls of the web app, after the transaction has committed. */
const afterwards = (transactor: Run) =>
  transactor
    .run(enqueue)
    .pipe(
      Effect.andThen(sendsMail),
      Effect.andThen(verifiesCaptcha),
      Effect.andThen(readsSession)
    );

describe("no integration call inside a transaction: the web app's ports (spec 0020, F11)", () => {
  it("marks each port of another system, so `Transactor.run` refuses a program that requires it", () => {
    expectTypeOf<MessageSender>().toExtend<IntegrationPort>();
    expectTypeOf<MessageSender>().not.toExtend<NotAnIntegration>();
    expectTypeOf<TurnstileVerifier>().toExtend<IntegrationPort>();
    expectTypeOf<TurnstileVerifier>().not.toExtend<NotAnIntegration>();
    expectTypeOf<Auth>().toExtend<IntegrationPort>();
    expectTypeOf<Auth>().not.toExtend<NotAnIntegration>();
  });

  it("control: a store port satisfies the bound", () => {
    expectTypeOf<Outbox>().toExtend<NotAnIntegration>();
    expectTypeOf<InTransaction>().toExtend<NotAnIntegration>();
  });

  it("control: the same calls after the transaction has committed type-check and keep their requirements", () => {
    expectTypeOf<
      Effect.Services<ReturnType<typeof afterwards>>
    >().toEqualTypeOf<Auth | MessageSender | Outbox | TurnstileVerifier>();
  });
});
