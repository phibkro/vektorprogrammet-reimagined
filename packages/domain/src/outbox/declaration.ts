/**
 * The outbox sweep as data (spec 0006, R1): delivering the messages that commands enqueued is a command of its own,
 * run by the job `outboxSweep` after a commit (`waitUntil`, for the ids that commit enqueued) and on the cron tick
 * (every due row). It is granted to `System("outboxSweep")` alone, so the sweep passes through `authorize` like every
 * other command. The handler lives in `apps/web`: it needs the transports and `packages/db`'s delivery side.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

import {
  Info,
  grant,
  info,
  system,
  make as declareDomain,
} from "../kernel/domain.ts";
import { DomainErrorSchema } from "../shared/errors.ts";
import { OutboxMessageId } from "../shared/ids.ts";

/** What happened to one claimed message: sent, left for a later attempt, given up on, or taken by another sweeper. */
export const DeliveryOutcome = Schema.Literals([
  "delivered",
  "retrying",
  "dead",
  "claimLost",
]);

export type DeliveryOutcome = typeof DeliveryOutcome.Type;

export const sweepOutbox = Rpc.make("sweepOutbox", {
  error: DomainErrorSchema,
  payload: Schema.Struct({
    ids: Schema.optionalKey(Schema.Array(OutboxMessageId)),
    limit: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
  success: Schema.Array(
    Schema.Struct({ id: OutboxMessageId, outcome: DeliveryOutcome })
  ),
}).annotate(
  Info,
  info({
    job: "outboxSweep",
    note: "Claims at most `limit` due rows, or only `ids`; code mail is minted and acknowledged in its delivery transaction (spec 0007 R1).",
    summary: "Deliver due mail, Slack and credential intents.",
  })
);

export const OutboxRpc = RpcGroup.make(sweepOutbox);

export const OutboxDomain = declareDomain({
  commands: OutboxRpc,
  grants: [grant([system("outboxSweep")], ["sweepOutbox"], "all")],
  name: "outbox",
  reads: {},
  title: "Outbox",
});
