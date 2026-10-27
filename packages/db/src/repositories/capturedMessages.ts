/**
 * The fake mailbox and the fake Slack workspace of a non-production deployment (spec 0008). Only the capture sender
 * layer writes them, so a browser test can read what a person would have received and no real recipient can.
 *
 * `key` is the outbox row's id: the same message captured twice (a delivery that crashed before its acknowledgement
 * and was claimed again) is kept once, which is what a provider with an idempotency key does.
 */
import { slackChannelOf } from "@vektorprogrammet/domain";
import type { TransportMessage } from "@vektorprogrammet/domain";
import { Context, DateTime, Effect, Layer, Match } from "effect";

import { Drizzle } from "../internal/drizzle.ts";
import { capturedMail, capturedSlack } from "../schema.ts";

export class CapturedMessageStore extends Context.Service<
  CapturedMessageStore,
  {
    readonly record: (
      message: TransportMessage,
      key: string
    ) => Effect.Effect<void>;
  }
>()("@vektorprogrammet/db/CapturedMessageStore") {}

export const CapturedMessageStoreLive = Layer.effect(
  CapturedMessageStore,
  Effect.gen(function* CapturedMessageStoreLive() {
    const db = yield* Drizzle;

    return CapturedMessageStore.of({
      record: Effect.fn("CapturedMessageStore.record")(function* record(
        message: TransportMessage,
        key: string
      ) {
        const sentAt = DateTime.toDateUtc(yield* DateTime.now);

        yield* Match.value(message).pipe(
          Match.tagsExhaustive({
            Email: (email) =>
              Effect.asVoid(
                Effect.orDie(
                  db
                    .insert(capturedMail)
                    .values({
                      deliveryKey: key,
                      recipient: email.to,
                      sentAt,
                      subject: email.subject,
                      text: email.text,
                    })
                    .onConflictDoNothing()
                )
              ),
            SlackPost: (slack) =>
              Effect.asVoid(
                Effect.orDie(
                  db
                    .insert(capturedSlack)
                    .values({
                      channel: slackChannelOf(slack.target),
                      deliveryKey: key,
                      sentAt,
                      text: slack.text,
                    })
                    .onConflictDoNothing()
                )
              ),
          })
        );
      }),
    });
  })
);
