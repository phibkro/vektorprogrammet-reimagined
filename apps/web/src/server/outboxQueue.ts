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
 * - A defect (the database is unreachable, say) retries the message after the first retry delay, and an interruption
 *   is not turned into a retry.
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

import { withOutbox } from "./outboxSweep";

/** What the consumer tells the queue about one message. */
export const QueueDecisions = Schema.TaggedUnion({
  Ack: {},
  Retry: { afterSeconds: Schema.Int },
});

export type QueueDecision = typeof QueueDecisions.Type;

const ack: QueueDecision = QueueDecisions.cases.Ack.make({});

const retryAfter = (afterSeconds: number): QueueDecision =>
  QueueDecisions.cases.Retry.make({ afterSeconds });

/** The delay of a retry that has no better estimate: the first one of the policy. */
const FIRST_RETRY_SECONDS = Math.ceil(
  Duration.toSeconds(OutboxSweep.retryDelay(1))
);

const decodeBody = Schema.decodeUnknownEffect(OutboxSweep.QueueBody);

/**
 * One message's decision: decode the body, ask `act` what became of the row, and let nothing escape except an
 * interruption. A body that does not decode is acknowledged (and logged by what it was, never by what it held).
 */
const decide = <E, R>(
  decoded: Effect.Effect<OutboxSweep.QueueBody, Schema.SchemaError>,
  act: (id: OutboxSweep.QueueBody) => Effect.Effect<QueueDecision, E, R>
) =>
  decoded.pipe(
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
        Effect.as(
          Effect.logError("outbox queue message could not be handled").pipe(
            Effect.annotateLogs({ cause: Cause.pretty(cause) })
          ),
          retryAfter(FIRST_RETRY_SECONDS)
        )
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
    withOutbox((client) => client.failOutbox({ ids: [id] })),
    decisionOf
  );

/** The decisions for a batch, in order, as the system principal of the outbox: rows are claimed one at a time. */
const decisionsFor = <E, R>(
  bodies: readonly unknown[],
  act: (id: OutboxSweep.QueueBody) => Effect.Effect<QueueDecision, E, R>
) =>
  Effect.forEach(bodies, (body) => decide(decodeBody(body), act), {
    concurrency: 1,
  }).pipe(
    Effect.provideService(CurrentPrincipal, systemPrincipal("outboxSweep"))
  );

/** The decisions for a batch of an outbox queue's messages. */
export const deliveryDecisions = (bodies: readonly unknown[]) =>
  decisionsFor(bodies, deliveryDecision);

/** The decisions for a batch of the dead-letter queue's messages. */
export const endingDecisions = (bodies: readonly unknown[]) =>
  decisionsFor(bodies, endingDecision);

/** What the consumer needs of a queue message: its body, and the two answers it may give. */
export type ConsumedMessage = Pick<Message, "ack" | "body" | "retry">;

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
 * One batch. `dead` says it came from the dead-letter queue. A failure inside the program, which the decisions
 * already turn into retries, never reaches here; one that does (the layer could not be built) rejects the handler, and
 * the queue then returns the whole batch.
 */
export const consumeBatch = Effect.fn("consumeOutboxBatch")(
  function* consumeBatch(
    batch: { readonly messages: readonly ConsumedMessage[] },
    dead: boolean
  ) {
    const bodies = Arr.map(batch.messages, (message) => message.body);

    const decisions = yield* dead
      ? endingDecisions(bodies)
      : deliveryDecisions(bodies);

    yield* apply(batch.messages, decisions);
  }
);
