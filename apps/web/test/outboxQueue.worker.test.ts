/**
 * Spec 0008b falsifier 4 in the real Queues runtime. Miniflare runs the Worker's consumer (`support/outboxQueue.worker.ts`:
 * the real `consumeBatch` over the real database) against real queues configured as `OUTBOX_CONSUMER` and
 * `DEAD_LETTER_CONSUMER` say, so the attempt count, the retries and the route to the dead-letter queue are the runtime's:
 *
 * - a provider that fails 3 times and then answers: the row ends `delivered`, after four deliveries of one message;
 * - a provider that always fails: the row ends `failed` (`dead`) after the declared attempts, through the dead-letter queue;
 * - control: the same provider and queue without a dead-letter queue: the row is still pending after the declared attempts,
 *   so it is the dead-letter queue that ends it;
 * - falsifier 5 on real traffic: every body that the consumer saw is an outbox id.
 *
 * Miniflare is not Cloudflare's production: it is the same `workerd` and the same documented rules (`max_retries + 1`
 * deliveries, then the dead-letter queue), and `main`'s first run is the deployed evidence.
 */
import { assert, layer } from "@effect/vitest";
import { DatabaseLive } from "@vektorprogrammet/db";
import {
  TestDatabaseUrl,
  migratedTestDatabase,
} from "@vektorprogrammet/db/testing";
import {
  EmailAddress,
  Outbox,
  OutboxMessage,
  OutboxSweep,
} from "@vektorprogrammet/domain";
import type { OutboxMessageId } from "@vektorprogrammet/domain";
import { Array as Arr, Config, Effect, Layer, Redacted, Schema } from "effect";
import type { Redacted as RedactedValue } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import {
  DEAD_LETTER_CONSUMER,
  OUTBOX_CONSUMER,
  outboxDeadLetterName,
  outboxQueueName,
} from "../worker.config";
import { testWorker } from "./support/workerRuntime";

const QUEUE = outboxQueueName("test");
const DEAD_LETTER = outboxDeadLetterName("test");
const DECLARED_DELIVERIES = OutboxSweep.DeliveryPolicy.attempts;

const mail = OutboxMessage.cases.Email.make({
  replyTo: null,
  subject: "Henvendelse",
  text: "Hei, dette er en melding til avdeling@example.org",
  to: EmailAddress.make("avdeling@example.org"),
});

const live = Layer.unwrap(
  Effect.map(Effect.service(TestDatabaseUrl), (url) =>
    DatabaseLive({ maxConnections: 4, url })
  )
).pipe(Layer.provideMerge(migratedTestDatabase), Layer.orDie);

/** Miniflare's Hyperdrive wants a user and a password in the URL; the database trusts every local connection. */
const hyperdriveUrl = (url: RedactedValue.Redacted) =>
  Effect.gen(function* withCredentials() {
    const parsed = new URL(Redacted.value(url));

    if (parsed.username === "") {
      parsed.username = yield* Config.String("USER").pipe(
        Config.withDefault("postgres")
      );
    }

    if (parsed.password === "") {
      parsed.password = "trust-auth-ignores-this";
    }

    return parsed.toString();
  }).pipe(Effect.orDie);

const reset = Effect.gen(function* reset() {
  const sql = yield* SqlClient;

  yield* sql`truncate outbox restart identity`;
  yield* sql`drop table if exists provider_calls`;
  yield* sql`drop table if exists queue_log`;
  yield* sql`create table provider_calls (key text not null)`;
  yield* sql`create table queue_log (queue text not null, body text not null, attempts integer not null)`;
});

interface Observed {
  readonly status: string;
  readonly lastError: string | null;
  readonly calls: number;
  readonly deliveries: readonly (readonly [string, number])[];
}

const observe = (id: OutboxMessageId) =>
  Effect.gen(function* readState() {
    const sql = yield* SqlClient;

    const [row] = yield* sql<{
      readonly status: string;
      readonly last_error: string | null;
    }>`select status, last_error from outbox where id = ${Number(id)}`;

    const [calls] = yield* sql<{
      readonly n: number;
    }>`select count(*)::int as n from provider_calls`;

    const log = yield* sql<{
      readonly queue: string;
      readonly attempts: number;
    }>`select queue, attempts from queue_log order by queue, attempts`;

    return {
      calls: calls?.n ?? 0,
      deliveries: Arr.map(
        log,
        (entry) => [entry.queue, entry.attempts] as const
      ),
      lastError: row?.last_error ?? null,
      status: row?.status ?? "missing",
    } satisfies Observed;
  });

/** Polls the database until `done` holds, for at most `seconds`: the runtime's timers are real, and so is the wait. */
const until = (
  id: OutboxMessageId,
  done: (observed: Observed) => boolean,
  seconds: number
) =>
  Effect.gen(function* poll() {
    let observed = yield* observe(id);

    for (let tries = 0; tries < seconds * 5 && !done(observed); tries += 1) {
      yield* Effect.sleep("200 millis");
      observed = yield* observe(id);
    }

    return observed;
  });

