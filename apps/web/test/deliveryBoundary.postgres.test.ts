/**
 * The boundary between a command and its providers, on real PostgreSQL (spec 0008, falsifiers 2 and 3).
 *
 * Falsifier 2: a provider is called after the command has committed, never inside its transaction. The probe is the
 * provider itself: it reads the outbox row from a second connection when it is called, and an uncommitted row is not
 * visible there. A rolled-back command leaves neither a row nor a provider call. The negative control is a command that
 * calls the provider inside its transaction, which the same probe catches.
 *
 * Falsifier 3: a delivery that crashes after the provider answered and before the acknowledgement is claimed again and
 * sends again with the same key, and the keyed capture sink keeps the message once. The control is a sink that has no
 * key, which keeps it twice.
 */
import { assert, layer } from "@effect/vitest";
import { DatabaseLive, OutboxDelivery } from "@vektorprogrammet/db";
import {
  TestDatabaseUrl,
  migratedTestDatabase,
  withClient,
} from "@vektorprogrammet/db/testing";
import {
  EmailAddress,
  Outbox,
  OutboxMessage,
  SlackTarget,
  validationFailed,
} from "@vektorprogrammet/domain";
import type {
  OutboxMessageId,
  TransportMessage,
} from "@vektorprogrammet/domain";
import {
  Array as Arr,
  DateTime,
  Effect,
  Exit,
  Layer,
  Predicate,
  Ref,
} from "effect";
import type { Redacted } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { TestClock } from "effect/testing";

import { AccountDelivery } from "../src/server/accountDelivery";
import { deliverOutbox } from "../src/server/outboxDelivery";
import { runCommandOutcome } from "../src/server/runtime";
import { MessageSender, captureSenderLayer } from "../src/server/senders";
import { Transactor, transactorLayer } from "../src/server/transactor";
import { rowsIn as countRows } from "./support/rowCount";
import { refusingWriter } from "./support/workspaceWorld";

const T0 = DateTime.makeUnsafe("2026-10-27T12:00:00Z");

const email = OutboxMessage.cases.Email.make({
  replyTo: null,
  subject: "Henvendelse",
  text: "Hei",
  to: EmailAddress.make("avdeling@example.org"),
});

const slack = OutboxMessage.cases.SlackPost.make({
  target: SlackTarget.cases.Notifications.make({}),
  text: "Ny henvendelse",
});

const live = Layer.unwrap(
  Effect.map(Effect.service(TestDatabaseUrl), (url) =>
    transactorLayer.pipe(
      Layer.provideMerge(DatabaseLive({ maxConnections: 8, url }))
    )
  )
).pipe(Layer.provideMerge(migratedTestDatabase), Layer.orDie);

/** What a provider saw when it was called: the row's key, and whether a second connection could read that row. */
interface Observation {
  readonly key: string;
  readonly visible: boolean;
}

/** The provider as a probe: on each call it reads the outbox row from another connection and records what it saw. */
const probingProvider = (seen: Ref.Ref<readonly Observation[]>) =>
  Layer.effect(
    MessageSender,
    Effect.gen(function* probe() {
      const url = yield* TestDatabaseUrl;

      return MessageSender.of({
        send: (_message, key) =>
          Effect.orDie(
            withClient(
              url,
              (client) =>
                client<{
                  readonly n: number;
                }>`select count(*)::int as n from outbox where id = ${Number(key)}`
            )
          ).pipe(
            Effect.flatMap((rows) =>
              Ref.update(seen, (all) => [
                ...all,
                { key, visible: rows[0]?.n === 1 },
              ])
            )
          ),
      });
    })
  );

const noOtherServices = Layer.mergeAll(
  Layer.mock(AccountDelivery, {}),
  refusingWriter
);

const reset = Effect.gen(function* reset() {
  const sql = yield* SqlClient;

  yield* sql`truncate outbox, captured_mail, captured_slack restart identity`;
});

