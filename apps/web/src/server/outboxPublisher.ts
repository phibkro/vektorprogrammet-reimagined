/**
 * After a commit (spec 0008b): puts the ids of the outbox rows that a commit, a job chunk or the sweep names where their
 * delivery picks them up. The Queue binding is the boundary adapter: the only module that holds it. The outbox rows stay
 * the record of what must be sent, so a message holds an id and nothing else, and a lost message costs a delay, never a
 * delivery.
 *
 * - `queuePublisherLayer(queue)`: sends the ids as `text` messages, 100 to a call (the limit of `sendBatch`), and then
 *   writes the queue's receipt (`outbox.queued_at`: "accepted by the queue", which is not "delivered"). A send that
 *   fails is logged by its class and leaves the row without a receipt, so the sweep puts it back after
 *   `DeliveryPolicy.requeueAfter`. Cancellation does not reach the call: `Queue.sendBatch` takes no signal, so an
 *   interrupted publisher can leave a message the receipt does not mention, and the sweep sends it again (a duplicate
 *   is harmless: the claim is conditional).
 * - `directPublisherLayer`: a Worker Preview has no queue (a Queue's one consumer is the deployed Worker, which would read
 *   a Preview's ids in its own database; spec 0008b R1 item 2), so the ids are delivered here and now, to the capture
 *   sink. It is the same delivery, by the same claim, with no queue between.
 *
 * `publish` never fails: it runs after the commit, where there is nothing to roll back, and what it could not do is
 * left to the sweep. Its failures are logged with counts and classes, never with a body.
 *
 * Retires when Previews can own a queue consumer: the binding then goes to Previews and the direct layer goes away.
 */
import type { Queue } from "@cloudflare/workers-types";
import { OutboxDelivery } from "@vektorprogrammet/db";
import {
  CurrentPrincipal,
  Outbox,
  systemPrincipal,
} from "@vektorprogrammet/domain";
import type {
  OutboxMessageId,
  WorkspaceWriter,
} from "@vektorprogrammet/domain";
import { Array as Arr, Context, Effect, Layer, Ref } from "effect";

import type { AccountDelivery } from "./accountDelivery";
import { withOutbox } from "./outboxSweep";
import { QueueSendFailed } from "./queueSendFailed";
import type { MessageSender } from "./senders";

export class OutboxPublisher extends Context.Service<
  OutboxPublisher,
  {
    /** Puts these ids where their delivery picks them up. Never fails; see the module's note. */
    readonly publish: (ids: readonly OutboxMessageId[]) => Effect.Effect<void>;
  }
>()("@vektorprogrammet/web/server/OutboxPublisher") {}

/** `Queue.sendBatch` takes at most 100 messages a call (Cloudflare Queues limits). */
export const SEND_BATCH_LIMIT = 100;

/** What the Queue binding offers the publisher: a test passes a recording queue. */
export type OutboxQueue = Pick<Queue<string>, "sendBatch">;

export const queuePublisherLayer = (
  queue: OutboxQueue
): Layer.Layer<OutboxPublisher, never, OutboxDelivery> =>
  Layer.effect(
    OutboxPublisher,
    Effect.gen(function* buildQueuePublisher() {
      const delivery = yield* OutboxDelivery;

      const sendChunk = Effect.fn("OutboxPublisher.sendChunk")(
        function* sendChunk(ids: readonly OutboxMessageId[]) {
          yield* Effect.tryPromise({
            catch: (cause) => new QueueSendFailed({ cause }),
            try: () =>
              queue.sendBatch(
                Arr.map(ids, (id) => ({
                  body: id,
                  contentType: "text" as const,
                }))
              ),
          });

          yield* delivery.markQueued(ids);
        }
      );

      const publish = Effect.fn("OutboxPublisher.publish")(function* publish(
        ids: readonly OutboxMessageId[]
      ) {
        yield* Effect.forEach(
          Arr.chunksOf(ids, SEND_BATCH_LIMIT),
          (chunk) =>
            sendChunk(chunk).pipe(
              Effect.catchTag("QueueSendFailed", (failure) =>
                Effect.logWarning("outbox queue send failed").pipe(
                  Effect.annotateLogs({
                    cause: String(failure.cause),
                    ids: chunk.length,
                  })
                )
              )
            ),
          { discard: true }
        );
      });

      return OutboxPublisher.of({ publish });
    })
  );

/** What a direct delivery needs: the services of `deliverOutbox`. */
export type DirectDeliveryServices =
  | OutboxDelivery
  | AccountDelivery
  | MessageSender
  | WorkspaceWriter;

export const directPublisherLayer: Layer.Layer<
  OutboxPublisher,
  never,
  DirectDeliveryServices
> = Layer.effect(
  OutboxPublisher,
  Effect.gen(function* buildDirectPublisher() {
    const services = yield* Effect.context<DirectDeliveryServices>();

    const publish = Effect.fn("OutboxPublisher.deliverDirectly")(
      function* publish(ids: readonly OutboxMessageId[]) {
        if (ids.length === 0) {
          return;
        }

        yield* withOutbox((client) => client.deliverOutbox({ ids })).pipe(
          Effect.provideService(
            CurrentPrincipal,
            systemPrincipal("outboxSweep")
          ),
          Effect.provideContext(services),
          Effect.tap((results) =>
            Effect.logInfo("outbox delivery finished").pipe(
              Effect.annotateLogs({ rows: results.length })
            )
          ),
          Effect.catch((error) =>
            Effect.logError("outbox delivery was refused").pipe(
              Effect.annotateLogs({ error: error._tag })
            )
          )
        );
      }
    );

    return OutboxPublisher.of({ publish });
  })
);

/** Collects the outbox ids a program enqueues, so they can be published once it has committed. */
export const capturingOutbox = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.gen(function* captureOutboxEffect() {
    const enqueued = yield* Ref.make<readonly OutboxMessageId[]>([]);

    const value = yield* program.pipe(
      Effect.updateService(Outbox, (outbox) =>
        Outbox.of({
          enqueue: (messages) =>
            outbox
              .enqueue(messages)
              .pipe(
                Effect.tap((ids) =>
                  Ref.update(enqueued, (all) => [...all, ...ids])
                )
              ),
        })
      )
    );

    return { enqueued: yield* Ref.get(enqueued), value };
  });

/**
 * A committing program, then the publication of what it enqueued. `commit` is the program with its transaction
 * (`Transactor.run(…)`): the ids are only published once it has succeeded, so a rollback publishes nothing (spec
 * 0008b falsifier 1). A failed commit fails here, before the publisher is asked.
 */
export const publishingAfterCommit = <A, E, R>(
  commit: Effect.Effect<A, E, R>
) =>
  Effect.gen(function* committedThenPublished() {
    const { enqueued, value } = yield* capturingOutbox(commit);

    yield* (yield* OutboxPublisher).publish(enqueued);

    return value;
  });
