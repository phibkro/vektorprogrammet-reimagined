/**
 * `OutboxDelivery` on real PostgreSQL: concurrent claimers never receive the
 * same row (`FOR UPDATE SKIP LOCKED`), leases expire, claim tokens fence
 * late acknowledgements, and failed rows return at their next attempt time.
 * Time is Effect's `TestClock`.
 */
import { assert, layer } from "@effect/vitest";
import { Outbox, type OutboxMessage } from "@vektorprogrammet/domain";
import { Array as Arr, DateTime, Effect } from "effect";
import { TestClock } from "effect/testing";
import { OutboxDelivery } from "../src/index.ts";
import { postgresDatabase } from "./support/database.ts";
import { AT } from "./support/fixtures.ts";

const slack = (text: string): OutboxMessage => ({
  _tag: "SlackPost",
  target: { _tag: "Notifications" },
  text,
});

layer(postgresDatabase(), { excludeTestServices: true })("outbox delivery on PostgreSQL", (it) => {
  it.layer(TestClock.layer())((it) => {
    it.effect("concurrent claimers never receive the same row", () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(DateTime.toEpochMillis(AT));
        const outbox = yield* Outbox;
        const delivery = yield* OutboxDelivery;
        const ids = yield* outbox.enqueue(Arr.makeBy(40, (i) => slack(`melding ${i}`)));
        const batches = yield* Effect.all(
          Arr.makeBy(8, () => delivery.claimDue({ limit: 5, leaseSeconds: 60, ids })),
          { concurrency: "unbounded" },
        );
        const claimed = batches.flat().map((row) => row.id);
        assert.strictEqual(new Set(claimed).size, claimed.length, "a row was claimed twice");
        assert.isTrue(batches.flat().every((row) => row.attempts === 1));
        // Whatever a racing claimer skipped is still claimable once, by a later claim.
        const rest = (yield* delivery.claimDue({ limit: 40, leaseSeconds: 60, ids })).map(
          (row) => row.id,
        );
        assert.deepStrictEqual([...claimed, ...rest].sort(), [...ids].sort());
      }),
    );

    it.effect("an expired lease can be re-claimed; the stale token is fenced out", () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(DateTime.toEpochMillis(AT));
        const outbox = yield* Outbox;
        const delivery = yield* OutboxDelivery;
        const ids = yield* outbox.enqueue([slack("lease")]);
        const [first] = yield* delivery.claimDue({ limit: 1, leaseSeconds: 30, ids });
        if (first === undefined) return assert.fail("expected a claim");
        // Within the lease nobody else gets it.
        assert.deepStrictEqual(yield* delivery.claimDue({ limit: 1, leaseSeconds: 30, ids }), []);

        yield* TestClock.adjust("31 seconds");
        const [second] = yield* delivery.claimDue({ limit: 1, leaseSeconds: 30, ids });
        if (second === undefined) return assert.fail("expected a re-claim after the lease");
        assert.strictEqual(second.id, first.id);
        assert.strictEqual(second.attempts, 2);
        assert.notStrictEqual(second.claimToken, first.claimToken);

        assert.strictEqual(yield* delivery.markDelivered(first.id, first.claimToken), "claimLost");
        assert.strictEqual(
          yield* delivery.markFailed(first.id, first.claimToken, "late", "dead"),
          "claimLost",
        );
        assert.strictEqual(yield* delivery.markDelivered(second.id, second.claimToken), "recorded");
        yield* TestClock.adjust("1 hour");
        assert.deepStrictEqual(yield* delivery.claimDue({ limit: 1, leaseSeconds: 30, ids }), []);
      }),
    );

    it.effect("a failed row is due again at its next attempt time; a dead row never", () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(DateTime.toEpochMillis(AT));
        const outbox = yield* Outbox;
        const delivery = yield* OutboxDelivery;
        const [retryId, deadId] = yield* outbox.enqueue([slack("retry"), slack("dead")]);
        if (retryId === undefined || deadId === undefined) return assert.fail("expected two ids");
        const ids = [retryId, deadId];
        const claims = yield* delivery.claimDue({ limit: 2, leaseSeconds: 30, ids });
        const retry = claims.find((row) => row.id === retryId);
        const dead = claims.find((row) => row.id === deadId);
        if (retry === undefined || dead === undefined) return assert.fail("expected both claimed");

        const next = DateTime.add(AT, { minutes: 5 });
        assert.strictEqual(
          yield* delivery.markFailed(retry.id, retry.claimToken, "timeout", next),
          "recorded",
        );
        assert.strictEqual(
          yield* delivery.markFailed(dead.id, dead.claimToken, "rejected", "dead"),
          "recorded",
        );
        assert.deepStrictEqual(yield* delivery.claimDue({ limit: 2, leaseSeconds: 30, ids }), []);
        yield* TestClock.adjust("5 minutes");
        const again = yield* delivery.claimDue({ limit: 2, leaseSeconds: 30, ids });
        assert.deepStrictEqual(
          again.map((row) => [row.id, row.attempts]),
          [[retryId, 2]],
        );
      }),
    );
  });
});
