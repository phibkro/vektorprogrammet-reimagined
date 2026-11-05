import { Cause, Context, Effect, Layer, Predicate, Ref } from "effect";

import type { MessageSender } from "../../../adapters/messaging/senders";
import type { OutboxMessageId } from "../../../domain/ids";
/** Deliver committed outbox intents immediately; the scheduled sweep recovers unfinished rows. */
import {
  CurrentPrincipal,
  systemPrincipal,
} from "../../../domain/kernel/principal";
import type { OutboxDelivery } from "../../../domain/outbox/delivery";
import { Outbox } from "../../../domain/outbox/outbox";
import type { WorkspaceWriter } from "../../../features/workspace/domain/services";
import type { AccountDelivery } from "./accountDelivery";
import { withOutbox } from "./sweep";

export class OutboxPublisher extends Context.Service<
  OutboxPublisher,
  {
    /** Puts these ids where their delivery picks them up. Never fails; see the module's note. */
    readonly publish: (ids: readonly OutboxMessageId[]) => Effect.Effect<void>;
  }
>()("@vektorprogrammet/web/server/OutboxPublisher") {}

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
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logError("outbox delivery failed after the commit").pipe(
                  Effect.annotateLogs({
                    class: Predicate.isTagged(Cause.squash(cause), "Forbidden")
                      ? "Forbidden"
                      : "defect",
                    ids: ids.length,
                  })
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
