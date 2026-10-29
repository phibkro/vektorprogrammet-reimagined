/**
 * Spec 0024 R6, falsifier F8: an integration port refuses a call made while a transaction is open on the calling
 * fiber. `integrationInTransaction.types.test.ts` is the type bound (a program that REQUIRES a port does not
 * type-check inside `Transactor.run`); these are the calls that the bound cannot see, so each takes the port from
 * outside (`yield* MessageSender` before the transaction, as `AccountDelivery` captures it) and calls it inside
 * `Transactor.run`, on the shipped Layer of the port. Each case has its control: the same call outside a transaction
 * reaches the provider.
 *
 * A provider that records its calls shows that none was reached: the guard dies before the member is called.
 */
import type {
  EmailMessage,
  EmailMessageBuilder,
  SendEmail,
} from "@cloudflare/workers-types";
import { assert, describe, it } from "@effect/vitest";
import {
  CapturedMessageStore,
  CompanyEmail,
  EmailAddress,
  IntegrationCalledInTransaction,
  OutboxMessage as OutboxMessageSchema,
  SlackTarget,
  Transactor,
  WorkspaceChange,
  WorkspaceDirectory,
  WorkspaceWriter,
} from "@vektorprogrammet/domain";
import type { TransportMessage } from "@vektorprogrammet/domain";
import {
  Array as Arr,
  Cause,
  Effect,
  Exit,
  Fiber,
  Layer,
  Redacted,
  Ref,
  Schema,
} from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import {
  MessageSender,
  captureSenderLayer,
  productionSenderLayer,
} from "../src/server/senders";
import {
  TurnstileVerifier,
  turnstileLiveLayer,
  turnstileTestLayer,
} from "../src/server/turnstile";
import {
  workspaceDirectoryLayer,
  workspaceWriterLayer,
} from "../src/server/workspace";
import { memoryLayer } from "./support/memory";

const email: TransportMessage = OutboxMessageSchema.cases.Email.make({
  replyTo: null,
  subject: "Kode",
  text: "Hei",
  to: EmailAddress.make("kari@example.org"),
});

const address = CompanyEmail.make("kari.nordmann@vektorprogrammet.no");

const change = WorkspaceChange.cases.EnsureAccount.make({
  address,
  name: "Kari Nordmann",
});

/** `program` inside the domain's `Transactor`, as a delivery's transaction runs it. */
const inTransaction = <A, E>(program: Effect.Effect<A, E>) =>
  Transactor.use((transactor) => transactor.run(program));

const isRefusal = Schema.is(IntegrationCalledInTransaction);

/** The call that a refused exit names: the exit is a defect `IntegrationCalledInTransaction`, and nothing else. */
const refusedCall = (exit: Exit.Exit<unknown, unknown>): string => {
  assert.isTrue(Exit.isFailure(exit), "the call was refused");

  if (Exit.isSuccess(exit)) {
    return "";
  }

  const defect = Cause.squash(exit.cause);
  assert.isTrue(isRefusal(defect), "and by the guard");

  return isRefusal(defect) ? defect.call : "";
};

/** How many times a fake provider was reached. */
interface Counter {
  calls: number;
}

/** A fake `send_email` binding that counts its calls. */
type EmailPayload = EmailMessage | EmailMessageBuilder;

const countingEmail = (counter: Counter): SendEmail => ({
  send: async (_message: EmailPayload) => {
    await Promise.resolve();
    counter.calls += 1;

    return { messageId: "fake" };
  },
});

/** An HttpClient that answers 200 and counts its requests. */
const countingHttp = (counter: Counter) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      counter.calls += 1;

      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }))
      );
    })
  );

/** The capture store that keeps each message's key, as the fake mailbox of a test. */
const mailboxOver = (kept: Ref.Ref<readonly string[]>) =>
  Layer.succeed(CapturedMessageStore)(
    CapturedMessageStore.of({
      record: (_message, key) => Ref.update(kept, (all) => [...all, key]),
    })
  );

