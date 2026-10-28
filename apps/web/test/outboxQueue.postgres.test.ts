/**
 * Spec 0008b on real PostgreSQL, with a recording queue (`support/fakeQueue.ts`). The real Queue's retries and
 * dead-letter route (falsifier 4) are `outboxQueue.worker.test.ts`'s, in Miniflare; the rest is here:
 *
 * 1. a command that rolls back puts nothing on the queue and delivers nothing (control: a publisher inside the
 *    transaction sends one);
 * 2. a crash between commit and enqueue is found by the sweep, within the declared threshold, and delivered (control:
 *    without the sweep it never is);
 * 3. two deliveries of one id call the provider once, in each of 300 fresh rounds (control: without the conditional
 *    claim the provider is called twice);
 * 5. no queue message holds anything but an id (control: a message that holds an address is found by the same scan);
 * 6. code mail on the queue path is minted, sent and acknowledged in the consumer's transaction (a failed send leaves no
 *    usable code);
 * 7. outside production nothing reaches a real provider (control: production reaches it).
 */
import type {
  EmailMessage,
  EmailMessageBuilder,
  SendEmail,
} from "@cloudflare/workers-types";
import { assert, layer } from "@effect/vitest";
import { CapturedMessageStore } from "@vektorprogrammet/db";
import { TestDatabaseUrl } from "@vektorprogrammet/db/testing";
import {
  AccountEndpoints,
  CodeToken,
  CurrentPrincipal,
  JobRegistry,
  OutboxSweep,
  codePrincipal,
  validationFailed,
} from "@vektorprogrammet/domain";
import type { TransportMessage } from "@vektorprogrammet/domain";
import {
  Array as Arr,
  Cause,
  Clock,
  Effect,
  Exit,
  Layer,
  Option,
  Predicate,
  Redacted,
  Ref,
  Schema,
} from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { AccountDelivery } from "../src/server/accountDelivery";
import { success } from "../src/server/errors";
import { capturingOutbox } from "../src/server/outboxPublisher";
import { consumeBatch, deliveryDecisions } from "../src/server/outboxQueue";
import { publishCommitted, runQueue, runTick } from "../src/server/runtime";
import type { TickEnv } from "../src/server/runtime";
import {
  DeliveryFailed,
  MessageSender,
  captureSenderLayer,
} from "../src/server/senders";
import { Transactor, transactorLayer } from "../src/server/transactor";
import { email, enqueueEmail, requestOutcome } from "./support/commandOutcome";
import { liveWith, origin } from "./support/deliveryLive";
import { fakeQueue } from "./support/fakeQueue";
import type { FakeQueue } from "./support/fakeQueue";
import { leaderOf } from "./support/principals";
import { rowsIn } from "./support/rowCount";
import { refusingWriter } from "./support/workspaceWorld";

/** Every queue that a test made: the traffic that falsifier 5 scans. */
const queues: FakeQueue[] = [];

const newQueue = (): FakeQueue => {
  const queue = fakeQueue();
  queues.push(queue);

  return queue;
};

const withDatabase = (
  sender: Layer.Layer<MessageSender, never, CapturedMessageStore>
) => transactorLayer.pipe(Layer.provideMerge(liveWith(sender)));

/** The Worker's bindings in a test: the database, the fake queue (or none, as in a Preview) and the deployment. */
const envFor = (
  url: Redacted.Redacted,
  queue: FakeQueue | undefined,
  deployment: "local" | "preview" | "production" = "local"
): TickEnv => ({
  BETTER_AUTH_SECRET: "local-fake-signing-secret-only-123456789",
  DEPLOYMENT: deployment,
  HYPERDRIVE: { connectionString: Redacted.value(url) },
  OUTBOX_QUEUE: queue?.binding,
  SITE_URL: origin,
});

const reset = Effect.gen(function* reset() {
  const sql = yield* SqlClient;

  yield* sql`truncate outbox, captured_mail, captured_slack, job_run restart identity`;
});

/** `waitUntil`, as a test sees it: the promises that the Worker would have left running after the response. */
const waitUntil = () => {
  const pending: Promise<unknown>[] = [];

  return {
    ctx: {
      waitUntil: (promise: Promise<unknown>) => {
        pending.push(promise);
      },
    },
    settled: Effect.promise(async () => await Promise.all(pending)),
  };
};

