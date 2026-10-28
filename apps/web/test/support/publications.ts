/**
 * An `OutboxPublisher` that records what it was asked to publish (spec 0008b), for the tests that run jobs and need
 * the publication step but not a queue. `Publications` is the record, in order.
 */
import type { OutboxMessageId } from "@vektorprogrammet/domain";
import { Context, Effect, Layer, Ref } from "effect";

import { OutboxPublisher } from "../../src/server/outboxPublisher";

export class Publications extends Context.Service<
  Publications,
  Ref.Ref<readonly OutboxMessageId[]>
>()("test/Publications") {}

export const recordingPublisher = Layer.effectContext(
  Effect.gen(function* recordingPublisher() {
    const published = yield* Ref.make<readonly OutboxMessageId[]>([]);

    return Context.make(Publications, published).pipe(
      Context.add(
        OutboxPublisher,
        OutboxPublisher.of({
          publish: (ids) => Ref.update(published, (all) => [...all, ...ids]),
        })
      )
    );
  })
);