/** One Miniflare with the consumer of both queues, a provider that fails its first `failFirst` calls, and a queue pair as given. */
const runScenario = (options: {
  readonly failFirst: number;
  readonly withDeadLetterQueue: boolean;
  readonly waitFor: (observed: Observed) => boolean;
}) =>
  Effect.scoped(
    Effect.gen(function* scenario() {
      yield* reset;

      const url = yield* hyperdriveUrl(yield* TestDatabaseUrl);
      const [id] = yield* (yield* Outbox).enqueue([mail]);

      if (id === undefined) {
        return yield* Effect.die("one message was enqueued");
      }

      const worker = yield* testWorker(
        "outboxQueue.worker.ts",
        { FAIL_FIRST: String(options.failFirst) },
        {
          hyperdrives: { HYPERDRIVE: url },
          queueConsumers: {
            [DEAD_LETTER]: {
              maxBatchSize: DEAD_LETTER_CONSUMER.batchSize,
              maxBatchTimeout: 1,
              maxRetries: DEAD_LETTER_CONSUMER.maxRetries,
              retryDelay: 0,
            },
            [QUEUE]: {
              deadLetterQueue: options.withDeadLetterQueue
                ? DEAD_LETTER
                : undefined,
              maxBatchSize: OUTBOX_CONSUMER.batchSize,
              maxBatchTimeout: 1,
              maxRetries: OUTBOX_CONSUMER.maxRetries,
              retryDelay: 0,
            },
          },
          queueProducers: { OUTBOX_QUEUE: QUEUE },
        }
      );

      // The Worker's own `fetch` puts the id on the queue, as `publishCommitted` does after a commit.
      const sent = yield* Effect.promise(() =>
        worker.dispatchFetch("http://outbox.test/", {
          body: id,
          method: "POST",
        })
      );

      assert.strictEqual(yield* Effect.promise(() => sent.text()), "sent");

      return { id, observed: yield* until(id, options.waitFor, 40) };
    })
  );

layer(live, { excludeTestServices: true })(
  "outbox delivery on the real Queues runtime (spec 0008b falsifier 4, in Miniflare)",
  (it) => {
    it.effect(
      "the declared attempts are the queue's: max_retries is one fewer than the attempts, because a message is delivered max_retries + 1 times",
      () =>
        Effect.sync(() => {
          assert.strictEqual(
            OUTBOX_CONSUMER.maxRetries + 1,
            DECLARED_DELIVERIES
          );
        })
    );

    it.effect(
      "a provider that fails 3 times and then answers: the message is retried and the row ends delivered",
      () =>
        Effect.gen(function* retriedUntilDelivered() {
          const { observed } = yield* runScenario({
            failFirst: 3,
            waitFor: (state) => state.status === "delivered",
            withDeadLetterQueue: true,
          });

          assert.deepStrictEqual(observed.deliveries, [
            [QUEUE, 1],
            [QUEUE, 2],
            [QUEUE, 3],
            [QUEUE, 4],
          ]);
          assert.strictEqual(observed.status, "delivered");
          assert.strictEqual(
            observed.calls,
            4,
            "three failures and the answer"
          );
        }),
      { timeout: 90_000 }
    );

    it.effect(
      "a provider that always fails: the row ends failed after the declared attempts, through the dead-letter queue",
      () =>
        Effect.gen(function* alwaysFailing() {
          const { observed } = yield* runScenario({
            failFirst: 1000,
            waitFor: (state) => state.status === "dead",
            withDeadLetterQueue: true,
          });

          assert.strictEqual(observed.status, "dead");
          assert.strictEqual(
            observed.lastError,
            "scripted failure",
            "the class of the last failure, never a message"
          );
          assert.strictEqual(observed.calls, DECLARED_DELIVERIES);
          assert.deepStrictEqual(
            observed.deliveries,
            [
              ...Arr.makeBy(
                DECLARED_DELIVERIES,
                (index) => [QUEUE, index + 1] as const
              ),
              [DEAD_LETTER, 1],
            ],
            "the declared deliveries, then one delivery to the dead-letter queue"
          );
        }),
      { timeout: 90_000 }
    );

    it.effect(
      "falsifier 4, negative control: without the dead-letter queue the row is still pending after the declared attempts",
      () =>
        Effect.gen(function* withoutDeadLetterQueue() {
          const { id, observed } = yield* runScenario({
            failFirst: 1000,
            waitFor: (state) => state.calls >= DECLARED_DELIVERIES,
            withDeadLetterQueue: false,
          });

          assert.strictEqual(observed.calls, DECLARED_DELIVERIES);

          // Give the runtime time to do anything else it is going to do, then look again.
          yield* Effect.sleep("3 seconds");

          const later = yield* observe(id);

          assert.strictEqual(
            later.status,
            "pending",
            "nothing ends the row: it is the dead-letter queue that makes it failed"
          );
          assert.strictEqual(later.calls, DECLARED_DELIVERIES);
        }),
      { timeout: 90_000 }
    );

    it.effect(
      "falsifier 5 on real traffic: every message the consumer was given is an outbox id",
      () =>
        Effect.gen(function* scanLog() {
          const sql = yield* SqlClient;

          const bodies = yield* sql<{
            readonly body: string;
          }>`select body from queue_log`;

          assert.isAbove(bodies.length, 0, "the last scenario left traffic");
          assert.isTrue(
            Arr.every(bodies, (entry) =>
              Schema.is(OutboxSweep.QueueBody)(entry.body)
            )
          );
        })
    );
  }
);
