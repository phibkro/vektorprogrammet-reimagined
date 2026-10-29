/**
 * The delivery side of the transactional outbox: at-least-once, claims fenced by a per-row claim token. What reaches it
 * is a row id, from a Cloudflare Queue message or, in a Worker Preview that has no queue, straight from the request
 * (spec 0008b).
 *
 * Delivery contract (FX009):
 * - Ordering: none. Queues delivers at least once and in no order, and no message
 *   kind needs one (spec 0008b).
 * - Claims (LS1): `claim` takes one row by id in one conditional write (the row is pending and no live claim holds
 *   it), so two deliveries of one id never both hold it; a claim expires after `leaseSeconds`. The other delivery is
 *   told why: `Held` (a live claim: look again after its lease) or `Settled` (the row is delivered, failed or gone:
 *   nothing to do).
 * - Fencing (LS2): `markDelivered`/`markFailed`, and `holdClaim` for a write that is not the acknowledgement, change
 *   a row, or allow the caller's write, only while its claim token is current; otherwise they
 *   report `claimLost` and write nothing. `markDelivered` joins the caller's transaction when there is one (LS4): the
 *   acknowledgement then commits or rolls back with the caller's writes, and it commits alone otherwise.
 * - Attempts and dead letters: `attempts` counts claims, for the record. The
 *   queue owns the retry schedule and the number of attempts; a failed
 *   delivery releases the claim and says when the next one is due
 *   (`markFailed`), and the dead-letter queue's consumer ends a row that the
 *   queue gave up on (`markDead`, which takes only a row on which a provider
 *   failure was recorded, and never one under a live claim).
 * - Receipts: `markQueued` records that the queue accepted the id; `stale` lists the pending rows that no receipt
 *   covers any more, which the cron sweep puts back on the queue.
 * - Every timestamp comes from Effect's `Clock`.
 */
import { Context, Schema } from "effect";
import type { DateTime, Effect } from "effect";

import { OutboxMessageId } from "../shared/ids.ts";
import type { InTransaction } from "../shared/transaction.ts";
import { OutboxMessage } from "./messages.ts";

/** Proof of a current claim on one outbox row. */
export const OutboxClaimToken = Schema.String.pipe(
  Schema.brand("OutboxClaimToken")
);

export type OutboxClaimToken = typeof OutboxClaimToken.Type;

/** A claimed, due outbox row. */
export const ClaimedOutboxMessage = Schema.Struct({
  /** Claims so far, including this one. */
  attempts: Schema.Int,
  claimToken: OutboxClaimToken,
  createdAt: Schema.DateTimeUtc,
  id: OutboxMessageId,
  message: OutboxMessage,
});

export type ClaimedOutboxMessage = typeof ClaimedOutboxMessage.Type;

/** `recorded`: the row changed. `claimLost`: the token is no longer current; nothing was written. */
export type OutboxAck = "recorded" | "claimLost";

/**
 * What a claim on one row found: the row, claimed (`Claimed`); the row, claimed, but its payload does not decode, so only
 * the claim is handed back (`Undeliverable`); another claim that is still live (`Held`); or a row that is not pending
 * any more or does not exist (`Settled`).
 */
export const OutboxClaim = Schema.TaggedUnion({
  Claimed: { row: ClaimedOutboxMessage },
  Held: {},
  Settled: {},
  Undeliverable: { attempts: Schema.Int, claimToken: OutboxClaimToken },
});

export type OutboxClaim = typeof OutboxClaim.Type;

/** What the dead-letter queue's consumer found: the row is now `dead`; a live claim holds it; or it is not pending. */
export type OutboxEnding = "failed" | "held" | "settled";

export class OutboxDelivery extends Context.Service<
  OutboxDelivery,
  {
    /**
     * Claims the row `id` for `leaseSeconds` if it is pending and no live claim holds it. Whether it is due is not asked:
     * the queue schedules retries. A duplicate message that comes early is harmless because the claim needs `pending`
     * and no live claim: it finds the row delivered (`Settled`) or under the first delivery's claim (`Held`), so it
     * is an earlier retry, never a second send. A provider can still hear of a row twice when its send succeeded and
     * `markDelivered` did not commit (at least once); the row's id is only a key for providers that use one, and
     * the production senders pass none.
     */
    readonly claim: (
      id: OutboxMessageId,
      leaseSeconds: number
    ) => Effect.Effect<OutboxClaim>;
    /**
     * The fence of a write that is not the acknowledgement itself (spec 0024 R9): `recorded` while `claimToken` is the
     * row's current claim and the row is pending, and then a lock on the row that lasts to the end of the caller's
     * transaction, so another consumer's claim of it waits; `claimLost` otherwise, and the caller writes nothing. It
     * takes the lock after the caller's aggregate lock (the order of `markDelivered` in the second transaction), never
     * before it.
     */
    readonly holdClaim: (
      id: OutboxMessageId,
      claimToken: OutboxClaimToken
    ) => Effect.Effect<OutboxAck, never, InTransaction>;
    readonly markDelivered: (
      id: OutboxMessageId,
      claimToken: OutboxClaimToken
    ) => Effect.Effect<OutboxAck>;
    /** Releases the claim after a failed delivery: the row stays pending and its next attempt is due at `next`. */
    readonly markFailed: (
      id: OutboxMessageId,
      claimToken: OutboxClaimToken,
      error: string,
      next: DateTime.Utc
    ) => Effect.Effect<OutboxAck>;
    /**
     * The queue gave up on the row: `dead`, but only when a provider failure was recorded (`last_error` is set) and the
     * row is still pending with no live claim. A row that never reached a provider (the queue's attempts went on an
     * outage of the database, say) is `settled`, stays pending and is put back on the queue by the sweep. A live claim
     * answers `held`; a delivered or dead row, `settled`.
     */
    readonly markDead: (id: OutboxMessageId) => Effect.Effect<OutboxEnding>;
    /**
     * Records a delivery failure that no provider produced (the consumer could not start): `error` is a class, and the next
     * attempt is due at `next`. Only a pending row with no live claim is written; any other is `settled`. This is what
     * lets the dead-letter ending take the row.
     */
    readonly recordFailure: (
      id: OutboxMessageId,
      error: string,
      next: DateTime.Utc
    ) => Effect.Effect<"recorded" | "settled">;
    /** The receipt of the queue: it accepted these ids now. Rows that are not pending are left as they are. */
    readonly markQueued: (
      ids: readonly OutboxMessageId[]
    ) => Effect.Effect<void>;
    /**
     * Up to `limit` pending rows with no live claim whose last receipt, or next attempt if that is later, is not after
     * `before`: the ones that a crash between commit and enqueue, or a lost message, left without a message.
     */
    readonly stale: (options: {
      readonly before: DateTime.Utc;
      readonly limit: number;
    }) => Effect.Effect<readonly OutboxMessageId[]>;
  }
>()("@vektorprogrammet/domain/outbox/OutboxDelivery") {}