const freshProbe = Effect.gen(function* probeFixture() {
  yield* reset;

  return {
    seen: yield* Ref.make<readonly Observation[]>([]),
    url: yield* TestDatabaseUrl,
  };
});

/** A command that queues one message, as `contact` does, in the transaction that the runner opens. */
const enqueueOne = Effect.gen(function* enqueueOne() {
  return yield* (yield* Outbox).enqueue([email]);
});

/** Exercises the actual request runtime, optionally failing after it queues the message. */
const requestOutcome = (url: Redacted.Redacted, rollback: boolean) =>
  Effect.promise(
    async () =>
      await runCommandOutcome(
        transactorLayer.pipe(
          Layer.provideMerge(DatabaseLive({ maxConnections: 4, url })),
          Layer.orDie
        ),
        Effect.void,
        () =>
          rollback
            ? Effect.andThen(
                enqueueOne,
                Effect.fail(
                  validationFailed(["name"], "refused after queueing")
                )
              )
            : enqueueOne,
        new AbortController().signal
      )
  );

layer(live, { excludeTestServices: true })(
  "the delivery boundary on PostgreSQL",
  (it) => {
    it.effect(
      "falsifier 2: no provider is called inside the command; after the commit the provider sees the committed row",
      () =>
        Effect.gen(function* afterCommit() {
          const { url, seen } = yield* freshProbe;

          const outcome = yield* requestOutcome(url, false);

          assert.isTrue(Predicate.isTagged(outcome, "Success"));

          assert.deepStrictEqual(
            yield* Ref.get(seen),
            [],
            "the command has returned and no provider was called"
          );

          const ids: readonly OutboxMessageId[] = Predicate.isTagged(
            outcome,
            "Success"
          )
            ? outcome.value.enqueued
            : [];

          assert.strictEqual(ids.length, 1);

          yield* deliverOutbox({ ids, limit: ids.length }).pipe(
            Effect.provide(
              Layer.mergeAll(probingProvider(seen), noOtherServices)
            )
          );

          const observed = yield* Ref.get(seen);

          assert.strictEqual(observed.length, 1);
          assert.strictEqual(
            observed[0]?.visible,
            true,
            "a second connection read the row: it was committed before the provider was called"
          );
        })
    );

    it.effect(
      "falsifier 2: a command that fails leaves neither a row nor a provider call",
      () =>
        Effect.gen(function* rolledBack() {
          const { url, seen } = yield* freshProbe;

          const outcome = yield* requestOutcome(url, true);

          assert.isTrue(Predicate.isTagged(outcome, "Failure"));
          assert.strictEqual(
            yield* countRows("outbox"),
            0,
            "the queued message rolled back"
          );

          // Whatever sweeps next finds nothing to send.
          yield* deliverOutbox({ limit: 50 }).pipe(
            Effect.provide(
              Layer.mergeAll(probingProvider(seen), noOtherServices)
            )
          );

          assert.deepStrictEqual(yield* Ref.get(seen), []);
        })
    );

    it.effect(
      "falsifier 2, negative control: a command that calls the provider inside its transaction is seen by the same probe, which reads an uncommitted row as missing",
      () =>
        Effect.gen(function* insideTransaction() {
          yield* reset;

          const seen = yield* Ref.make<readonly Observation[]>([]);
          const transactor = yield* Transactor;

          yield* transactor
            .run(
              Effect.gen(function* badCommand() {
                const [id] = yield* (yield* Outbox).enqueue([email]);

                // The mistake that the structure prevents: a provider call before the commit.
                yield* (yield* MessageSender).send(email, id ?? "0");
              })
            )
            .pipe(Effect.provide(probingProvider(seen)));

          const observed = yield* Ref.get(seen);

          assert.strictEqual(observed.length, 1);
          assert.strictEqual(
            observed[0]?.visible,
            false,
            "inside the transaction the row is invisible to a second connection: the probe catches the call"
          );
        })
    );

    it.layer(TestClock.layer())((layerTest) => {
      layerTest.effect(
        "falsifier 3: a crash after the provider answered and before the acknowledgement re-sends with the same key and converges to one captured message",
        () =>
          Effect.gen(function* crashBeforeAcknowledgement() {
            yield* TestClock.setTime(DateTime.toEpochMillis(T0));
            yield* reset;

            const [mailId, slackId] = yield* (yield* Outbox).enqueue([
              email,
              slack,
            ]);

            const crashed = yield* Effect.exit(
              deliverOutbox({ limit: 50 }).pipe(
                Effect.updateService(OutboxDelivery, (real) =>
                  OutboxDelivery.of({
                    ...real,
                    markDelivered: () =>
                      Effect.die("the process died before the acknowledgement"),
                  })
                ),
                Effect.provide(
                  Layer.mergeAll(captureSenderLayer, noOtherServices)
                )
              )
            );

            assert.isTrue(
              Exit.isFailure(crashed),
              "the first delivery crashed"
            );
            assert.strictEqual(
              yield* countRows("captured_mail"),
              1,
              "the provider answered"
            );

            // The lease runs out; the next sweep claims both rows again, and the provider hears from them again.
            yield* TestClock.adjust("121 seconds");

            const again = yield* deliverOutbox({ limit: 50 }).pipe(
              Effect.provide(
                Layer.mergeAll(captureSenderLayer, noOtherServices)
              )
            );

            assert.deepStrictEqual(
              Arr.map(again, (row) => row.outcome),
              ["delivered", "delivered"]
            );
            assert.strictEqual(
              yield* countRows("captured_mail"),
              1,
              "one e-mail, however often it was sent"
            );
            assert.strictEqual(
              yield* countRows("captured_slack"),
              1,
              "and one Slack post, kept where a browser test can read it"
            );

            const sql = yield* SqlClient;

            const keys = yield* sql<{
              readonly delivery_key: string;
            }>`select delivery_key from captured_mail union all select delivery_key from captured_slack order by delivery_key`;

            assert.deepStrictEqual(
              Arr.map(keys, (row) => row.delivery_key),
              [mailId, slackId]
            );

            const statuses = yield* sql<{
              readonly status: string;
              readonly attempts: number;
            }>`select status, attempts from outbox order by id`;

            assert.deepStrictEqual(
              Arr.map(statuses, (row) => [row.status, row.attempts]),
              [
                ["delivered", 2],
                ["delivered", 2],
              ]
            );
          })
      );

      layerTest.effect(
        "falsifier 3, negative control: a sink without the key keeps the message twice after the same crash",
        () =>
          Effect.gen(function* keylessSink() {
            yield* TestClock.setTime(DateTime.toEpochMillis(T0));
            yield* reset;

            const sql = yield* SqlClient;
            yield* (yield* Outbox).enqueue([email]);

            const keyless = Layer.succeed(MessageSender)(
              MessageSender.of({
                send: (message: TransportMessage) =>
                  Effect.orDie(
                    sql`insert into captured_mail (recipient, sent_at, subject, text) values (${message._tag}, now(), 'x', 'y')`
                  ),
              })
            );

            const crashingSweep = deliverOutbox({ limit: 50 }).pipe(
              Effect.updateService(OutboxDelivery, (real) =>
                OutboxDelivery.of({
                  ...real,
                  markDelivered: () => Effect.die("crashed"),
                })
              ),
              Effect.provide(Layer.mergeAll(keyless, noOtherServices)),
              Effect.exit
            );

            yield* crashingSweep;
            yield* TestClock.adjust("121 seconds");
            yield* deliverOutbox({ limit: 50 }).pipe(
              Effect.provide(Layer.mergeAll(keyless, noOtherServices))
            );

            assert.strictEqual(
              yield* countRows("captured_mail"),
              2,
              "without a key the provider cannot tell the second send from a new message"
            );
          })
      );
    });
  }
);
