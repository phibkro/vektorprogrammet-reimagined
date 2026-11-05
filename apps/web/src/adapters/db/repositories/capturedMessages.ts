import { DateTime, Effect, Layer, Match } from "effect";

/** The adapter of `CapturedMessageStore` (declared by the domain): one insert per message, kept once per key. */
import { CapturedMessageStore } from "../../../domain/outbox/captured.ts";
import { slackChannelOf } from "../../../domain/outbox/outbox.ts";
import type { TransportMessage } from "../../../domain/outbox/outbox.ts";
import { Drizzle } from "../internal/drizzle.ts";
import { capturedMail, capturedSlack } from "../schema.ts";

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
