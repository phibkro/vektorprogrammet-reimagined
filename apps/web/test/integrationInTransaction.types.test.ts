/**
 * Spec 0020, falsifier F11 for the ports that `apps/web` declares: mail and Slack (`MessageSender`), Turnstile and
 * Better Auth. A program that requires one does not type-check as the argument of `Transactor.run`; the same call after
 * the transaction has committed does. `Accepts<R>` asks the call-site question of the real signature of `run` and
 * suppresses nothing (the domain's own ports have the same cases, and the explanation, in
 * `packages/domain/test/shared/integrationPorts.types.test.ts`).
 */
import { describe, it } from "@effect/vitest";
import type {
  InTransaction,
  Outbox,
  Transactor,
} from "@vektorprogrammet/domain";
import { Effect } from "effect";
import { expectTypeOf } from "vite-plus/test";

import type { Auth } from "../src/server/auth";
import type { MessageSender } from "../src/server/senders";
import type { TurnstileVerifier } from "../src/server/turnstile";

type Run = Transactor["Service"];

/** Whether `Transactor.run` takes a program whose requirements are `R`. */
type Accepts<R> = Run["run"] extends (
  program: Effect.Effect<void, never, R>
) => Effect.Effect<void, never, Exclude<R, InTransaction>>
  ? true
  : false;

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
  it("refuses a program that requires one of them, alone or among others", () => {
    expectTypeOf<Accepts<MessageSender>>().toEqualTypeOf<false>();
    expectTypeOf<Accepts<TurnstileVerifier>>().toEqualTypeOf<false>();
    expectTypeOf<Accepts<Auth>>().toEqualTypeOf<false>();

    // The write is fine and the mail after it is not.
    expectTypeOf<
      Accepts<InTransaction | MessageSender | Outbox>
    >().toEqualTypeOf<false>();
  });

  it("control: it takes the write alone", () => {
    expectTypeOf<Accepts<InTransaction | Outbox>>().toEqualTypeOf<true>();
  });

  it("control: the same calls after the transaction has committed type-check and keep their requirements", () => {
    expectTypeOf<
      Effect.Services<ReturnType<typeof afterwards>>
    >().toEqualTypeOf<Auth | MessageSender | Outbox | TurnstileVerifier>();
  });
});
