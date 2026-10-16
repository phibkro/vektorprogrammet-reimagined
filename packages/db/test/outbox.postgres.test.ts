/**
 * `OutboxDelivery` on real PostgreSQL: concurrent claimers never receive the
 * same row (`FOR UPDATE SKIP LOCKED`), leases expire, claim tokens fence
 * late acknowledgements, and failed rows return at their next attempt time.
 * Time is Effect's `TestClock`.
 */
import { assert, layer } from "@effect/vitest";
import { Outbox, OutboxMessage, SlackTarget } from "@vektorprogrammet/domain";
import { Array as Arr, DateTime, Effect, Option, Order, pipe } from "effect";
import { TestClock } from "effect/testing";

import { OutboxDelivery } from "../src/index.ts";
import { postgresDatabase } from "./support/database.ts";
import { AT } from "./support/fixtures.ts";

const slack = (text: string): OutboxMessage =>
  OutboxMessage.cases.SlackPost.make({
    target: SlackTarget.cases.Notifications.make({}),
    text,
  });

const services = Effect.gen(function* services() {
  yield* TestClock.setTime(DateTime.toEpochMillis(AT));

  return { delivery: yield* OutboxDelivery, outbox: yield* Outbox };
});

layer(postgresDatabase(), { excludeTestServices: true })(
  "outbox delivery on PostgreSQL",
  (it) => {
    it.layer(TestClock.layer())((layerTest) => {
      layerTest.effect("concurrent claimers never receive the same row", () =>
        Effect.gen(function* effectProgram() {
          const { outbox, delivery } = yield* services;

          const ids = yield* outbox.enqueue(
            Arr.makeBy(40, (i) => slack(`melding ${i}`))
          );

          const batches = yield* Effect.all(
            Arr.makeBy(8, () =>
              delivery.claimDue({ ids, leaseSeconds: 60, limit: 5 })
            ),
            { concurrency: "unbounded" }
          );

          const claimed = pipe(
            batches.flat(),
            Arr.map((row) => row.id)
          );

          assert.strictEqual(
            new Set(claimed).size,
            claimed.length,
            "a row was claimed twice"
          );
          assert.isTrue(
            pipe(
              batches.flat(),
              Arr.every((row) => row.attempts === 1)
            )
          );

          // Whatever a racing claimer skipped is still claimable once, by a later claim.
          const rest = pipe(
            yield* delivery.claimDue({
              ids,
              leaseSeconds: 60,
              limit: 40,
            }),
            Arr.map((row) => row.id)
          );

          assert.deepStrictEqual(
            pipe(
              [...claimed, ...rest],
              Arr.sortBy<readonly string[]>(Order.String)
            ),
            pipe([...ids], Arr.sortBy<readonly string[]>(Order.String))
          );
        })
      );

      layerTest.effect(
        "an expired lease can be re-claimed; the stale token is fenced out",
        () =>
          Effect.gen(function* effectProgram() {
            const { outbox, delivery } = yield* services;
            const ids = yield* outbox.enqueue([slack("lease")]);

            const [first] = yield* delivery.claimDue({
              ids,
              leaseSeconds: 30,
              limit: 1,
            });

            if (first === undefined) {
              assert.fail("expected a claim");
            }

            // Within the lease nobody else gets it.
            assert.deepStrictEqual(
              yield* delivery.claimDue({ ids, leaseSeconds: 30, limit: 1 }),
              []
            );

            yield* TestClock.adjust("31 seconds");

            const [second] = yield* delivery.claimDue({
              ids,
              leaseSeconds: 30,
              limit: 1,
            });

            if (second === undefined) {
              assert.fail("expected a re-claim after the lease");
            }

            assert.strictEqual(second.id, first.id);
            assert.strictEqual(second.attempts, 2);
            assert.notStrictEqual(second.claimToken, first.claimToken);

            assert.strictEqual(
              yield* delivery.markDelivered(first.id, first.claimToken),
              "claimLost"
            );
            assert.strictEqual(
              yield* delivery.markFailed(
                first.id,
                first.claimToken,
                "late",
                "dead"
              ),
              "claimLost"
            );
            assert.strictEqual(
              yield* delivery.markDelivered(second.id, second.claimToken),
              "recorded"
            );
            yield* TestClock.adjust("1 hour");
            assert.deepStrictEqual(
              yield* delivery.claimDue({ ids, leaseSeconds: 30, limit: 1 }),
              []
            );
          })
      );

      layerTest.effect(
        "a failed row is due again at its next attempt time; a dead row never",
        () =>
          Effect.gen(function* effectProgram() {
            const { outbox, delivery } = yield* services;

            const [retryId, deadId] = yield* outbox.enqueue([
              slack("retry"),
              slack("dead"),
            ]);

            if (retryId === undefined || deadId === undefined) {
              assert.fail("expected two ids");
            }

            const ids = [retryId, deadId];

            const claims = yield* delivery.claimDue({
              ids,
              leaseSeconds: 30,
              limit: 2,
            });

            const retry = Option.getOrNull(
              Arr.findFirst(claims, (row) => row.id === retryId)
            );

            const dead = Option.getOrNull(
              Arr.findFirst(claims, (row) => row.id === deadId)
            );

            if (retry === null || dead === null) {
              assert.fail("expected both claimed");
            }

            const next = DateTime.add(AT, { minutes: 5 });
            assert.strictEqual(
              yield* delivery.markFailed(
                retry.id,
                retry.claimToken,
                "timeout",
                next
              ),
              "recorded"
            );
            assert.strictEqual(
              yield* delivery.markFailed(
                dead.id,
                dead.claimToken,
                "rejected",
                "dead"
              ),
              "recorded"
            );
            assert.deepStrictEqual(
              yield* delivery.claimDue({ ids, leaseSeconds: 30, limit: 2 }),
              []
            );
            yield* TestClock.adjust("5 minutes");

            const again = yield* delivery.claimDue({
              ids,
              leaseSeconds: 30,
              limit: 2,
            });

            assert.deepStrictEqual(
              pipe(
                again,
                Arr.map((row) => [row.id, row.attempts])
              ),
              [[retryId, 2]]
            );
          })
      );
    });
  }
);
