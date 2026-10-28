/**
 * The command that two delivery test files run through the real request runtime (`runCommandOutcome`): it queues one
 * e-mail in the transaction that the runner opens, as the contact form does, and with `rollback` refuses after queueing.
 */
import { DatabaseLive } from "@vektorprogrammet/db";
import {
  EmailAddress,
  Outbox,
  OutboxMessage,
  validationFailed,
} from "@vektorprogrammet/domain";
import { Array as Arr, Effect, Layer, Option } from "effect";
import type { Redacted } from "effect";

import { runCommandOutcome } from "../../src/server/runtime";

export const email = OutboxMessage.cases.Email.make({
  replyTo: null,
  subject: "Henvendelse",
  text: "Hei",
  to: EmailAddress.make("avdeling@example.org"),
});

/** One message queued in the current transaction; its id. */
export const enqueueEmail = Effect.gen(function* enqueueEmail() {
  const ids = yield* (yield* Outbox).enqueue([email]);

  return Option.getOrThrow(Arr.head(ids));
});

/** The command, run as a request runs it, optionally failing after it queues the message. */
export const requestOutcome = (url: Redacted.Redacted, rollback: boolean) =>
  Effect.promise(
    async () =>
      await runCommandOutcome(
        DatabaseLive({ maxConnections: 4, url }).pipe(Layer.orDie),
        Effect.void,
        () =>
          rollback
            ? Effect.andThen(
                enqueueEmail,
                Effect.fail(
                  validationFailed(["name"], "refused after queueing")
                )
              )
            : enqueueEmail,
        new AbortController().signal
      )
  );
