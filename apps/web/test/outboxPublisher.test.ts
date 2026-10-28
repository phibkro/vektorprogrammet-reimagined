/**
 * The publisher after a commit (spec 0008b): it never fails and never dies, because the command or job chunk that
 * called it has already committed; a chunk that went wrong does not stop the next one; what it could not record is
 * left to the sweep.
 */
import { assert, describe, it } from "@effect/vitest";
import { OutboxDelivery } from "@vektorprogrammet/db";
import { OutboxMessageId } from "@vektorprogrammet/domain";
import { Array as Arr, Effect, Exit, Layer } from "effect";

import {
  OutboxPublisher,
  SEND_BATCH_LIMIT,
  queuePublisherLayer,
} from "../src/server/outboxPublisher";
import { fakeQueue } from "./support/fakeQueue";
import { makeTables, memoryLayer } from "./support/memory";

const manyIds = (n: number) =>
  Arr.makeBy(n, (index) => OutboxMessageId.make(String(index + 1)));

describe("OutboxPublisher.publish after the commit", () => {
  it.effect(
    "the receipt cannot be written (the database died after the queue accepted the ids): publish still succeeds and every chunk is sent",
    () =>
      Effect.gen(function* receiptDefect() {
        const queue = fakeQueue();
        const ids = manyIds(SEND_BATCH_LIMIT * 2 + 50);

        const dying = Layer.effect(
          OutboxDelivery,
          Effect.map(Effect.service(OutboxDelivery), (real) =>
            OutboxDelivery.of({
              ...real,
              markQueued: () => Effect.die("the database died"),
            })
          )
        ).pipe(Layer.provide(memoryLayer(makeTables())));

        const exit = yield* Effect.exit(
          OutboxPublisher.use((publisher) => publisher.publish(ids)).pipe(
            Effect.provide(
              queuePublisherLayer(queue.binding).pipe(Layer.provide(dying))
            )
          )
        );

        assert.isTrue(
          Exit.isSuccess(exit),
          "a committed job chunk is never marked failed by its publication"
        );
        assert.strictEqual(
          queue.sent.length,
          ids.length,
          "the failing receipt of one chunk did not stop the other chunks"
        );
      })
  );

  it.effect(
    "a send that the queue refuses is logged and does not stop the next chunk",
    () =>
      Effect.gen(function* refusedChunk() {
        const queue = fakeQueue();
        const sent: number[] = [];

        const refusingFirst = {
          ...queue.binding,
          sendBatch: (messages: Iterable<{ readonly body: string }>) => {
            const batch = [...messages];
            sent.push(batch.length);

            return sent.length === 1
              ? Promise.reject(new Error("queue unavailable"))
              : queue.binding.sendBatch(batch);
          },
        };

        const exit = yield* Effect.exit(
          OutboxPublisher.use((publisher) =>
            publisher.publish(manyIds(SEND_BATCH_LIMIT + 3))
          ).pipe(
            Effect.provide(
              queuePublisherLayer(refusingFirst).pipe(
                Layer.provide(memoryLayer(makeTables()))
              )
            )
          )
        );

        assert.isTrue(Exit.isSuccess(exit));
        assert.deepStrictEqual(sent, [SEND_BATCH_LIMIT, 3]);
        assert.strictEqual(
          queue.sent.length,
          3,
          "the second chunk reached the queue"
        );
      })
  );
});
