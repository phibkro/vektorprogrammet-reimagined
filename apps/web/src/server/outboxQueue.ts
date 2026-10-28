/**
 * The Queue consumer (spec 0008b): what a batch of messages does to the outbox, and what the Worker tells the queue about
 * each message. Two queues, one handler: the outbox queue's messages deliver rows, and the dead-letter queue's messages
 * end the rows that the first queue gave up on (`DEAD_LETTER_SUFFIX` names the second).
 *
 * The delivery is decided as data and applied after: `decisionsOf` turns each message body into `Ack` or `Retry`, and
 * `apply` is the only place that calls the foreign `ack` and `retry`. A message is never left to the implicit ack, and
 * the handler never throws for one message's sake, so one bad message does not return its neighbours to the queue.
 *
 * - A body that is not an outbox id is acknowledged and logged: no retry can make it one.
 * - A row that is delivered, failed, gone or taken over is acknowledged; a duplicate message is the common case.
 * - A row under another live claim is looked at again after the lease; a failed delivery after the policy's retry delay.
 *   Each retry is one of the message's `DeliveryPolicy.attempts` deliveries, and the queue ends it after the last.
 * - A defect (the database is unreachable, say) retries the message with the policy's delay for the message's own
 *   delivery count (`Message.attempts`), so an outage spends the same hours of attempts as a provider's failures
 *   do, and an interruption is not turned into a retry. What the queue gives up on after the last attempt is ended
 *   only if a provider failure was recorded (`markDead`): a row that never reached a provider stays pending, and the
 *   sweep puts it back.
 */
import type { Message } from "@cloudflare/workers-types";
import {
  CurrentPrincipal,
  OutboxSweep,
  systemPrincipal,
} from "@vektorprogrammet/domain";
import {
  Array as Arr,
  Cause,
  Duration,
  Effect,
  Match,
  Option,
  Predicate,
  Schema,
} from "effect";

import { RetryDelay } from "./outboxDelivery";
import { withEnding, withOutbox } from "./outboxSweep";

/** What the consumer tells the queue about one message. */
export const QueueDecisions = Schema.TaggedUnion({
  Ack: {},
  Retry: { afterSeconds: Schema.Int },
});

export type QueueDecision = typeof QueueDecisions.Type;

const ack: QueueDecision = QueueDecisions.cases.Ack.make({});

const retryAfter = (afterSeconds: number): QueueDecision =>
  QueueDecisions.cases.Retry.make({ afterSeconds });

const decodeBody = Schema.decodeUnknownEffect(OutboxSweep.QueueBody);

/**
 * One message's decision: decode the body, ask `act` what became of the row, and let nothing escape except an
 * interruption. A body that does not decode is acknowledged (and logged by what it was, never by what it held).
 */
const decide = <E, R>(
  message: Incoming,
  act: (id: OutboxSweep.QueueBody) => Effect.Effect<QueueDecision, E, R>
) =>
  decodeBody(message.body).pipe(
    Effect.matchEffect({
      onFailure: () =>
        Effect.as(
          Effect.logError("outbox queue message is not an outbox id"),
          ack
        ),
      onSuccess: act,
    }),
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      (cause) =>
        Effect.gen(function* retryDefect() {
          yield* Effect.logError(
            "outbox queue message could not be handled"
          ).pipe(
            Effect.annotateLogs({
              attempts: message.attempts,
              cause: Cause.pretty(cause),
            })
          );

          return retryAfter(
            Math.ceil(Duration.toSeconds((yield* RetryDelay)(message.attempts)))
          );
        })
    )
  );

/** What the queue is told for one row's result: a row that waits on someone or on time is looked at again, any other result ends the message. */
const decisionOf = (
  results: readonly (OutboxSweep.DeliveryResult | OutboxSweep.EndingResult)[]
) =>
  Option.match(Arr.head(results), {
    onNone: () => ack,
    onSome: (result) =>
      Match.value(result).pipe(
        Match.tags({
          Held: ({ afterSeconds }) => retryAfter(afterSeconds),
          Retrying: ({ afterSeconds }) => retryAfter(afterSeconds),
        }),
        Match.orElse(() => ack)
      ),
  });

const deliveryDecision = (id: OutboxSweep.QueueBody) =>
  Effect.map(
    withOutbox((client) => client.deliverOutbox({ ids: [id] })),
    decisionOf
  );

const endingDecision = (id: OutboxSweep.QueueBody) =>
  Effect.map(
    withEnding((client) => client.failOutbox({ ids: [id] })),
    decisionOf
  );

/** The decisions for a batch, in order, as the system principal of the outbox: rows are claimed one at a time. */
const decisionsFor = <E, R>(
  messages: readonly Incoming[],
  act: (id: OutboxSweep.QueueBody) => Effect.Effect<QueueDecision, E, R>
) =>
  Effect.forEach(messages, (message) => decide(message, act), {
    concurrency: 1,
  }).pipe(
    Effect.provideService(CurrentPrincipal, systemPrincipal("outboxSweep"))
  );

/** The decisions for a batch of an outbox queue's messages. */
export const deliveryDecisions = (messages: readonly Incoming[]) =>
  decisionsFor(messages, deliveryDecision);

/** The decisions for a batch of the dead-letter queue's messages. */
export const endingDecisions = (messages: readonly Incoming[]) =>
  decisionsFor(messages, endingDecision);

/** What the consumer needs of a queue message: its body, how often it was delivered, and the two answers it may give. */
export type ConsumedMessage = Pick<
  Message,
  "ack" | "attempts" | "body" | "retry"
>;

/** What a decision reads of a message. */
type Incoming = Pick<ConsumedMessage, "attempts" | "body">;

/** A batch as the consumer needs it: the queue it came from, and its messages. */
export interface OutboxBatch {
  readonly queue: string;
  readonly messages: readonly ConsumedMessage[];
}

/** Tells the queue what became of each message. The only calls of `ack` and `retry`. */
export const apply = (
  messages: readonly ConsumedMessage[],
  decisions: readonly QueueDecision[]
) =>
  Effect.sync(() => {
    for (const [index, message] of messages.entries()) {
      const decision = decisions[index];

      if (decision !== undefined && Predicate.isTagged(decision, "Retry")) {
        message.retry({ delaySeconds: decision.afterSeconds });
      } else {
        message.ack();
      }
    }
  });

/**
 * One batch of the outbox queue: deliver the rows its messages name, then answer each message. A failure inside the
 * program, which the decisions already turn into retries, never reaches here; one that does (the layer could not be
 * built) rejects the handler, and the queue then returns the whole batch.
 */
export const consumeDelivery = Effect.fn("consumeOutboxBatch")(
  function* consumeDelivery(batch: {
    readonly messages: readonly ConsumedMessage[];
  }) {
    yield* apply(batch.messages, yield* deliveryDecisions(batch.messages));
  }
);

/** One batch of the dead-letter queue: end the rows that its messages name, then answer each message. */
export const consumeEnding = Effect.fn("consumeDeadLetterBatch")(
  function* consumeEnding(batch: {
    readonly messages: readonly ConsumedMessage[];
  }) {
    yield* apply(batch.messages, yield* endingDecisions(batch.messages));
  }
);
