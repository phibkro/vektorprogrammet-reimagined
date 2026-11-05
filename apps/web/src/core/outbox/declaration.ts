/** Scheduled and post-commit outbox delivery under the outboxSweep principal. */
import { Duration, Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

import {
  DELETE_AUTH_USER,
  RELINK_AUTH_USER,
} from "../../features/accounts/domain/messages.ts";
import { DomainErrorSchema } from "../errors.ts";
import { OutboxMessageId } from "../ids.ts";
import {
  Info,
  grant,
  info,
  system,
  make as declareDomain,
} from "../kernel/domain.ts";

/** Limits and backoff for durable delivery. */
export const DeliveryPolicy = {
  /** Maximum claims of one message. */
  attempts: 8,
  /** The first retry's delay; each later one doubles it (spec 0008's schedule). */
  retryBase: Duration.minutes(5),
  /** No retry waits longer than this. */
  retryCap: Duration.hours(12),
  /** Provider privacy work remains pending until acknowledged, however many attempts it takes. */
  unlimitedKinds: [DELETE_AUTH_USER, RELINK_AUTH_USER] as const,
} as const;

/** The delay before the retry that follows the `attempts`-th failed delivery of a message: base, doubled each time, capped. A pure function of the declaration. */
export const retryDelay = (attempts: number): Duration.Duration =>
  Duration.min(
    Duration.times(
      DeliveryPolicy.retryBase,
      2 ** Math.min(20, Math.max(0, Math.trunc(attempts) - 1))
    ),
    DeliveryPolicy.retryCap
  );

/**
 * What became of the row that a message names, and what the consumer does next. `Delivered`: sent and recorded (acknowledge).
 * `Retrying`: the delivery failed; the row stays pending and the queue tries again after `afterSeconds`, the policy's
 * retry delay. `Held`: another claim is live; look again after its lease. `Settled`: nothing is left for this message to
 * do (the row is delivered, failed or gone, or another claim took it over: acknowledge).
 */
export const DeliveryResult = Schema.TaggedUnion({
  Delivered: { id: OutboxMessageId },
  Failed: { id: OutboxMessageId },
  Held: { afterSeconds: Schema.Int, id: OutboxMessageId },
  Retrying: { afterSeconds: Schema.Int, id: OutboxMessageId },
  Settled: { id: OutboxMessageId },
});

export type DeliveryResult = typeof DeliveryResult.Type;

export const deliverOutbox = Rpc.make("deliverOutbox", {
  error: DomainErrorSchema,
  payload: Schema.Struct({
    ids: Schema.Array(OutboxMessageId),
  }),
  success: Schema.Array(DeliveryResult),
}).annotate(
  Info,
  info({
    job: "outboxSweep",
    method: ":deliver",
    note: "Claims due rows with fenced leases before delivery.",
    resource: "OutboxMessage",
    summary: "Deliver due outbox messages.",
  })
);

export const sweepOutbox = Rpc.make("sweepOutbox", {
  error: DomainErrorSchema,
  payload: Schema.Struct({
    limit: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
  success: Schema.Struct({ stale: Schema.Array(OutboxMessageId) }),
}).annotate(
  Info,
  info({
    job: "outboxSweep",
    method: ":sweep",
    note: "Finds at most limit due pending rows without a live claim.",
    resource: "OutboxMessage",
    summary: "Find due pending outbox rows.",
  })
);

const OutboxRpc = RpcGroup.make(sweepOutbox, deliverOutbox);

export const OutboxDomain = declareDomain({
  commands: OutboxRpc,
  grants: [
    grant([system("outboxSweep")], ["sweepOutbox", "deliverOutbox"], "all"),
  ],
  name: "outbox",
  reads: {},
  title: "Outbox",
});
