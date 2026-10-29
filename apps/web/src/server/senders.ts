/**
 * Outbox message transports. Only a `production` deployment can construct the
 * real e-mail (Cloudflare Email Service `send_email` binding) and Slack
 * (incoming webhook) senders; `local` and `preview` get a capture sink that
 * keeps each message (a fake mailbox and a fake Slack workspace, readable by
 * the browser tests) and logs its kind (architecture §4, critic M5). A
 * preview therefore cannot mail a real department by construction.
 *
 * Every send carries the outbox row's id as its delivery key, the same on every attempt at that row. A delivery
 * that crashed after the provider answered and before the acknowledgement is claimed again and sends again with the
 * same key (spec 0008, falsifier 3): the capture sink keeps such a message once, as a provider with an idempotency
 * key would. The real transports do not send the key on: neither Cloudflare Email Service nor a Slack incoming
 * webhook has a documented idempotency key, so a duplicate after that one crash window is possible and accepted, and
 * the day a provider offers one the transport below passes the key to it.
 */
import type { SendEmail } from "@cloudflare/workers-types";
import { CapturedMessageStore, slackChannelOf } from "@vektorprogrammet/domain";
import type {
  IntegrationPort,
  TransportMessage,
  IntegrationTypeId,
} from "@vektorprogrammet/domain";
import { Context, Effect, Layer, Match, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import type { Deployment } from "./deployment";
import type { WorkerEnv } from "./env";

/**
 * A message could not be handed to its transport; the queue retries it with backoff (spec 0008b). `reason` is the class of the
 * failure, never a provider's text: the row keeps it as `last_error` and the Integrations page shows it.
 */
export class DeliveryFailed extends Schema.TaggedError<
  DeliveryFailed,
  { readonly brand: unique symbol }
>()("DeliveryFailed", {
  reason: Schema.String,
}) {}

/**
 * Mail and Slack: an integration port (ADR 0015, section 10), so `Transactor.run` refuses a program that requires it.
 * The outbox row is what a transaction commits; the delivery after it calls this.
 */
export class MessageSender
  extends Context.Service<
    MessageSender,
    {
      /** `key` is the outbox row's id: stable across every attempt at the same message. */
      readonly send: (
        message: TransportMessage,
        key: string
      ) => Effect.Effect<void, DeliveryFailed>;
    }
  >()("@vektorprogrammet/web/server/MessageSender")
  implements IntegrationPort
{
  declare readonly [IntegrationTypeId]: IntegrationTypeId;
}

/** Building the production senders outside `production` (or without their bindings) is refused. */
export class SenderConfigRejected extends Schema.TaggedError<
  SenderConfigRejected,
  { readonly brand: unique symbol }
>()("SenderConfigRejected", { reason: Schema.String }) {}

/** Keeps every message instead of sending it; logs only its kind (bodies hold personal data). */
export const captureSenderLayer: Layer.Layer<
  MessageSender,
  never,
  CapturedMessageStore
> = Layer.effect(
  MessageSender,
  Effect.gen(function* captureSenderLayer() {
    const store = yield* CapturedMessageStore;

    return MessageSender.of({
      send: (message, key) =>
        store
          .record(message, key)
          .pipe(
            Effect.andThen(
              Effect.logInfo(
                "outbox message captured (non-production deployment)"
              ).pipe(Effect.annotateLogs({ kind: message._tag }))
            )
          ),
    });
  })
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
  env: Pick<WorkerEnv, "MAIL_FROM" | "SEND_EMAIL" | "SLACK_WEBHOOK_URL">
): SenderConfig => ({
  deployment,
  mailFrom: env.MAIL_FROM,
  sendEmail: env.SEND_EMAIL,
  slackWebhookUrl:
    env.SLACK_WEBHOOK_URL === undefined
      ? undefined
      : Redacted.make(env.SLACK_WEBHOOK_URL),
});

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
        message: TransportMessage
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
                // The class of the failure, never the provider's text: it can name the recipient, and the row keeps
                // `reason` as `last_error` for the Integrations page (spec 0008b).
                catch: () =>
                  new DeliveryFailed({ reason: "send_email rejected" }),
                try: () => sendEmail.send(emailPayload),
              }).pipe(Effect.asVoid);
            },
            SlackPost: (slack) =>
              HttpClientRequest.post(Redacted.value(slackWebhookUrl)).pipe(
                HttpClientRequest.bodyJsonUnsafe({
                  channel: slackChannelOf(slack.target),
                  text: slack.text,
                }),
                http.execute,
                Effect.asVoid,
                Effect.mapError(
                  (error) =>
                    new DeliveryFailed({ reason: `slack ${error.reason._tag}` })
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
): Layer.Layer<
  MessageSender,
  SenderConfigRejected,
  HttpClient.HttpClient | CapturedMessageStore
> =>
  config.deployment === "production"
    ? productionSenderLayer(config)
    : captureSenderLayer;
