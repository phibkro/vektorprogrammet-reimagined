/**
 * A test Worker over the real consumer (spec 0008b, falsifier 4): the Worker's own `queue` handler logic
 * (`consumeBatch`: decode, deliver by id, `ack` or `retry`, the dead-letter queue's ending) over the real database, with
 * a provider that fails a scripted number of times and a retry delay of zero. Miniflare runs it against real Queues, so the
 * retries, the attempt count and the dead-letter route are the runtime's.
 */
import type { MessageBatch, Queue } from "@cloudflare/workers-types";
import { DatabaseLive } from "@vektorprogrammet/db";
import { Array as Arr, Duration, Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { AccountDelivery } from "../../src/server/accountDelivery";
import { RetryDelay } from "../../src/server/outboxDelivery";
import { consumeBatch } from "../../src/server/outboxQueue";
import { DeliveryFailed, MessageSender } from "../../src/server/senders";
import { DEAD_LETTER_SUFFIX } from "../../worker.config";
import { refusingWriter } from "./workspaceWorld";

interface Bindings {
  readonly FAIL_FIRST: string;
  readonly HYPERDRIVE: { readonly connectionString: string };
  readonly OUTBOX_QUEUE: Queue<string>;
}

/** A provider that counts every call in `provider_calls` and fails the first `FAIL_FIRST` calls for a row (the count in RETURNING is of the rows before the insert). */
const scriptedProvider = (failFirst: number) =>
  Layer.effect(
    MessageSender,
    Effect.gen(function* scripted() {
      const sql = yield* SqlClient;

      return MessageSender.of({
        send: (_message, key) =>
          Effect.gen(function* send() {
            const [row] = yield* Effect.orDie(
              sql<{
                readonly n: number;
              }>`insert into provider_calls (key) values (${key}) returning (select count(*)::int from provider_calls where key = ${key}) as n`
            );

            return (row?.n ?? 0) < failFirst
              ? yield* new DeliveryFailed({ reason: "scripted failure" })
              : undefined;
          }),
      });
    })
  );

const servicesFor = (env: Bindings) =>
  Layer.mergeAll(
    Layer.mock(AccountDelivery, {}),
    refusingWriter,
    Layer.succeed(RetryDelay)(() => Duration.zero)
  ).pipe(
    Layer.provideMerge(
      scriptedProvider(Number(env.FAIL_FIRST)).pipe(
        Layer.provideMerge(
          DatabaseLive({
            maxConnections: 2,
            url: Redacted.make(env.HYPERDRIVE.connectionString),
          }).pipe(Layer.orDie)
        )
      )
    )
  );

export default {
  fetch: (request: Request, env: Bindings): Promise<Response> =>
    Effect.runPromise(
      Effect.gen(function* send() {
        const body = yield* Effect.promise(() => request.text());

        yield* Effect.promise(() =>
          env.OUTBOX_QUEUE.sendBatch(
            Arr.map(body.split(","), (id) => ({
              body: id,
              contentType: "text" as const,
            }))
          )
        );

        return new Response("sent");
      })
    ),
  queue: (batch: MessageBatch, env: Bindings): Promise<void> =>
    Effect.runPromise(
      Effect.gen(function* handle() {
        const sql = yield* SqlClient;

        yield* Effect.forEach(
          batch.messages,
          (message) =>
            Effect.orDie(
              sql`insert into queue_log (queue, body, attempts) values (${batch.queue}, ${String(message.body)}, ${message.attempts})`
            ),
          { discard: true }
        );

        yield* consumeBatch(batch, batch.queue.endsWith(DEAD_LETTER_SUFFIX));
      }).pipe(Effect.provide(servicesFor(env)))
    ),
};
