/**
 * Outbox message transports. Only a `production` deployment can construct the
 * real e-mail (Cloudflare Email Service `send_email` binding) and Slack
 * (incoming webhook) senders; `local` and `preview` get a capture sink that
 * records each message and logs its kind (architecture §4, critic M5). A
 * preview therefore cannot mail a real department by construction.
 */
import type { SendEmail } from "@cloudflare/workers-types";
import type { OutboxMessage } from "@vektorprogrammet/domain";
import { Context, Effect, Layer, Match, Redacted, Ref, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import type { Deployment } from "./deployment";
import type { WorkerEnv } from "./env";

/** A message could not be handed to its transport; the outbox retries it with backoff. */
export class DeliveryFailed extends Schema.TaggedError<
  DeliveryFailed,
  { readonly brand: unique symbol }
>()("DeliveryFailed", {
  reason: Schema.String,
}) {}

export class MessageSender extends Context.Service<
  MessageSender,
  {
    readonly send: (
      message: OutboxMessage
    ) => Effect.Effect<void, DeliveryFailed>;
  }
>()("@vektorprogrammet/web/server/MessageSender") {}

/** Building the production senders outside `production` (or without their bindings) is refused. */
export class SenderConfigRejected extends Schema.TaggedError<
  SenderConfigRejected,
  { readonly brand: unique symbol }
>()("SenderConfigRejected", { reason: Schema.String }) {}

/** What the capture sink recorded, in send order. */
export class CapturedMessages extends Context.Service<
  CapturedMessages,
  Ref.Ref<readonly OutboxMessage[]>
>()("@vektorprogrammet/web/server/CapturedMessages") {}

/** Records every message instead of sending it; logs only its kind (bodies hold personal data). */
export const captureSenderLayer: Layer.Layer<MessageSender | CapturedMessages> =
  Layer.effect(
    MessageSender,
    Effect.gen(function* captureSenderLayer() {
      const captured = yield* CapturedMessages;

      return MessageSender.of({
        send: (message) =>
          Ref.update(captured, (messages) => [...messages, message]).pipe(
            Effect.andThen(
              Effect.logInfo(
                "outbox message captured (non-production deployment)"
              ).pipe(Effect.annotateLogs({ kind: message._tag }))
            )
          ),
      });
    })
  ).pipe(
    Layer.provideMerge(
      Layer.effect(CapturedMessages, Ref.make<readonly OutboxMessage[]>([]))
    )
  );

/** The inputs the production senders need. */
export interface SenderConfig {
  readonly deployment: Deployment;
  readonly sendEmail: SendEmail | undefined;
  readonly mailFrom: string | undefined;
  readonly slackWebhookUrl: Redacted.Redacted | undefined;
}

export const senderConfigFromEnv = (
  deployment: Deployment,
  env: WorkerEnv
): SenderConfig => ({
  deployment,
  mailFrom: env.MAIL_FROM,
  sendEmail: env.SEND_EMAIL,
  slackWebhookUrl:
    env.SLACK_WEBHOOK_URL === undefined
      ? undefined
      : Redacted.make(env.SLACK_WEBHOOK_URL),
});

const slackChannelOf = (
  message: Extract<OutboxMessage, { _tag: "SlackPost" }>
): string =>
  Match.value(message.target).pipe(
    Match.tagsExhaustive({
      DepartmentChannel: (target) => target.channel,
      Notifications: () => "#notifications",
    })
  );

/**
 * The real transports. Fails to build unless `deployment` is `production` and
 * every production binding is present.
 */
export const productionSenderLayer = (
  config: SenderConfig
): Layer.Layer<MessageSender, SenderConfigRejected, HttpClient.HttpClient> =>
  Layer.effect(
    MessageSender,
    Effect.gen(function* buildProductionSenderLayer() {
      if (config.deployment !== "production") {
        return yield* new SenderConfigRejected({
          reason: `real message senders are production-only; deployment is ${config.deployment}`,
        });
      }

      const { sendEmail, mailFrom, slackWebhookUrl } = config;

      if (
        sendEmail === undefined ||
        mailFrom === undefined ||
        slackWebhookUrl === undefined
      ) {
        return yield* new SenderConfigRejected({
          reason:
            "production needs SEND_EMAIL, MAIL_FROM and SLACK_WEBHOOK_URL",
        });
      }

      const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);

      const send = (
        message: OutboxMessage
      ): Effect.Effect<void, DeliveryFailed> =>
        Match.value(message).pipe(
          Match.tagsExhaustive({
            Email: (email) => {
              const payload = {
                from: mailFrom,
                subject: email.subject,
                text: email.text,
                to: email.to,
              };

              const emailPayload =
                email.replyTo === null
                  ? payload
                  : { ...payload, replyTo: email.replyTo };

              return Effect.tryPromise({
                catch: (cause) =>
                  new DeliveryFailed({
                    reason: `send_email: ${String(cause)}`,
                  }),
                try: () => sendEmail.send(emailPayload),
              }).pipe(Effect.asVoid);
            },
            SlackPost: (slack) =>
              HttpClientRequest.post(Redacted.value(slackWebhookUrl)).pipe(
                HttpClientRequest.bodyJsonUnsafe({
                  channel: slackChannelOf(slack),
                  text: slack.text,
                }),
                http.execute,
                Effect.asVoid,
                Effect.mapError(
                  (error) =>
                    new DeliveryFailed({ reason: `slack: ${error.message}` })
                )
              ),
          })
        );

      return MessageSender.of({ send });
    })
  );

/**
 * The composition root's choice: production gets the real transports, every
 * other deployment the capture sink.
 */
export const messageSenderLayer = (
  config: SenderConfig
): Layer.Layer<MessageSender, SenderConfigRejected, HttpClient.HttpClient> =>
  config.deployment === "production"
    ? productionSenderLayer(config)
    : captureSenderLayer;
