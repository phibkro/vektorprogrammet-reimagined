import {
  Array as Arr,
  Cause,
  Context,
  DateTime,
  Duration,
  Effect,
  Match,
  Predicate,
} from "effect";

import {
  DeliveryFailed,
  MessageSender,
} from "../../../adapters/messaging/senders";
import type { OutboxMessageId } from "../../../core/ids";
import * as OutboxSweep from "../../../core/outbox/declaration";
/** Due-safe, lease-fenced delivery after commit and from the scheduled sweep. */
import { OutboxDelivery } from "../../../core/outbox/delivery";
import type {
  ClaimedOutboxMessage,
  OutboxClaimToken,
} from "../../../core/outbox/delivery";
import { WorkspaceWriter } from "../../../features/workspace/domain/services";
import { AccountDelivery } from "./accountDelivery";

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

  if (Predicate.isTagged(message, "InviteAccount")) {
    return yield* (yield* AccountDelivery).inviteAccount(row, message);
  }

  if (Predicate.isTagged(message, "IssueCode")) {
    return yield* (yield* AccountDelivery).issueCode(row, message);
  }

  if (Predicate.isTagged(message, "DeleteAuthUser")) {
    return yield* (yield* AccountDelivery).deleteAuthUser(row, message);
  }

  if (Predicate.isTagged(message, "RelinkAuthUser")) {
    return yield* (yield* AccountDelivery).relinkAuthUser(row, message);
  }

  yield* Predicate.isTagged(message, "WorkspaceChange")
    ? WorkspaceWriter.use((writer) => writer.apply(message.change))
    : MessageSender.use((sender) => sender.send(message, row.id));

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
  reason: string,
  kind: string
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

  if (ack === "claimLost") {
    return OutboxSweep.DeliveryResult.cases.Settled.make({ id });
  }

  if (
    held.attempts >= OutboxSweep.DeliveryPolicy.attempts &&
    !Arr.some(
      OutboxSweep.DeliveryPolicy.unlimitedKinds,
      (candidate) => candidate === kind
    )
  ) {
    return OutboxSweep.DeliveryResult.cases.Failed.make({ id });
  }

  return OutboxSweep.DeliveryResult.cases.Retrying.make({
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

  return yield* failClaim(row, result.failure.reason, row.message._tag);
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
        failClaim({ ...held, id }, "undecodable payload", held.kind),
    })
  );
});

/** Delivers the rows these ids name, one after the other: each claim is fenced by its token, so the order is only for the log. */
export const deliverOutbox = Effect.fn("deliverOutbox")(function* deliverOutbox(
  ids: readonly OutboxMessageId[]
) {
  return yield* Effect.forEach(ids, deliverOne, { concurrency: 1 });
});
