/** Due-aware at-least-once delivery with bounded attempts and fenced leases. */
import { Context, Schema } from "effect";
import type { DateTime, Effect } from "effect";

import { OutboxMessageId } from "../shared/ids.ts";
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
  Undeliverable: {
    attempts: Schema.Int,
    claimToken: OutboxClaimToken,
    kind: Schema.String,
  },
});

export type OutboxClaim = typeof OutboxClaim.Type;

export class OutboxDelivery extends Context.Service<
  OutboxDelivery,
  {
    /** Claims only pending, due rows with no live lease. */
    readonly claim: (
      id: OutboxMessageId,
      leaseSeconds: number
    ) => Effect.Effect<OutboxClaim>;
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
    /** Finds at most limit due pending rows with no live lease. */
    readonly due: (options: {
      readonly limit: number;
    }) => Effect.Effect<readonly OutboxMessageId[]>;
  }
>()("@vektorprogrammet/domain/outbox/OutboxDelivery") {}