/** A provider that counts its calls, waits a moment (so two overlapping deliveries really overlap) and can be told to fail. */
const provider = (calls: Ref.Ref<readonly string[]>, fails = false) =>
  Layer.succeed(MessageSender)(
    MessageSender.of({
      send: (_message: TransportMessage, key: string) =>
        Effect.andThen(
          Effect.sleep("2 millis"),
          fails
            ? Effect.fail(new DeliveryFailed({ reason: "transport down" }))
            : Ref.update(calls, (all) => [...all, key])
        ),
    })
  );

const noOtherServices = Layer.mergeAll(
  Layer.mock(AccountDelivery, {}),
  refusingWriter
);

/** The consumer, as the Worker runs it, over the test's provider. */
const consume = (queue: FakeQueue, calls: Ref.Ref<readonly string[]>) =>
  queue
    .drain((batch, dead) => consumeBatch(batch, dead))
    .pipe(Effect.provide(Layer.mergeAll(provider(calls), noOtherServices)));

interface RowState {
  readonly status: string;
  readonly queued: boolean;
  readonly last_error: string | null;
}

const rowState = (id: string) =>
  Effect.gen(function* readRowState() {
    const sql = yield* SqlClient;

    const rows =
      yield* sql<RowState>`select status, queued_at is not null as queued, last_error from outbox where id = ${Number(id)}`;

    return Option.getOrThrow(Arr.head(rows));
  });

/** A clean database, a queue of its own, and what a request leaves running after its response. */
const freshRun = Effect.gen(function* freshRun() {
  yield* reset;

  return {
    calls: yield* Ref.make<readonly string[]>([]),
    queue: newQueue(),
    url: yield* TestDatabaseUrl,
    ...waitUntil(),
  };
});

const ROUNDS = 300;

/** What a queue message may hold: the id of an outbox row and nothing else. */
const isOnlyAnId = Schema.is(OutboxSweep.QueueBody);

/** The bodies of every queue of the run that are not an id: what a scan for personal data reports. */
const notIds = (all: readonly FakeQueue[]) =>
  Arr.filter(
    Arr.flatMap(all, (queue) => queue.sent),
    (body) => !isOnlyAnId(body)
  );

