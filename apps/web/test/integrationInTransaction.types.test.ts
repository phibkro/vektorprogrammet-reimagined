/**
 * Spec 0020, falsifier F11 for the ports that `apps/web` declares: mail and Slack (`MessageSender`), Turnstile and
 * Better Auth. A program that requires one does not type-check as the argument of `Transactor.run` (`@ts-expect-error`,
 * EX-0050, so `vp check` fails the day one starts to compile); the same call after the transaction has committed
 * compiles. The domain's own ports have the same cases in `packages/domain/test/shared/integrationPorts.types.test.ts`.
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

declare const transactor: Transactor["Service"];
declare const enqueue: Effect.Effect<void, never, InTransaction | Outbox>;
declare const sendsMail: Effect.Effect<void, never, MessageSender>;
declare const verifiesCaptcha: Effect.Effect<void, never, TurnstileVerifier>;
declare const readsSession: Effect.Effect<void, never, Auth>;

describe("no integration call inside a transaction: the web app's ports (spec 0020, F11)", () => {
  it("refuses a program that requires one of them", () => {
    // @ts-expect-error EX-0050: F11, a provider call before the commit (spec 0008, falsifier 2).
    const mail = transactor.run(sendsMail);

    // @ts-expect-error EX-0050: F11, Turnstile is called before the transaction opens.
    const captcha = transactor.run(verifiesCaptcha);

    // @ts-expect-error EX-0050: F11, Better Auth writes outside the domain transaction.
    const session = transactor.run(readsSession);

    // @ts-expect-error EX-0050: F11, the write is fine and the mail after it is not.
    const both = transactor.run(Effect.andThen(enqueue, sendsMail));

    expectTypeOf([mail, captcha, session, both]).not.toBeNever();
  });

  it("allows the same calls after the transaction has committed", () => {
    const afterwards = transactor
      .run(enqueue)
      .pipe(
        Effect.andThen(sendsMail),
        Effect.andThen(verifiesCaptcha),
        Effect.andThen(readsSession)
      );

    expectTypeOf<Effect.Services<typeof afterwards>>().toEqualTypeOf<
      Auth | MessageSender | Outbox | TurnstileVerifier
    >();
  });
});
