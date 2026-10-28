/**
 * Delivery of the rows that a queue message names (spec 0008b): claim the row by id, interpret its intent, and fence the
 * acknowledgement by claim token. Who asks is the Queue consumer, or, in a Worker Preview that has no queue, the request's
 * own `waitUntil`; the row is delivered the same way either way, and the claim is the only thing that keeps two asks apart.
 *
 * A failed delivery is not decided here: the row stays pending, its claim is released and its next attempt is dated, and
 * the answer is `Retrying` with the delay. The queue owns how often that happens (`DeliveryPolicy.attempts`), and its
 * dead-letter queue ends the row (`failOutbox`).
 */
import { OutboxDelivery } from "@vektorprogrammet/db";
import type { ClaimedOutboxMessage } from "@vektorprogrammet/db";
import { OutboxSweep, WorkspaceWriter } from "@vektorprogrammet/domain";
import type { OutboxMessageId } from "@vektorprogrammet/domain";
import { Context, DateTime, Duration, Effect, Match, Predicate } from "effect";

import { AccountDelivery } from "./accountDelivery";
import { MessageSender } from "./senders";

/**
 * The delay before the retry that follows the `attempts`-th failed delivery: the policy's (`OutboxSweep.retryDelay`)
 * unless a test says otherwise. A tuning value with a sensible default, so a `Context.Reference`: the test that
 * runs the real queue's retries and dead-letter route in a few seconds gives it a short one.
 */
export const RetryDelay = Context.Reference<
  (attempts: number) => Duration.Duration
>("@vektorprogrammet/web/server/RetryDelay", {
  defaultValue: () => OutboxSweep.retryDelay,
});

/** How long a claim holds a row, and so how long a second delivery of the same id is told to look again later. */
export const LEASE_SECONDS = 120;

/**
 * What a row's `last_error` says when the dead-letter queue ends it and no delivery had left a class there: a class,
 * never a message. A row that failed keeps the class of its last failure, which is the more useful of the two.
 */
const DEAD_LETTER_REASON = "gave up after the declared attempts";

/**
 * Hands one claimed row to whoever owns its kind: the account flows (`IssueCode`, `SetCredential`, their own
 * transaction), the Workspace writer (`WorkspaceChange`) or the message transport (`Email`, `SlackPost`, with the
 * row's id as the key that stays the same however often the row is claimed). Then it records the delivery.
 */
const deliverClaim = Effect.fnUntraced(function* deliverClaim(
  row: ClaimedOutboxMessage
) {
  const delivery = yield* OutboxDelivery;
  const { message } = row;

  if (Predicate.isTagged(message, "IssueCode")) {
    return yield* (yield* AccountDelivery).issueCode(row, message);
  }

  if (Predicate.isTagged(message, "SetCredential")) {
    yield* (yield* AccountDelivery).setCredential(row, message);
  } else if (Predicate.isTagged(message, "WorkspaceChange")) {
    yield* (yield* WorkspaceWriter).apply(message.change);
  } else {
    yield* (yield* MessageSender).send(message, row.id);
  }

  return yield* delivery.markDelivered(row.id, row.claimToken);
});

/** The claimed row, delivered: sent and recorded, or failed with the class of the failure and the policy's delay. */
const deliverClaimed = Effect.fnUntraced(function* deliverClaimed(
  row: ClaimedOutboxMessage
) {
  const { id } = row;
  const delivery = yield* OutboxDelivery;
  const result = yield* Effect.result(deliverClaim(row));

  if (Predicate.isTagged(result, "Success")) {
    return result.success === "recorded"
      ? OutboxSweep.DeliveryResult.cases.Delivered.make({ id })
      : OutboxSweep.DeliveryResult.cases.Settled.make({ id });
  }

  const wait = (yield* RetryDelay)(row.attempts);

  const ack = yield* delivery.markFailed(
    row.id,
    row.claimToken,
    result.failure.reason,
    DateTime.addDuration(yield* DateTime.now, wait)
  );

  yield* Effect.logWarning("outbox delivery failed").pipe(
    Effect.annotateLogs({ attempts: row.attempts, outboxId: row.id })
  );

  return ack === "claimLost"
    ? OutboxSweep.DeliveryResult.cases.Settled.make({ id })
    : OutboxSweep.DeliveryResult.cases.Retrying.make({
        afterSeconds: Math.ceil(Duration.toSeconds(wait)),
        id,
      });
});

const deliverOne = Effect.fnUntraced(function* deliverOne(id: OutboxMessageId) {
  const claim = yield* (yield* OutboxDelivery).claim(id, LEASE_SECONDS);

  return yield* Match.value(claim).pipe(
    Match.tagsExhaustive({
      Claimed: ({ row }) => deliverClaimed(row),
      Held: () =>
        Effect.succeed(
          OutboxSweep.DeliveryResult.cases.Held.make({
            afterSeconds: LEASE_SECONDS,
            id,
          })
        ),
      Settled: () =>
        Effect.succeed(OutboxSweep.DeliveryResult.cases.Settled.make({ id })),
    })
  );
});

/** Delivers the rows these ids name, one after the other: each claim is fenced by its token, so the order is only for the log. */
export const deliverOutbox = Effect.fn("deliverOutbox")(function* deliverOutbox(
  ids: readonly OutboxMessageId[]
) {
  return yield* Effect.forEach(ids, deliverOne, { concurrency: 1 });
});

/** Ends the rows that the dead-letter queue holds: failed, unless they were delivered meanwhile or a live claim holds them. */
export const failOutbox = Effect.fn("failOutbox")(function* failOutbox(
  ids: readonly OutboxMessageId[]
) {
  const delivery = yield* OutboxDelivery;

  return yield* Effect.forEach(
    ids,
    (id) =>
      Effect.map(
        delivery.markDead(id, DEAD_LETTER_REASON),
        (ending): OutboxSweep.EndingResult => {
          if (ending === "failed") {
            return OutboxSweep.EndingResult.cases.Failed.make({ id });
          }

          return ending === "held"
            ? OutboxSweep.EndingResult.cases.Held.make({
                afterSeconds: LEASE_SECONDS,
                id,
              })
            : OutboxSweep.EndingResult.cases.Settled.make({ id });
        }
      ),
    { concurrency: 1 }
  );
});