describe("spec 0024 R6: an integration port refuses a call made inside a transaction", () => {
  it.effect(
    "MessageSender, the capture sink: inside the transaction the call dies and nothing is kept; outside it is kept",
    () =>
      Effect.gen(function* captureSink() {
        const kept = yield* Ref.make<readonly string[]>([]);

        const mailbox = mailboxOver(kept);

        yield* Effect.gen(function* sendBothWays() {
          const sender = yield* MessageSender;

          const refused = yield* Effect.exit(
            inTransaction(sender.send(email, "inside"))
          );

          assert.strictEqual(refusedCall(refused), "MessageSender.send");
          assert.deepStrictEqual(yield* Ref.get(kept), []);

          yield* sender.send(email, "outside");
          assert.deepStrictEqual(yield* Ref.get(kept), ["outside"]);
        }).pipe(
          Effect.provide(
            Layer.merge(
              memoryLayer(),
              captureSenderLayer.pipe(Layer.provide(mailbox))
            )
          )
        );
      })
  );

  it.effect(
    "MessageSender, the production transport: the binding is not called inside the transaction, and is called outside",
    () =>
      Effect.gen(function* productionTransport() {
        const sent: Counter = { calls: 0 };
        const http: Counter = { calls: 0 };

        const production = productionSenderLayer({
          deployment: "production",
          mailFrom: "noreply@example.org",
          sendEmail: countingEmail(sent),
          slackWebhookUrl: Redacted.make("https://hooks.example.invalid/fake"),
        }).pipe(Layer.provide(countingHttp(http)));

        yield* Effect.gen(function* sendBothWays() {
          const sender = yield* MessageSender;

          const mail = yield* Effect.exit(
            inTransaction(sender.send(email, "inside"))
          );

          const slack = yield* Effect.exit(
            inTransaction(
              sender.send(
                OutboxMessageSchema.cases.SlackPost.make({
                  target: SlackTarget.cases.Notifications.make({}),
                  text: "Hei",
                }),
                "inside"
              )
            )
          );

          assert.strictEqual(refusedCall(mail), "MessageSender.send");
          assert.strictEqual(refusedCall(slack), "MessageSender.send");
          assert.strictEqual(sent.calls, 0);
          assert.strictEqual(http.calls, 0);

          yield* sender.send(email, "outside");
          assert.strictEqual(sent.calls, 1);
        }).pipe(Effect.provide(Layer.merge(memoryLayer(), production)));
      })
  );

  it.effect(
    "TurnstileVerifier, live and test: the verification does not reach Cloudflare inside the transaction",
    () =>
      Effect.gen(function* verifier() {
        const requests: Counter = { calls: 0 };

        const live = turnstileLiveLayer(Redacted.make("secret")).pipe(
          Layer.provide(countingHttp(requests))
        );

        yield* Effect.gen(function* verifyBothWays() {
          const turnstile = yield* TurnstileVerifier;
          const input = { remoteIp: null, token: "token" };

          const refused = yield* Effect.exit(
            inTransaction(turnstile.verify(input))
          );

          assert.strictEqual(refusedCall(refused), "TurnstileVerifier.verify");
          assert.strictEqual(requests.calls, 0);

          yield* Effect.exit(turnstile.verify(input));
          assert.strictEqual(requests.calls, 1);
        }).pipe(Effect.provide(Layer.merge(memoryLayer(), live)));

        const accepting = yield* Effect.gen(function* testLayer() {
          const turnstile = yield* TurnstileVerifier;

          return yield* Effect.exit(
            inTransaction(
              turnstile.verify({ remoteIp: null, token: "accepted" })
            )
          );
        }).pipe(
          Effect.provide(
            Layer.merge(memoryLayer(), turnstileTestLayer("accepted"))
          )
        );

        assert.strictEqual(refusedCall(accepting), "TurnstileVerifier.verify");
      })
  );

  it.effect(
    "WorkspaceDirectory and WorkspaceWriter: every member of every shipped Layer refuses, effects as well as methods",
    () =>
      Effect.gen(function* workspacePorts() {
        const deployments = ["local", "preview", "production"] as const;
        const modes = ["dry-run", "write"] as const;

        for (const deployment of deployments) {
          yield* Effect.gen(function* directory() {
            const port = yield* WorkspaceDirectory;

            const calls = yield* Effect.all([
              Effect.exit(inTransaction(port.accounts)),
              Effect.exit(inTransaction(port.groups)),
              Effect.exit(inTransaction(port.members(address))),
            ]);

            assert.deepStrictEqual(Arr.map(calls, refusedCall), [
              "WorkspaceDirectory.accounts",
              "WorkspaceDirectory.groups",
              "WorkspaceDirectory.members",
            ]);
          }).pipe(
            Effect.provide(
              Layer.merge(
                memoryLayer(),
                workspaceDirectoryLayer({ deployment, mode: "dry-run" })
              )
            )
          );

          for (const mode of modes) {
            yield* Effect.gen(function* writer() {
              const port = yield* WorkspaceWriter;

              const refused = yield* Effect.exit(
                inTransaction(port.apply(change))
              );

              assert.strictEqual(refusedCall(refused), "WorkspaceWriter.apply");
            }).pipe(
              Effect.provide(
                Layer.merge(
                  memoryLayer(),
                  workspaceWriterLayer({ deployment, mode })
                )
              )
            );
          }
        }
      })
  );

  it.effect(
    "a fiber that the transaction forks holds the transaction's proof too, so its call is refused; after the commit the call goes through",
    () =>
      Effect.gen(function* forkedCall() {
        const kept = yield* Ref.make<readonly string[]>([]);

        const mailbox = mailboxOver(kept);

        yield* Effect.gen(function* forkBothWays() {
          const sender = yield* MessageSender;

          const refused = yield* Effect.exit(
            inTransaction(
              Effect.gen(function* fork() {
                const child = yield* Effect.forkChild(
                  sender.send(email, "child")
                );

                return yield* Fiber.join(child);
              })
            )
          );

          assert.strictEqual(refusedCall(refused), "MessageSender.send");
          assert.deepStrictEqual(yield* Ref.get(kept), []);

          yield* inTransaction(Effect.void);
          yield* sender.send(email, "after the commit");
          assert.deepStrictEqual(yield* Ref.get(kept), ["after the commit"]);
        }).pipe(
          Effect.provide(
            Layer.merge(
              memoryLayer(),
              captureSenderLayer.pipe(Layer.provide(mailbox))
            )
          )
        );
      })
  );
});