layer(withDatabase(captureSenderLayer), { excludeTestServices: true })(
  "outbox delivery on Cloudflare Queues (spec 0008b), on PostgreSQL",
  (it) => {
    it.effect(
      "falsifier 1: a committed command puts its id on the queue after the commit and the receipt is recorded; the provider has not been called until the consumer runs",
      () =>
        Effect.gen(function* committed() {
          const { calls, ctx, queue, settled, url } = yield* freshRun;

          const outcome = yield* requestOutcome(url, false);

          const response = publishCommitted(
            { ctx, env: envFor(url, queue) },
            outcome
          );

          assert.isTrue(Predicate.isTagged(response, "Success"));
          yield* settled;

          assert.deepStrictEqual(queue.sent, ["1"]);
          assert.deepStrictEqual(yield* Ref.get(calls), []);
          assert.deepStrictEqual(yield* rowState("1"), {
            last_error: null,
            queued: true,
            status: "pending",
          });

          yield* consume(queue, calls);
          assert.deepStrictEqual(yield* Ref.get(calls), ["1"]);
          assert.strictEqual((yield* rowState("1")).status, "delivered");
        })
    );

    it.effect(
      "falsifier 1: a command that rolls back leaves no row, no queue message and no provider call",
      () =>
        Effect.gen(function* rolledBack() {
          const { calls, ctx, queue, settled, url } = yield* freshRun;

          const outcome = yield* requestOutcome(url, true);

          const response = publishCommitted(
            { ctx, env: envFor(url, queue) },
            outcome
          );

          assert.isTrue(Predicate.isTagged(response, "Failure"));
          yield* settled;

          assert.deepStrictEqual(queue.sent, []);
          assert.strictEqual(
            yield* rowsIn("outbox"),
            0,
            "the queued message rolled back"
          );

          yield* consume(queue, calls);
          assert.deepStrictEqual(yield* Ref.get(calls), []);
        })
    );

    it.effect(
      "falsifier 1, negative control: an id sent inside the transaction is on the queue for a row that then rolls back",
      () =>
        Effect.gen(function* publishedBeforeCommit() {
          yield* reset;

          const queue = newQueue();
          const transactor = yield* Transactor;

          const exit = yield* Effect.exit(
            transactor.run(
              Effect.gen(function* badCommand() {
                const id = yield* enqueueEmail;

                // The mistake that the structure prevents: the id goes to the queue before the commit.
                yield* Effect.promise(
                  async () =>
                    await queue.binding.send(id, { contentType: "text" })
                );

                return yield* validationFailed(
                  ["name"],
                  "refused after queueing"
                );
              })
            )
          );

          assert.isTrue(Exit.isFailure(exit));
          assert.strictEqual(yield* rowsIn("outbox"), 0, "the row rolled back");
          assert.strictEqual(
            queue.sent.length,
            1,
            "and the queue holds a message for it: the control sends one"
          );
        })
    );

    it.effect(
      "falsifier 2: a crash between commit and enqueue leaves a row that the sweep finds after the threshold, and the consumer delivers it",
      () =>
        Effect.gen(function* crashBetweenCommitAndEnqueue() {
          const { calls, queue, url } = yield* freshRun;
          const sql = yield* SqlClient;

          // The command commits; the Worker dies before `publishCommitted`: nothing was sent, no receipt exists.
          yield* requestOutcome(url, false);
          assert.deepStrictEqual(queue.sent, []);
          assert.isFalse((yield* rowState("1")).queued);

          const tick = (scheduledTime: number) =>
            Effect.promise(async () => {
              await runTick(
                envFor(url, queue),
                { cron: JobRegistry.TICK_CRON, scheduledTime },
                ["outboxSweep"]
              );
            });

          // A row that has just committed is not the sweep's: the request's own publication is on its way.
          yield* tick(yield* Clock.currentTimeMillis);
          assert.deepStrictEqual(queue.sent, [], "younger than the threshold");

          // The threshold passes: the row has been pending for longer than `requeueAfter`.
          yield* sql`update outbox set created_at = created_at - interval '11 minutes', next_attempt_at = next_attempt_at - interval '11 minutes'`;
          yield* tick((yield* Clock.currentTimeMillis) + 60_000);
          assert.deepStrictEqual(
            queue.sent,
            ["1"],
            "the sweep put its id on the queue"
          );
          assert.isTrue((yield* rowState("1")).queued);

          // A second tick finds the receipt: nothing is sent twice.
          yield* tick((yield* Clock.currentTimeMillis) + 120_000);
          assert.deepStrictEqual(queue.sent, ["1"]);

          yield* consume(queue, calls);
          assert.deepStrictEqual(
            yield* Ref.get(calls),
            ["1"],
            "delivered through the sweep"
          );
          assert.strictEqual((yield* rowState("1")).status, "delivered");
        })
    );

    it.effect(
      "falsifier 2, negative control: with the sweep disabled the message is never delivered",
      () =>
        Effect.gen(function* withoutSweep() {
          const { calls, queue, url } = yield* freshRun;
          const sql = yield* SqlClient;

          yield* requestOutcome(url, false);
          yield* sql`update outbox set created_at = created_at - interval '11 minutes', next_attempt_at = next_attempt_at - interval '11 minutes'`;

          // The tick runs no job: the sweep is off.
          const later = (yield* Clock.currentTimeMillis) + 60_000;

          yield* Effect.promise(async () => {
            await runTick(
              envFor(url, queue),
              { cron: JobRegistry.TICK_CRON, scheduledTime: later },
              []
            );
          });

          yield* consume(queue, calls);

          assert.deepStrictEqual(queue.sent, []);
          assert.deepStrictEqual(yield* Ref.get(calls), []);
          assert.strictEqual(
            (yield* rowState("1")).status,
            "pending",
            "still waiting, and nothing will send it"
          );
        })
    );

    it.effect(
      `falsifier 3: two deliveries of one id call the provider once, in each of ${ROUNDS} fresh rounds`,
      () =>
        Effect.gen(function* twoDeliveries() {
          yield* reset;

          const exits = yield* Effect.forEach(Arr.range(1, ROUNDS), (round) =>
            Effect.exit(
              Effect.gen(function* oneRound() {
                const id = yield* enqueueEmail;
                const calls = yield* Ref.make<readonly string[]>([]);

                const delivery = deliveryDecisions([id]).pipe(
                  Effect.provide(
                    Layer.mergeAll(provider(calls), noOtherServices)
                  )
                );

                yield* Effect.all([delivery, delivery], { concurrency: 2 });

                assert.deepStrictEqual(
                  yield* Ref.get(calls),
                  [id],
                  `round ${round}: the provider was not called exactly once`
                );
                assert.strictEqual((yield* rowState(id)).status, "delivered");
              })
            )
          );

          const losers = Arr.flatMap(exits, (exit, round) =>
            Exit.isFailure(exit)
              ? [`round ${round + 1}: ${Cause.pretty(exit.cause)}`]
              : []
          );

          assert.deepStrictEqual(losers, []);
        }),
      { timeout: 120_000 }
    );

    it.effect(
      `falsifier 3, negative control: without the conditional claim the provider is called twice in some of ${ROUNDS} rounds`,
      () =>
        Effect.gen(function* withoutClaim() {
          yield* reset;

          const sql = yield* SqlClient;

          /** A delivery that reads the row and sends, as one without the conditional claim would. */
          const unclaimed = (id: string, calls: Ref.Ref<readonly string[]>) =>
            Effect.gen(function* deliverWithoutClaim() {
              const [row] = yield* sql<{
                readonly status: string;
              }>`select status from outbox where id = ${Number(id)}`;

              if (row?.status === "pending") {
                yield* (yield* MessageSender).send(email, id);
                yield* sql`update outbox set status = 'delivered', delivered_at = now() where id = ${Number(id)}`;
              }
            }).pipe(Effect.provide(provider(calls)));

          const counts = yield* Effect.forEach(Arr.range(1, ROUNDS), () =>
            Effect.gen(function* oneRound() {
              const id = yield* enqueueEmail;
              const calls = yield* Ref.make<readonly string[]>([]);

              yield* Effect.all([unclaimed(id, calls), unclaimed(id, calls)], {
                concurrency: 2,
              });

              return (yield* Ref.get(calls)).length;
            })
          );

          assert.isAbove(
            Arr.filter(counts, (count) => count > 1).length,
            0,
            "the control sends twice in some rounds"
          );
        }),
      { timeout: 120_000 }
    );

    it.effect(
      "falsifier 7: outside production a consumed message reaches the capture sink and never the Email binding; in production it reaches the binding",
      () =>
        Effect.gen(function* environmentSeparation() {
          const url = yield* TestDatabaseUrl;

          const consumedIn = (deployment: "preview" | "production") =>
            Effect.gen(function* consumeIn() {
              yield* reset;

              const id = yield* enqueueEmail;
              const sends: unknown[] = [];

              const sendEmail: SendEmail = {
                send: async (message: EmailMessage | EmailMessageBuilder) => {
                  sends.push(message);

                  return await Promise.resolve({ messageId: "test" });
                },
              };

              const answers: string[] = [];

              yield* Effect.promise(async () => {
                await runQueue(
                  {
                    ...envFor(url, undefined, deployment),
                    MAIL_FROM: "no-reply@example.org",
                    SEND_EMAIL: sendEmail,
                    SLACK_WEBHOOK_URL: "https://hooks.example.org/unused",
                  },
                  {
                    messages: [
                      {
                        ack: () => {
                          answers.push("ack");
                        },
                        body: id,
                        retry: () => {
                          answers.push("retry");
                        },
                      },
                    ],
                    queue: "vp-outbox-test",
                  }
                );
              });

              return {
                answers,
                captured: yield* rowsIn("captured_mail"),
                sends: sends.length,
              };
            });

          assert.deepStrictEqual(yield* consumedIn("preview"), {
            answers: ["ack"],
            captured: 1,
            sends: 0,
          });
          assert.deepStrictEqual(
            yield* consumedIn("production"),
            { answers: ["ack"], captured: 0, sends: 1 },
            "the control: the same consumer in production does reach the binding"
          );
        })
    );

    it.effect(
      "falsifier 5: every message of the run is an outbox id; a message that holds an address is found by the same scan",
      () =>
        Effect.gen(function* scanTraffic() {
          const total = Arr.flatMap(queues, (queue) => queue.sent).length;

          assert.isAbove(total, 0, "the scan has traffic to read");
          assert.deepStrictEqual(notIds(queues), []);

          // The control: the mistake of sending the content, caught by the same scan.
          const leaking = fakeQueue();

          yield* Effect.promise(() =>
            leaking.binding.sendBatch([{ body: "avdeling@example.org" }])
          );
          assert.deepStrictEqual(notIds([...queues, leaking]), [
            "avdeling@example.org",
          ]);
        })
    );
  }
);

