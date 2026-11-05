import { Effect } from "effect";
import { RpcGroup } from "effect/rpc";

/** Authorized outbox delivery and due-row discovery. */
import * as Commands from "../../../core/kernel/commands";
import * as OutboxSweep from "../../../core/outbox/declaration";
import { OutboxDelivery } from "../../../core/outbox/delivery";
import { deliverOutbox } from "./delivery";

const DeliveryRpc = RpcGroup.make(
  OutboxSweep.sweepOutbox,
  OutboxSweep.deliverOutbox
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

        return {
          stale: yield* delivery.due({
            limit,
          }),
        };
      }),
  }),
});

/** Deliver and sweep, behind the in-process client; see `Commands.inProcess`. */
export const withOutbox = Commands.inProcess(DeliveryRpc, DeliveryHandlers);
