/**
 * The handlers of the outbox's three commands (the `outboxSweep` job, spec 0006 R1, spec 0008b). The domain declares them
 * and grants them to `System("outboxSweep")` alone; the handlers live here because delivery needs the transports and
 * `packages/db`'s delivery side. Everything that touches a row runs as that principal, through `authorize`, like every
 * other command: the queue's consumer, the dead-letter queue's consumer, the Worker Preview's direct delivery and the
 * cron sweep.
 */
import { OutboxDelivery } from "@vektorprogrammet/db";
import { Commands, OutboxSweep } from "@vektorprogrammet/domain";
import { DateTime, Effect } from "effect";

import { deliverOutbox, failOutbox } from "./outboxDelivery";

export const OutboxHandlers = OutboxSweep.OutboxRpc.toLayer({
  deliverOutbox: OutboxSweep.OutboxDomain.handle(OutboxSweep.deliverOutbox, {
    resource: () => Effect.succeed({}),
    run: ({ ids }) => deliverOutbox(ids),
  }),
  failOutbox: OutboxSweep.OutboxDomain.handle(OutboxSweep.failOutbox, {
    resource: () => Effect.succeed({}),
    run: ({ ids }) => failOutbox(ids),
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

/** The commands behind the in-process client; see `Commands.inProcess`. */
export const withOutbox = Commands.inProcess(
  OutboxSweep.OutboxRpc,
  OutboxHandlers
);