// ---------------------------------------------------------------- falsifier 6: code mail on the queue path

const LEADER = 501;
const INVITEE = 502;

/** The provider that fails while `provider.fails` is set and otherwise keeps the mail in the capture sink. */
const switchable = { fails: true };

const switching = Layer.effect(
  MessageSender,
  Effect.gen(function* buildSwitchingSender() {
    const store = yield* CapturedMessageStore;

    return MessageSender.of({
      send: (message, key) =>
        switchable.fails
          ? Effect.fail(
              new DeliveryFailed({ reason: "code email delivery failed" })
            )
          : store.record(message, key),
    });
  })
);

const codesOf = (person: number) =>
  Effect.gen(function* countCodes() {
    const sql = yield* SqlClient;

    const [row] = yield* sql<{
      readonly n: number;
    }>`select count(*)::int as n from code where subject = ${person}`;

    return row?.n ?? -1;
  });

const capturedMail = Schema.Array(Schema.Struct({ text: Schema.String }));

layer(withDatabase(switching), { excludeTestServices: true })(
  "falsifier 6: code mail on the queue path (spec 0007 R1)",
  (it) => {
    it.effect(
      "a failed send leaves no usable code and the row retrying; the next delivery mints the code, sends the mail and acknowledges in one transaction",
      () =>
        Effect.gen(function* codeMail() {
          const sql = yield* SqlClient;
          const url = yield* TestDatabaseUrl;

          yield* sql`insert into department (id, city, email, name, short_name) values (${LEADER}, 'Kodeby', 'kode@example.org', 'Kode', 'KOD')`;
          yield* sql`insert into field_of_study (id, department_id, name, short_name) values (${LEADER}, ${LEADER}, 'Kode', 'KOD')`;
          yield* sql`insert into ${sql("person")} ${sql.insert([
            {
              email: "kodeleader@example.org",
              field_of_study_id: LEADER,
              id: LEADER,
              name: "Leader",
            },
            {
              email: "kodeinvitee@example.org",
              field_of_study_id: LEADER,
              id: INVITEE,
              name: "Invitee",
            },
          ])}`;

          const queue = newQueue();
          const { ctx, settled } = waitUntil();

          // The invitation commits its IssueCode message; the Worker puts its id on the queue.
          const transactor = yield* Transactor;

          const committed = yield* capturingOutbox(
            transactor.run(
              AccountEndpoints.createAccount({ personId: INVITEE }).pipe(
                Effect.provideService(CurrentPrincipal, leaderOf(LEADER))
              )
            )
          );

          publishCommitted(
            { ctx, env: envFor(url, queue) },
            success({ enqueued: committed.enqueued, value: committed.value })
          );
          yield* settled;

          assert.strictEqual(queue.sent.length, 1);
          assert.isTrue(isOnlyAnId(queue.sent[0]));

          // The provider is down: the consumer mints, fails to send, and the transaction rolls the code back.
          switchable.fails = true;
          yield* queue.drain((batch, dead) => consumeBatch(batch, dead), {
            rounds: 1,
          });

          const id = Option.getOrThrow(Arr.head(queue.sent));
          const failed = yield* rowState(id);

          assert.strictEqual(failed.status, "pending");
          assert.strictEqual(failed.last_error, "code email delivery failed");
          assert.strictEqual(yield* codesOf(INVITEE), 0, "no usable code");
          assert.strictEqual(yield* rowsIn("captured_mail"), 0);
          assert.deepStrictEqual(queue.waiting(), [id], "the queue retries it");

          // The provider is back: the retry mints the code, sends the mail and acknowledges the row together.
          switchable.fails = false;
          yield* queue.drain((batch, dead) => consumeBatch(batch, dead));

          assert.strictEqual((yield* rowState(id)).status, "delivered");
          assert.strictEqual(yield* codesOf(INVITEE), 1);
          assert.strictEqual(yield* rowsIn("captured_mail"), 1);

          const [mail] = yield* Schema.decodeUnknownEffect(capturedMail)(
            yield* sql`select text from captured_mail`
          );

          const found = /[?&]kode=(?<token>c_[A-Za-z0-9_-]{43})/u.exec(
            mail?.text ?? ""
          );

          assert.isNotNull(found, "the mail holds a code link");
          assert.isTrue(
            Option.isSome(
              yield* codePrincipal(
                CodeToken.make(found?.groups?.token ?? ""),
                "activation"
              )
            ),
            "and the code is usable"
          );
          assert.deepStrictEqual(
            queue.sent,
            [id],
            "the retry was the queue's own: no second message"
          );
        })
    );
  }
);
