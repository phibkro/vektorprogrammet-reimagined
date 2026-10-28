/**
 * A recording stand-in for the Queue binding, and the queue's protocol as far as a test of the consumer needs it
 * (spec 0008b). It is a simulation, not Cloudflare: it records every body that was sent, delivers each message in a batch
 * with its attempt number, and moves a message to the dead-letter list after its last delivery. Its rules are the ones
 * that the Miniflare test (`outboxQueue.worker.test.ts`) observes in the real runtime: `max_retries` retries mean
 * `max_retries + 1` deliveries, then the dead-letter queue.
 */
import type { Queue } from "@cloudflare/workers-types";
import { Array as Arr, Effect } from "effect";

interface Waiting {
  readonly body: string;
  readonly attempts: number;
}

/** What a consumer answered about one message: acknowledged, to be retried after some seconds, or not yet answered. */
type DeliveryAnswer = "ack" | { readonly retryAfter: number } | undefined;

/** What `drain` gives to a consumer: a batch of messages that it answers with `ack` or `retry`. */
interface Delivery {
  readonly attempts: number;
  readonly body: unknown;
  readonly answer: () => DeliveryAnswer;
  readonly ack: () => void;
  readonly retry: (options?: { readonly delaySeconds?: number }) => void;
}

export interface FakeQueue {
  /** The binding that a Worker is given (`env.OUTBOX_QUEUE`). */
  readonly binding: Queue<string>;
  /** Every body that was ever sent, in order: what a scan of the queue's traffic reads. */
  readonly sent: string[];
  /** Messages that wait for delivery now. */
  readonly waiting: () => readonly string[];
  /** The dead-letter list: what the queue gave up on. */
  readonly deadLetters: readonly string[];
  /**
   * Delivers everything that waits, once per round, until nothing waits or a round limit is reached. The
   * consumer is called with each batch and whether it comes from the dead-letter queue.
   */
  readonly drain: <E, R>(
    consume: (
      batch: { readonly messages: readonly Delivery[] },
      dead: boolean
    ) => Effect.Effect<void, E, R>,
    options?: { readonly maxRetries?: number; readonly rounds?: number }
  ) => Effect.Effect<void, E, R>;
}

export const fakeQueue = (): FakeQueue => {
  const sent: string[] = [];
  let waiting: Waiting[] = [];
  const deadLetters: string[] = [];

  const metrics = () => ({ backlogBytes: 0, backlogCount: waiting.length });

  const enqueue = (body: string) => {
    sent.push(body);
    waiting.push({ attempts: 1, body });
  };

  const binding: Queue<string> = {
    metrics: () => Promise.resolve(metrics()),
    send: (message) => {
      enqueue(message);

      return Promise.resolve({ metadata: { metrics: metrics() } });
    },
    sendBatch: (messages) => {
      for (const message of messages) {
        enqueue(message.body);
      }

      return Promise.resolve({ metadata: { metrics: metrics() } });
    },
  };

  const deliveryOf = (message: Waiting): Delivery => {
    let answer: DeliveryAnswer;

    return {
      ack: () => {
        answer = "ack";
      },
      answer: () => answer,
      attempts: message.attempts,
      body: message.body,
      retry: (options) => {
        answer = { retryAfter: options?.delaySeconds ?? 0 };
      },
    };
  };

  /** What becomes of a delivered message: gone if acknowledged, waiting again with one more attempt, or dead after the last. */
  const settle = (message: Waiting, delivery: Delivery, maxRetries: number) => {
    if (delivery.answer() === "ack") {
      return;
    }

    if (message.attempts > maxRetries) {
      deadLetters.push(message.body);

      return;
    }

    waiting.push({ attempts: message.attempts + 1, body: message.body });
  };

  const drain: FakeQueue["drain"] = (consume, options) =>
    Effect.gen(function* drainRounds() {
      const maxRetries = options?.maxRetries ?? 7;
      const rounds = options?.rounds ?? 50;

      for (let round = 0; round < rounds && waiting.length > 0; round += 1) {
        const batch = waiting;
        waiting = [];

        const deliveries = Arr.map(batch, deliveryOf);
        yield* consume({ messages: deliveries }, false);

        for (const [index, delivery] of deliveries.entries()) {
          settle(
            batch[index] ?? { attempts: 1, body: "" },
            delivery,
            maxRetries
          );
        }
      }

      const dead = Arr.map(deadLetters, (body) =>
        deliveryOf({ attempts: 1, body })
      );

      if (dead.length > 0) {
        yield* consume({ messages: dead }, true);
      }
    });

  return {
    binding,
    deadLetters,
    drain,
    sent,
    waiting: () => Arr.map(waiting, (message) => message.body),
  };
};
