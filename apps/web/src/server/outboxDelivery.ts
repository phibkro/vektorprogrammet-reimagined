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
import type {
  ClaimedOutboxMessage,
  OutboxClaimToken,
} from "@vektorprogrammet/db";
import { OutboxSweep, WorkspaceWriter } from "@vektorprogrammet/domain";
import type { OutboxMessageId } from "@vektorprogrammet/domain";
import {
  Cause,
  Context,
  DateTime,
  Duration,
  Effect,
  Match,
  Predicate,
} from "effect";

import { AccountDelivery } from "./accountDelivery";
import { DeliveryFailed, MessageSender } from "./senders";

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
 * Hands one claimed row to whoever owns its kind: the account flows (`IssueCode`, `SetCredential`, their own
 * transaction), the Workspace writer (`WorkspaceChange`) or the message transport (`Email`, `SlackPost`, with the
 * row's id as the key, which the capture sink keeps a message once by; the production senders pass it to no provider, so a send
 * that succeeded before `markDelivered` committed is sent again: at least once). Then it records the delivery.
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

/** What delivery needs: the database, the transports, the account flows and the Workspace writer. */
export type DeliveryServices =
  | OutboxDelivery
  | AccountDelivery
  | MessageSender
  | WorkspaceWriter;

/** A claim that is held: enough to hand it back. */
interface HeldClaim {
  readonly attempts: number;
  readonly claimToken: OutboxClaimToken;
  readonly id: OutboxMessageId;
}

/**
 * Hands a held claim back as a failure: the class of the failure (never a message) goes on the row, the next attempt is
 * dated by the policy's delay for the row's attempts, and the answer is `Retrying`. A row that has failed this way
 * after every claim can end: the dead-letter ending needs a recorded failure.
 */
const failClaim = Effect.fnUntraced(function* failClaim(
  held: HeldClaim,
  reason: string
) {
  const { id } = held;
  const wait = (yield* RetryDelay)(held.attempts);

  const ack = yield* (yield* OutboxDelivery).markFailed(
    id,
    held.claimToken,
    reason,
    DateTime.addDuration(yield* DateTime.now, wait)
  );

  yield* Effect.logWarning("outbox delivery failed").pipe(
    Effect.annotateLogs({ attempts: held.attempts, outboxId: id, reason })
  );

  return ack === "claimLost"
    ? OutboxSweep.DeliveryResult.cases.Settled.make({ id })
    : OutboxSweep.DeliveryResult.cases.Retrying.make({
        afterSeconds: Math.ceil(Duration.toSeconds(wait)),
        id,
      });
});

/**
 * The class of a defect, for a log: its tag, or "defect". Never its text: a decode error prints the values it refused,
 * which are addresses.
 */
export const defectClass = (cause: Cause.Cause<unknown>): string => {
  const defect = Cause.squash(cause);

  return Predicate.hasProperty(defect, "_tag") ? String(defect._tag) : "defect";
};

/**
 * The claimed row, delivered: sent and recorded, or failed with a class and the policy's delay. A defect after a
 * successful claim (a handler or a sender that dies) is a failure of this row, not an outage: the claim proves the
 * database is reachable, so it is recorded as \`delivery defect\` and the row can end after the declared attempts. A
 * defect of the claim itself records nothing: that is an outage, and the row stays pending.
 */
const deliverClaimed = Effect.fnUntraced(function* deliverClaimed(
  row: ClaimedOutboxMessage
) {
  const { id } = row;

  const result = yield* Effect.result(
    deliverClaim(row).pipe(
      Effect.catchDefect((defect) =>
        Effect.andThen(
          Effect.logError("outbox delivery died").pipe(
            Effect.annotateLogs({
              class: defectClass(Cause.die(defect)),
              outboxId: id,
            })
          ),
          Effect.fail(new DeliveryFailed({ reason: "delivery defect" }))
        )
      )
    )
  );

  if (Predicate.isTagged(result, "Success")) {
    return result.success === "recorded"
      ? OutboxSweep.DeliveryResult.cases.Delivered.make({ id })
      : OutboxSweep.DeliveryResult.cases.Settled.make({ id });
  }

  return yield* failClaim(row, result.failure.reason);
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
      Undeliverable: (held) =>
        failClaim({ ...held, id }, "undecodable payload"),
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
      Effect.map(delivery.markDead(id), (ending): OutboxSweep.EndingResult => {
        if (ending === "failed") {
          return OutboxSweep.EndingResult.cases.Failed.make({ id });
        }

        return ending === "held"
          ? OutboxSweep.EndingResult.cases.Held.make({
              afterSeconds: LEASE_SECONDS,
              id,
            })
          : OutboxSweep.EndingResult.cases.Settled.make({ id });
      }),
    { concurrency: 1 }
  );
});
