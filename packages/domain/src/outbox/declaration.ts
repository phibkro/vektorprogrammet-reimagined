/**
 * What the outbox's system actor does (spec 0006 R1, spec 0008b): delivering the messages that commands enqueued is a
 * command of its own, and so are the other things that actor does to rows. All four run as `System("outboxSweep")`
 * alone, through `authorize`, like every other command, and the handlers live in `apps/web`: they need the transports and
 * `packages/db`'s delivery side.
 *
 * - `deliverOutbox`: the Queue consumer (and the Worker Preview's direct path, which has no queue) delivers the rows that
 *   a message names, by id.
 * - `failOutbox`: the dead-letter queue's consumer marks a row failed (`dead`) once the queue has given up on it, if a
 *   delivery failure was recorded on it.
 * - `recordOutboxFailure`: the consumer records that it could not even build its delivery stack, so the rows can end.
 * - `sweepOutbox`: the cron job finds the rows that no receipt covers any more and puts their ids back on the queue. It
 *   delivers nothing, and the command only finds them: the queue is infrastructure, not a domain write.
 */
import { Duration, Schema } from "effect";
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

/**
 * The delivery policy, one declaration each (spec 0008b, proposed by the slice and the operator's to change). The
 * Queue consumer's `max_retries` is `attempts − 1`, because Cloudflare delivers a message `max_retries + 1` times
 * (`apps/web/worker.config.ts`).
 */
export const DeliveryPolicy = {
  /** Deliveries of one message before the queue gives up and the dead-letter queue marks the row failed. */
  attempts: 8,
  /**
   * How long a pending row may go without a receipt before the sweep puts its id on the queue again. The sweep runs on
   * the ten-minute tick, so a row that a crash between commit and enqueue left without a message is delivered at most
   * `requeueAfter` plus one tick later (about 20 minutes, with the queue's own latency), not within the threshold.
   */
  requeueAfter: Duration.minutes(10),
  /** The first retry's delay; each later one doubles it (spec 0008's schedule). */
  retryBase: Duration.minutes(5),
  /** No retry waits longer than this. */
  retryCap: Duration.hours(12),
} as const;

/** The delay before the retry that follows the `attempts`-th failed delivery of a message: base, doubled each time, capped. A pure function of the declaration. */
export const retryDelay = (attempts: number): Duration.Duration =>
  Duration.min(
    Duration.times(
      DeliveryPolicy.retryBase,
      2 ** Math.max(0, Math.trunc(attempts) - 1)
    ),
    DeliveryPolicy.retryCap
  );

/**
 * What a queue message holds: the id of an outbox row and nothing else (spec 0008b). The id of an identity integer, so a
 * body that is not one is refused, and a scan of the queue finds nothing about a person.
 */
export const QueueBody = OutboxMessageId.check(
  Schema.isPattern(/^[1-9][0-9]{0,9}$/u, { expected: "an outbox row id" })
);

export type QueueBody = typeof QueueBody.Type;

/**
 * What became of the row that a message names, and what the consumer does next. `Delivered`: sent and recorded (acknowledge).
 * `Retrying`: the delivery failed; the row stays pending and the queue tries again after `afterSeconds`, the policy's
 * retry delay. `Held`: another claim is live; look again after its lease. `Settled`: nothing is left for this message to
 * do (the row is delivered, failed or gone, or another claim took it over: acknowledge).
 */
export const DeliveryResult = Schema.TaggedUnion({
  Delivered: { id: OutboxMessageId },
  Held: { afterSeconds: Schema.Int, id: OutboxMessageId },
  Retrying: { afterSeconds: Schema.Int, id: OutboxMessageId },
  Settled: { id: OutboxMessageId },
});

export type DeliveryResult = typeof DeliveryResult.Type;

/** What the dead-letter queue's consumer found: the row is now failed (`dead`); a live claim holds it; or nothing is left to do. */
export const EndingResult = Schema.TaggedUnion({
  Failed: { id: OutboxMessageId },
  Held: { afterSeconds: Schema.Int, id: OutboxMessageId },
  Settled: { id: OutboxMessageId },
});

export type EndingResult = typeof EndingResult.Type;

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
    note: "Claims the rows the queue message names, each only while it is pending and no live claim holds it; code mail is minted and acknowledged in its delivery transaction (spec 0007 R1).",
    resource: "OutboxMessage",
    summary:
      "Deliver the mail, Slack and credential intents that a queue message names.",
  })
);

export const failOutbox = Rpc.make("failOutbox", {
  error: DomainErrorSchema,
  payload: Schema.Struct({
    ids: Schema.Array(OutboxMessageId),
  }),
  success: Schema.Array(EndingResult),
}).annotate(
  Info,
  info({
    job: "outboxSweep",
    method: ":fail",
    note: "The dead-letter queue's consumer: a row becomes `dead` only when it is pending, unclaimed and a delivery failure was recorded on it (`last_error`); a row that never failed stays pending for the sweep, and a delivered one is left alone.",
    resource: "OutboxMessage",
    summary: "Mark the rows that the queue gave up on as failed.",
  })
);

/** The classes of failure that the consumer records on a row without having tried a provider. A class, never a message. */
export const RecordedFailure = Schema.Literals(["delivery stack unavailable"]);

export type RecordedFailure = typeof RecordedFailure.Type;

export const recordOutboxFailure = Rpc.make("recordOutboxFailure", {
  error: DomainErrorSchema,
  payload: Schema.Struct({
    failure: RecordedFailure,
    messages: Schema.Array(
      Schema.Struct({ attempts: Schema.Int, id: OutboxMessageId })
    ),
  }),
  success: Schema.Array(OutboxMessageId),
}).annotate(
  Info,
  info({
    job: "outboxSweep",
    method: ":record",
    note: "The consumer could not build its delivery stack (a sender or auth binding is missing or refused): it records the class of that failure on the rows its messages name, each only while pending and unclaimed, and dates the next attempt by `DeliveryPolicy.retryDelay` for the message's delivery count. The dead-letter queue's consumer can then end them. It reads and writes nothing else, and no provider was tried.",
    resource: "OutboxMessage",
    summary:
      "Record that a delivery could not start on the rows that the queue messages name.",
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
    note: "Names at most `limit` pending rows without a fresh receipt (older than `DeliveryPolicy.requeueAfter`) and no live claim: the job puts their ids on the queue again. It changes and delivers nothing: the queue's consumer delivers.",
    resource: "OutboxMessage",
    summary:
      "Find the pending outbox rows that no queue message covers any more.",
  })
);

export const OutboxRpc = RpcGroup.make(
  sweepOutbox,
  deliverOutbox,
  failOutbox,
  recordOutboxFailure
);

export const OutboxDomain = declareDomain({
  commands: OutboxRpc,
  grants: [
    grant(
      [system("outboxSweep")],
      ["sweepOutbox", "deliverOutbox", "failOutbox", "recordOutboxFailure"],
      "all"
    ),
  ],
  name: "outbox",
  reads: {},
  title: "Outbox",
});
