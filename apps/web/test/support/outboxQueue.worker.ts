/**
 * A test Worker over the real consumer (spec 0008b, falsifier 4): the Worker's own `queue` handler logic
 * (`handleBatch`: decode, deliver by id, `ack` or `retry`, the dead-letter queue's ending, a delivery stack that cannot be built) over the real database, with
 * a provider that fails a scripted number of times and a retry delay of zero. `FAIL_FIRST` is a number (provider failures), or `outage` (every claim dies),
 * `defect` (the sender dies after the claim), or `senders` (the delivery stack cannot be built); a payload that no longer decodes is a row the test corrupts. Miniflare runs it against real Queues, so the
 * retries, the attempt count and the dead-letter route are the runtime's.
 */
import type { MessageBatch, Queue } from "@cloudflare/workers-types";
import { DatabaseLive } from "@vektorprogrammet/db";
import { OutboxDelivery } from "@vektorprogrammet/domain";
import {
  Array as Arr,
  Context,
  Duration,
  Effect,
  Layer,
  Redacted,
  String as Str,
} from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { AccountDelivery } from "../../src/server/accountDelivery";
import { RetryDelay } from "../../src/server/outboxDelivery";
import type { DeliveryServices } from "../../src/server/outboxDelivery";
import { handleBatch } from "../../src/server/outboxQueue";
import { DeliveryFailed, MessageSender } from "../../src/server/senders";
import { refusingWriter } from "./workspaceWorld";

interface Bindings {
  readonly FAIL_FIRST: string;
  readonly HYPERDRIVE: { readonly connectionString: string };
  readonly OUTBOX_QUEUE: Queue<string>;
}

/** A provider that counts every call in `provider_calls` and fails the first `FAIL_FIRST` calls for a row (the count in RETURNING is of the rows before the insert). */
const scriptedProvider = (failFirst: string) =>
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

            if (failFirst === "defect") {
              return yield* Effect.die("the sender died");
            }

            return (row?.n ?? 0) < Number(failFirst)
              ? yield* new DeliveryFailed({ reason: "scripted failure" })
              : undefined;
          }),
      });
    })
  );

const databaseFor = (env: Bindings) =>
  DatabaseLive({
    maxConnections: 2,
    url: Redacted.make(env.HYPERDRIVE.connectionString),
  }).pipe(Layer.orDie);

const providerFor = (failFirst: string) =>
  failFirst === "senders"
    ? Layer.effect(MessageSender, Effect.die("sender binding missing"))
    : scriptedProvider(failFirst);

/** `outage`: every claim dies, and only the claim: the dead-letter ending runs against the real database. */
const dyingClaims = Layer.effectContext(
  Effect.map(Effect.context<DeliveryServices>(), (context) =>
    Context.add(
      context,
      OutboxDelivery,
      OutboxDelivery.of({
        ...Context.get(context, OutboxDelivery),
        claim: () => Effect.die("the database is unreachable"),
      })
    )
  )
);

const deliveryFor = (env: Bindings) => {
  const stack = Layer.mergeAll(
    Layer.mock(AccountDelivery, {}),
    refusingWriter
  ).pipe(
    Layer.provideMerge(
      providerFor(env.FAIL_FIRST).pipe(Layer.provideMerge(databaseFor(env)))
    )
  );

  return env.FAIL_FIRST === "outage"
    ? dyingClaims.pipe(Layer.provide(stack))
    : stack;
};

export default {
  fetch: (request: Request, env: Bindings): Promise<Response> =>
    Effect.runPromise(
      Effect.gen(function* send() {
        const body = yield* Effect.promise(() => request.text());

        yield* Effect.promise(() =>
          env.OUTBOX_QUEUE.sendBatch(
            Arr.map(Str.split(body, ","), (id) => ({
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

        yield* handleBatch(batch, {
          database: databaseFor(env),
          delivery: deliveryFor(env),
        }).pipe(Effect.provideService(RetryDelay, () => Duration.zero));
      }).pipe(Effect.provide(databaseFor(env)))
    ),
};
