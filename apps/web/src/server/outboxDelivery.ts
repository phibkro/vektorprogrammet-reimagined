/** Post-commit delivery: claim due rows, interpret each intent, and fence acknowledgements by claim token. */
import { OutboxDelivery } from "@vektorprogrammet/db";
import type { ClaimedOutboxMessage } from "@vektorprogrammet/db";
import type { OutboxMessageId } from "@vektorprogrammet/domain";
import { DateTime, Duration, Effect, Predicate } from "effect";

import { AccountDelivery } from "./accountDelivery";
import { MessageSender } from "./senders";

export const MAX_ATTEMPTS = 8;
export const BASE_RETRY_DELAY = Duration.minutes(5);
export const MAX_RETRY_DELAY = Duration.hours(12);
export const LEASE_SECONDS = 120;
export const SWEEP_LIMIT = 50;

/** When to retry, or `dead` after the final attempt. */
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

const deliverClaim = Effect.fnUntraced(function* deliverClaim(
  row: ClaimedOutboxMessage
) {
  const delivery = yield* OutboxDelivery;
  const { message } = row;

  if (Predicate.isTagged(message, "IssueCode")) {
    return yield* (yield* AccountDelivery).issueCode(row, message);
  }

  yield* Predicate.isTagged(message, "SetCredential")
    ? (yield* AccountDelivery).setCredential(row, message)
    : (yield* MessageSender).send(message);

  return yield* delivery.markDelivered(row.id, row.claimToken);
});

const deliverOne = Effect.fnUntraced(function* deliverOne(
  row: ClaimedOutboxMessage
) {
  const result = yield* Effect.result(deliverClaim(row));

  if (Predicate.isTagged(result, "Success")) {
    return {
      id: row.id,
      outcome:
        result.success === "recorded"
          ? ("delivered" as const)
          : ("claimLost" as const),
    };
  }

  const next = nextAttemptAfterFailure(row.attempts, yield* DateTime.now);

  const ack = yield* (yield* OutboxDelivery).markFailed(
    row.id,
    row.claimToken,
    result.failure.reason,
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

/** Claim a bounded batch and process it in order; claims are fenced by their token. */
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
