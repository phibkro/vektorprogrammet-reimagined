import type {
  EmailMessage,
  EmailMessageBuilder,
  SendEmail,
} from "@cloudflare/workers-types";
import { assert, describe, it } from "@effect/vitest";
import { DEFAULT_LOCAL_PERSON } from "@vektorprogrammet/db";
import {
  DepartmentId,
  EmailAddress,
  OutboxMessage as OutboxMessageSchema,
  SlackTarget,
  anonymous,
} from "@vektorprogrammet/domain";
import type { OutboxMessage } from "@vektorprogrammet/domain";
import {
  Array as Arr,
  DateTime,
  Effect,
  Exit,
  Layer,
  Predicate,
  Redacted,
  Ref,
} from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";

import { decodeDeployment } from "../src/server/deployment";
import type { Deployment } from "../src/server/deployment";
import { resolvePrincipal } from "../src/server/principal";
import {
  CapturedMessages,
  captureSenderLayer,
  MessageSender,
  messageSenderLayer,
  productionSenderLayer,
} from "../src/server/senders";
import type { SenderConfig, SenderConfigRejected } from "../src/server/senders";
import { makeTables, memoryLayer } from "./support/memory";
import {
  PEOPLE,
  TRONDHEIM,
  TRONDHEIM_TEAM,
  seedWorld,
} from "./support/teamWorld";

const email: OutboxMessage = OutboxMessageSchema.cases.Email.make({
  replyTo: null,
  subject: "Henvendelse",
  text: "Hei",
  to: EmailAddress.make("avdeling@example.org"),
});

/** Records calls; a fake same-shape `send_email` binding. */
type EmailPayload = EmailMessage | EmailMessageBuilder;

const fakeSendEmail = (sent: EmailPayload[]): SendEmail => ({
  send: async (message: EmailPayload) => {
    sent.push(message);

    await Promise.resolve();

    return { messageId: "fake" };
  },
});

/** An HttpClient that answers 200 and records request URLs. */
const fakeHttp = (urls: string[]) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      urls.push(request.url);

      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }))
      );
    })
  );

const config = (
  deployment: Deployment,
  sent: EmailPayload[] = []
): SenderConfig => ({
  deployment,
  mailFrom: "noreply@example.org",
  sendEmail: fakeSendEmail(sent),
  slackWebhookUrl: Redacted.make("https://hooks.example.invalid/fake"),
});

const sendMessages = Effect.gen(function* sendMessages() {
  const sender = yield* MessageSender;
  yield* sender.send(email);
  yield* sender.send(
    OutboxMessageSchema.cases.SlackPost.make({
      target: SlackTarget.cases.Notifications.make({}),
      text: "Hei",
    })
  );
});

const sendWithHttp = <E>(
  senderLayer: Layer.Layer<MessageSender, E, HttpClient.HttpClient>,
  urls: string[]
) =>
  sendMessages.pipe(
    Effect.provide(senderLayer.pipe(Layer.provide(fakeHttp(urls))))
  );

const build = (
  layer: Layer.Layer<MessageSender, SenderConfigRejected, HttpClient.HttpClient>
) =>
  Effect.exit(
    Effect.scoped(Layer.build(layer.pipe(Layer.provide(fakeHttp([])))))
  );

describe("deliveries are sandboxed outside production (architecture §4, critic M5)", () => {
  it.effect(
    "building the production sender Layer from a preview config fails",
    () =>
      Effect.gen(function* effectProgram() {
        const exit = yield* build(productionSenderLayer(config("preview")));
        assert.isTrue(Exit.isFailure(exit));
      })
  );

  it.effect(
    "building the production sender Layer from a local config fails",
    () =>
      Effect.gen(function* effectProgram() {
        const exit = yield* build(productionSenderLayer(config("local")));
        assert.isTrue(Exit.isFailure(exit));
      })
  );

  it.effect(
    "production without its bindings fails instead of falling back",
    () =>
      Effect.gen(function* effectProgram() {
        const exit = yield* build(
          productionSenderLayer({
            ...config("production"),
            sendEmail: undefined,
          })
        );

        assert.isTrue(Exit.isFailure(exit));
      })
  );

  it.effect(
    "a preview gets the capture sink: nothing reaches send_email or Slack",
    () =>
      Effect.gen(function* effectProgram() {
        const sent: EmailPayload[] = [];
        const urls: string[] = [];
        yield* sendWithHttp(messageSenderLayer(config("preview", sent)), urls);
        assert.deepStrictEqual(sent, []);
        assert.deepStrictEqual(urls, []);
      })
  );

  it.effect("the capture sink records each message in order", () =>
    Effect.gen(function* effectProgram() {
      const captured = yield* Effect.gen(function* captured() {
        yield* sendMessages;

        return yield* Ref.get(yield* CapturedMessages);
      }).pipe(Effect.provide(captureSenderLayer));

      assert.deepStrictEqual(
        Arr.map(captured, (message) => message._tag),
        ["Email", "SlackPost"]
      );
    })
  );

  it.effect(
    "production sends e-mail through send_email and Slack through the webhook",
    () =>
      Effect.gen(function* effectProgram() {
        const sent: EmailPayload[] = [];
        const urls: string[] = [];
        yield* sendWithHttp(
          productionSenderLayer(config("production", sent)),
          urls
        );
        assert.strictEqual(sent.length, 1);
        assert.deepStrictEqual(urls, ["https://hooks.example.invalid/fake"]);
      })
  );
});

describe("deployment and actor", () => {
  it.effect("an unknown DEPLOYMENT is a defect, never a guess", () =>
    Effect.gen(function* effectProgram() {
      const exit = yield* Effect.exit(decodeDeployment("prod"));
      assert.isTrue(Exit.isFailure(exit));
      assert.strictEqual(yield* decodeDeployment("preview"), "preview");
    })
  );
  it.effect(
    "the test actor exists only in a local deployment, and is a person the database knows",
    () =>
      Effect.gen(function* localActorEffect() {
        yield* TestClock.setTime(
          DateTime.toEpochMillis(
            DateTime.makeUnsafe("2026-10-15T12:00:00+02:00")
          )
        );

        const tables = makeTables();
        yield* seedWorld(tables);

        const resolve = (deployment: Deployment, selection?: string) =>
          resolvePrincipal(deployment, selection).pipe(
            Effect.provide(memoryLayer(tables))
          );

        const byDefault = yield* resolve("local");
        const lise = yield* resolve("local", "Lise Leder");

        assert.isTrue(
          Predicate.isTagged(byDefault, "Person") &&
            byDefault.personId === PEOPLE.ada &&
            byDefault.adminUntil !== undefined,
          `without a cookie the local actor is ${DEFAULT_LOCAL_PERSON}, an administrator`
        );
        assert.isTrue(
          Predicate.isTagged(lise, "Person") &&
            lise.personId === PEOPLE.lise &&
            lise.adminUntil === undefined
        );
        assert.deepStrictEqual(
          Predicate.isTagged(lise, "Person") ? lise.memberships : [],
          [
            {
              departmentId: DepartmentId.make(TRONDHEIM),
              function: "recruitment",
              leader: true,
              teamId: TRONDHEIM_TEAM,
            },
          ]
        );
        assert.deepStrictEqual(yield* resolve("local", "anonymous"), anonymous);
        assert.deepStrictEqual(
          yield* resolve("local", "Ukjent Person"),
          anonymous
        );
        assert.deepStrictEqual(
          yield* resolve("preview", "Ada Admin"),
          anonymous
        );
        assert.deepStrictEqual(
          yield* resolve("production", "Ada Admin"),
          anonymous
        );
      })
  );
});
