/**
 * The handlers of the outbox's three commands (the `outboxSweep` job, spec 0006 R1, spec 0008b). The domain declares them
 * and grants them to `System("outboxSweep")` alone; the handlers live here because delivery needs the transports and
 * `packages/db`'s delivery side. Everything that touches a row runs as that principal, through `authorize`, like every
 * other command: the queue's consumer, the dead-letter queue's consumer, the Worker Preview's direct delivery and the
 * cron sweep.
 *
 * Two in-process clients, because a client requires what all its handlers require: `withOutbox` (deliver and sweep:
 * the transports, Better Auth, the Workspace writer) and `withEnding` (the dead-letter ending: the database only), so
 * the dead-letter consumer builds no more than it uses.
 */
import {
  Commands,
  OutboxDelivery,
  OutboxSweep,
} from "@vektorprogrammet/domain";
import { DateTime, Effect } from "effect";
import { RpcGroup } from "effect/rpc";

import { RetryDelay, deliverOutbox, failOutbox } from "./outboxDelivery";

const DeliveryRpc = RpcGroup.make(
  OutboxSweep.sweepOutbox,
  OutboxSweep.deliverOutbox
);

const EndingRpc = RpcGroup.make(
  OutboxSweep.failOutbox,
  OutboxSweep.recordOutboxFailure
);

const DeliveryHandlers = DeliveryRpc.toLayer({
  deliverOutbox: OutboxSweep.OutboxDomain.handle(OutboxSweep.deliverOutbox, {
    resource: () => Effect.succeed({}),
    run: ({ ids }) => deliverOutbox(ids),
  }),
  sweepOutbox: OutboxSweep.OutboxDomain.handle(OutboxSweep.sweepOutbox, {
    resource: () => Effect.succeed({}),
    run: ({ limit }) =>
      Effect.gen(function* findStale() {
        const delivery = yield* OutboxDelivery;
        const now = yield* DateTime.now;

        return {
          stale: yield* delivery.stale({
            before: DateTime.subtractDuration(
              now,
              OutboxSweep.DeliveryPolicy.requeueAfter
            ),
            limit,
          }),
        };
      }),
  }),
});

const EndingHandlers = EndingRpc.toLayer({
  failOutbox: OutboxSweep.OutboxDomain.handle(OutboxSweep.failOutbox, {
    resource: () => Effect.succeed({}),
    run: ({ ids }) => failOutbox(ids),
  }),
  recordOutboxFailure: OutboxSweep.OutboxDomain.handle(
    OutboxSweep.recordOutboxFailure,
    {
      resource: () => Effect.succeed({}),
      run: ({ failure, messages }) =>
        Effect.gen(function* recordFailures() {
          const delivery = yield* OutboxDelivery;
          const now = yield* DateTime.now;
          const delays = yield* RetryDelay;

          const recorded = yield* Effect.forEach(messages, (message) =>
            Effect.map(
              delivery.recordFailure(
                message.id,
                failure,
                DateTime.addDuration(now, delays(message.attempts))
              ),
              (outcome) => (outcome === "recorded" ? [message.id] : [])
            )
          );

          return recorded.flat();
        }),
    }
  ),
});

/** Deliver and sweep, behind the in-process client; see `Commands.inProcess`. */
export const withOutbox = Commands.inProcess(DeliveryRpc, DeliveryHandlers);

/** The dead-letter ending and the record of a delivery that could not start, behind their own in-process client. */
export const withEnding = Commands.inProcess(EndingRpc, EndingHandlers);
