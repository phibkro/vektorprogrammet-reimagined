/**
 * The handler of `sweepOutbox` (the `outboxSweep` job, spec 0006 R1). The domain declares the command and grants it to
 * `System("outboxSweep")` alone; the handler lives here because delivery needs the transports and `packages/db`'s
 * delivery side. Both the cron tick (every due row) and a command's `waitUntil` (the ids it just enqueued) run it as
 * that principal, through `authorize`, like every other command.
 */
import { Commands, OutboxSweep } from "@vektorprogrammet/domain";
import { Effect } from "effect";

import { deliverOutbox } from "./outboxDelivery";

export const OutboxHandlers = OutboxSweep.OutboxRpc.toLayer({
  sweepOutbox: OutboxSweep.OutboxDomain.handle(OutboxSweep.sweepOutbox, {
    resource: () => Effect.succeed({}),
    run: (options) => deliverOutbox(options),
  }),
});

/** The sweep behind the in-process client; see `Commands.inProcess`. */
export const withOutbox = Commands.inProcess(
  OutboxSweep.OutboxRpc,
  OutboxHandlers
);
