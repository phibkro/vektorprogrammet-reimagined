/**
 * Outbox delivery (architecture §4): after a command commits, `waitUntil`
 * delivers the ids it enqueued; the cron sweep (`scheduled`) delivers every
 * due row. Both claim rows through `OutboxDelivery` (`FOR UPDATE SKIP LOCKED`,
 * claim token), send OUTSIDE any transaction, then mark the row delivered or
 * failed with exponential backoff, and dead after `MAX_ATTEMPTS`.
 */
import { OutboxDelivery } from "@vektorprogrammet/db";
import type { ClaimedOutboxMessage } from "@vektorprogrammet/db";
import type { OutboxMessageId } from "@vektorprogrammet/domain";
import { DateTime, Duration, Effect, Predicate } from "effect";

import { MessageSender } from "./senders";

/** Attempts (including the first) before a row is marked dead. */
export const MAX_ATTEMPTS = 8;

/** Delay after the first failure; doubles per attempt. */
export const BASE_RETRY_DELAY = Duration.minutes(5);

/** Upper bound on one retry delay. */
export const MAX_RETRY_DELAY = Duration.hours(12);

/** How long a claim is held before another sweeper may take the row. */
export const LEASE_SECONDS = 120;

/** Rows one sweep handles; low volume, so one batch per cron tick. */
export const SWEEP_LIMIT = 50;

/**
 * When to try again after the `attempts`-th failed attempt, or `"dead"`.
 * attempts 1 → +5 min, 2 → +10 min, 3 → +20 min, … capped at 12 h.
 */
export const nextAttemptAfterFailure = (
  attempts: number,
  failedAt: DateTime.Utc
): DateTime.Utc | "dead" => {
  if (attempts >= MAX_ATTEMPTS) {
    return "dead";
  }

  const delay = Duration.min(
    Duration.times(BASE_RETRY_DELAY, 2 ** Math.max(0, attempts - 1)),
    MAX_RETRY_DELAY
  );

  return DateTime.addDuration(failedAt, delay);
};

const deliverOne = Effect.fnUntraced(function* deliverOne(
  row: ClaimedOutboxMessage
) {
  const delivery = yield* OutboxDelivery;
  const sender = yield* MessageSender;
  const sent = yield* Effect.result(sender.send(row.message));

  if (Predicate.isTagged(sent, "Success")) {
    const ack = yield* delivery.markDelivered(row.id, row.claimToken);

    return {
      id: row.id,
      outcome:
        ack === "recorded" ? ("delivered" as const) : ("claimLost" as const),
    };
  }

  const next = nextAttemptAfterFailure(row.attempts, yield* DateTime.now);

  const ack = yield* delivery.markFailed(
    row.id,
    row.claimToken,
    sent.failure.reason,
    next
  );

  yield* Effect.logWarning("outbox delivery failed").pipe(
    Effect.annotateLogs({
      attempts: row.attempts,
      dead: next === "dead",
      outboxId: row.id,
    })
  );

  if (ack === "claimLost") {
    return { id: row.id, outcome: "claimLost" as const };
  }

  return {
    id: row.id,
    outcome: next === "dead" ? ("dead" as const) : ("retrying" as const),
  };
});

/**
 * Claims due rows (optionally only `ids`) and delivers them one at a time.
 * Never runs inside a transaction: each claim and mark is its own statement.
 */
export const deliverOutbox = Effect.fn("deliverOutbox")(
  function* deliverOutbox(options: {
    readonly ids?: readonly OutboxMessageId[];
    readonly limit: number;
  }) {
    const delivery = yield* OutboxDelivery;

    const claimed = yield* delivery.claimDue({
      ids: options.ids,
      leaseSeconds: LEASE_SECONDS,
      limit: options.limit,
    });

    return yield* Effect.forEach(claimed, deliverOne, { concurrency: 1 });
  }
);
