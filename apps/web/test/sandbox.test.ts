import { assert, describe, it } from "@effect/vitest";
import type { SendEmail } from "@cloudflare/workers-types";
import { EmailAddress, type OutboxMessage } from "@vektorprogrammet/domain";
import { Effect, Exit, Layer, Redacted, Ref } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { resolveActor } from "../src/server/actor";
import { decodeDeployment, type Deployment } from "../src/server/deployment";
import {
  CapturedMessages,
  captureSenderLayer,
  MessageSender,
  messageSenderLayer,
  productionSenderLayer,
  type SenderConfig,
} from "../src/server/senders";

const email: OutboxMessage = {
  _tag: "Email",
  to: EmailAddress.make("avdeling@example.org"),
  replyTo: null,
  subject: "Henvendelse",
  text: "Hei",
};

/** Records calls; a fake same-shape `send_email` binding. */
const fakeSendEmail = (sent: Array<unknown>): SendEmail => ({
  send: (message: unknown) => {
    sent.push(message);
    return Promise.resolve({ messageId: "fake" });
  },
});

/** An HttpClient that answers 200 and records request URLs. */
const fakeHttp = (urls: Array<string>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      urls.push(request.url);
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(null, { status: 200 })),
      );
    }),
  );

const config = (deployment: Deployment, sent: Array<unknown> = []): SenderConfig => ({
  deployment,
  sendEmail: fakeSendEmail(sent),
  mailFrom: "noreply@example.org",
  slackWebhookUrl: Redacted.make("https://hooks.example.invalid/fake"),
});

const build = (layer: Layer.Layer<MessageSender, unknown, HttpClient.HttpClient>) =>
  Effect.exit(Effect.scoped(Layer.build(layer.pipe(Layer.provide(fakeHttp([]))))));

describe("deliveries are sandboxed outside production (architecture §4, critic M5)", () => {
  it.effect("building the production sender Layer from a preview config fails", () =>
    Effect.gen(function* () {
      const exit = yield* build(productionSenderLayer(config("preview")));
      assert.isTrue(Exit.isFailure(exit));
    }),
  );

  it.effect("building the production sender Layer from a local config fails", () =>
    Effect.gen(function* () {
      const exit = yield* build(productionSenderLayer(config("local")));
      assert.isTrue(Exit.isFailure(exit));
    }),
  );

  it.effect("production without its bindings fails instead of falling back", () =>
    Effect.gen(function* () {
      const exit = yield* build(
        productionSenderLayer({ ...config("production"), sendEmail: undefined }),
      );
      assert.isTrue(Exit.isFailure(exit));
    }),
  );

  it.effect("a preview gets the capture sink: nothing reaches send_email or Slack", () =>
    Effect.gen(function* () {
      const sent: Array<unknown> = [];
      const urls: Array<string> = [];
      yield* Effect.gen(function* () {
        const sender = yield* MessageSender;
        yield* sender.send(email);
        yield* sender.send({ _tag: "SlackPost", target: { _tag: "Notifications" }, text: "Hei" });
      }).pipe(
        Effect.provide(
          messageSenderLayer(config("preview", sent)).pipe(Layer.provide(fakeHttp(urls))),
        ),
      );
      assert.deepStrictEqual(sent, []);
      assert.deepStrictEqual(urls, []);
    }),
  );

  it.effect("the capture sink records each message in order", () =>
    Effect.gen(function* () {
      const captured = yield* Effect.gen(function* () {
        const sender = yield* MessageSender;
        yield* sender.send(email);
        yield* sender.send({ _tag: "SlackPost", target: { _tag: "Notifications" }, text: "Hei" });
        return yield* Ref.get(yield* CapturedMessages);
      }).pipe(Effect.provide(captureSenderLayer));
      assert.deepStrictEqual(
        captured.map((message) => message._tag),
        ["Email", "SlackPost"],
      );
    }),
  );

  it.effect("production sends e-mail through send_email and Slack through the webhook", () =>
    Effect.gen(function* () {
      const sent: Array<unknown> = [];
      const urls: Array<string> = [];
      yield* Effect.gen(function* () {
        const sender = yield* MessageSender;
        yield* sender.send(email);
        yield* sender.send({ _tag: "SlackPost", target: { _tag: "Notifications" }, text: "Hei" });
      }).pipe(
        Effect.provide(
          productionSenderLayer(config("production", sent)).pipe(Layer.provide(fakeHttp(urls))),
        ),
      );
      assert.strictEqual(sent.length, 1);
      assert.deepStrictEqual(urls, ["https://hooks.example.invalid/fake"]);
    }),
  );
});

describe("deployment and actor", () => {
  it.effect("an unknown DEPLOYMENT is a defect, never a guess", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(decodeDeployment("prod"));
      assert.isTrue(Exit.isFailure(exit));
      assert.strictEqual(yield* decodeDeployment("preview"), "preview");
    }),
  );

  it("the test actor exists only in a local deployment", () => {
    assert.strictEqual(resolveActor("local", undefined)._tag, "Staff");
    assert.strictEqual(resolveActor("local", "anonymous")._tag, "Anonymous");
    assert.strictEqual(resolveActor("preview", "admin")._tag, "Anonymous");
    assert.strictEqual(resolveActor("production", "admin")._tag, "Anonymous");
  });
});
