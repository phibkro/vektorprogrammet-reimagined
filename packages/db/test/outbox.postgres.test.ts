/**
 * `OutboxDelivery` on real PostgreSQL (spec 0008b): the claim is one conditional `UPDATE`, so concurrent deliveries of one
 * id never both hold the row; leases expire; claim tokens fence late acknowledgements; a failed row stays pending and says
 * when its next attempt is due; the dead-letter queue's ending never takes a row under a live claim; and the receipt of
 * the queue decides which rows the sweep finds. Time is Effect's `TestClock`.
 */
import { assert, layer } from "@effect/vitest";
import {
  Outbox,
  OutboxMessage,
  OutboxReports,
  PersonId,
  SlackTarget,
} from "@vektorprogrammet/domain";
import type { OutboxMessageId } from "@vektorprogrammet/domain";
import {
  Array as Arr,
  Cause,
  DateTime,
  Effect,
  Exit,
  Predicate,
  Record as Rec,
  pipe,
} from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { TestClock } from "effect/testing";

import { OutboxDelivery } from "../src/index.ts";
import type { ClaimedOutboxMessage } from "../src/index.ts";
import { postgresDatabase } from "./support/database.ts";
import { AT } from "./support/fixtures.ts";
import { race } from "./support/race.ts";

const slack = (text: string): OutboxMessage =>
  OutboxMessage.cases.SlackPost.make({
    target: SlackTarget.cases.Notifications.make({}),
    text,
  });

/** Every test starts at `AT`; the clock is then the test's to move, so nothing below sets it again. */
const atStart = TestClock.setTime(DateTime.toEpochMillis(AT));

const services = Effect.gen(function* services() {
  return {
    delivery: yield* OutboxDelivery,
    outbox: yield* Outbox,
    reports: yield* OutboxReports,
    sql: yield* SqlClient,
  };
});

const one = Effect.fnUntraced(function* one(text: string) {
  const { outbox } = yield* services;
  const [id] = yield* outbox.enqueue([slack(text)]);

  if (id === undefined) {
    return yield* Effect.die("one message was enqueued and no id came back");
  }

  return id;
});

const claimed = (claim: {
  readonly _tag: string;
}): claim is { readonly _tag: "Claimed"; readonly row: ClaimedOutboxMessage } =>
  Predicate.isTagged(claim, "Claimed");

const claimOrFail = Effect.fnUntraced(function* claimOrFail(
  id: OutboxMessageId,
  leaseSeconds: number
) {
  const { delivery } = yield* services;
  const claim = yield* delivery.claim(id, leaseSeconds);

  if (!claimed(claim)) {
    return yield* Effect.die(`expected a claim, found ${claim._tag}`);
  }

  return claim.row;
});

/** How many rounds the race runs, each on a row of its own. */
const ROUNDS = 100;
const CLAIMERS = 20;

layer(postgresDatabase(), { excludeTestServices: true })(
  "outbox delivery on PostgreSQL",
  (it) => {
    it.layer(TestClock.layer())((layerTest) => {
      layerTest.effect(
        `${CLAIMERS} concurrent claims of one row: exactly one holds it, in each of ${ROUNDS} fresh rounds`,
        () =>
          Effect.gen(function* concurrentClaims() {
            yield* atStart;
            const { delivery } = yield* services;

            const losers: string[] = [];

            for (const round of Arr.range(1, ROUNDS)) {
              const id = yield* one(`runde ${round}`);

              // One gate releases every claimer at once.
              const exits = yield* race(
                Arr.makeBy(CLAIMERS, () => delivery.claim(id, 60))
              );

              const tags = Arr.flatMap(exits, (exit) =>
                Exit.isSuccess(exit) ? [exit.value._tag] : []
              );

              const failures = Arr.flatMap(exits, (exit) =>
                Exit.isFailure(exit) ? [Cause.pretty(exit.cause)] : []
              );

              const holders = Arr.filter(tags, (tag) => tag === "Claimed");
              const told = Arr.filter(tags, (tag) => tag === "Held");

              if (
                failures.length > 0 ||
                holders.length !== 1 ||
                told.length !== CLAIMERS - 1
              ) {
                losers.push(
                  `round ${round}: ${holders.length} held it, ${told.length} were told so; ${Arr.join(failures, "; ")}`
                );
              }
            }

            assert.deepStrictEqual(losers, []);
          }),
        { timeout: 120_000 }
      );

      layerTest.effect(
        "an expired lease can be re-claimed; the stale token is fenced out",
        () =>
          Effect.gen(function* effectProgram() {
            yield* atStart;
            const { delivery } = yield* services;
            const id = yield* one("lease");
            const first = yield* claimOrFail(id, 30);

            // Within the lease nobody else gets it, and the other claimer is told why.
            assert.strictEqual((yield* delivery.claim(id, 30))._tag, "Held");

            yield* TestClock.adjust("31 seconds");

            const second = yield* claimOrFail(id, 30);

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
                DateTime.add(AT, { minutes: 5 })
              ),
              "claimLost"
            );
            assert.strictEqual(
              yield* delivery.markDelivered(second.id, second.claimToken),
              "recorded"
            );
            yield* TestClock.adjust("1 hour");
            assert.strictEqual(
              (yield* delivery.claim(id, 30))._tag,
              "Settled",
              "a delivered row is settled: a second message for it does nothing"
            );
          })
      );

      layerTest.effect(
        "a failed row stays pending with its error and next attempt; the claim ignores the date, because the queue schedules the retry",
        () =>
          Effect.gen(function* effectProgram() {
            yield* atStart;
            const { delivery, sql } = yield* services;
            const id = yield* one("retry");
            const row = yield* claimOrFail(id, 30);
            const next = DateTime.add(AT, { minutes: 5 });

            assert.strictEqual(
              yield* delivery.markFailed(id, row.claimToken, "timeout", next),
              "recorded"
            );

            const [stored] = yield* sql<{
              readonly status: string;
              readonly last_error: string;
              readonly next_attempt_at: Date;
              readonly claim_token: string | null;
            }>`select status, last_error, next_attempt_at, claim_token from outbox where id = ${Number(id)}`;

            assert.strictEqual(stored?.status, "pending");
            assert.strictEqual(stored?.last_error, "timeout");
            assert.strictEqual(
              stored?.next_attempt_at.getTime(),
              DateTime.toEpochMillis(next)
            );
            assert.isNull(stored?.claim_token);

            const again = yield* claimOrFail(id, 30);
            assert.strictEqual(again.attempts, 2);
          })
      );

      layerTest.effect(
        "the dead-letter queue ends a pending row and keeps the class of its last error; a delivered, a held and a dead row are not changed",
        () =>
          Effect.gen(function* effectProgram() {
            yield* atStart;
            const { delivery, sql } = yield* services;
            const failing = yield* one("failing");
            const delivered = yield* one("delivered");
            const held = yield* one("held");
            const never = yield* one("never failed");

            const first = yield* claimOrFail(failing, 30);
            yield* delivery.markFailed(
              failing,
              first.claimToken,
              "slack StatusCodeError",
              AT
            );

            const second = yield* claimOrFail(delivered, 30);
            yield* delivery.markDelivered(delivered, second.claimToken);
            yield* claimOrFail(held, 30);

            assert.strictEqual(
              yield* delivery.markDead(failing, "gave up"),
              "failed"
            );
            assert.strictEqual(
              yield* delivery.markDead(delivered, "gave up"),
              "settled"
            );
            assert.strictEqual(
              yield* delivery.markDead(held, "gave up"),
              "held",
              "a live claim is not overruled"
            );
            assert.strictEqual(
              yield* delivery.markDead(never, "gave up"),
              "failed"
            );
            assert.strictEqual(
              yield* delivery.markDead(failing, "gave up"),
              "settled",
              "a second ending of the same row does nothing"
            );

            const rows = yield* sql<{
              readonly id: number;
              readonly status: string;
              readonly last_error: string | null;
            }>`select id, status, last_error from outbox where id in (${Number(failing)}, ${Number(delivered)}, ${Number(held)}, ${Number(never)}) order by id`;

            assert.deepStrictEqual(
              Arr.map(rows, (row) => [row.status, row.last_error]),
              [
                ["dead", "slack StatusCodeError"],
                ["delivered", null],
                ["pending", null],
                ["dead", "gave up"],
              ]
            );

            assert.strictEqual(
              (yield* delivery.claim(failing, 30))._tag,
              "Settled",
              "a dead row is never claimed again"
            );
          })
      );

      layerTest.effect(
        "a row that ends or is delivered keeps no credential hash",
        () =>
          Effect.gen(function* effectProgram() {
            yield* atStart;
            const { outbox, delivery, sql } = yield* services;

            const [ended, sent] = yield* outbox.enqueue([
              OutboxMessage.cases.SetCredential.make({
                passwordHash: null,
                personId: PersonId.make(1),
                revokeSessions: false,
              }),
              OutboxMessage.cases.SetCredential.make({
                passwordHash: null,
                personId: PersonId.make(2),
                revokeSessions: false,
              }),
            ]);

            if (ended === undefined || sent === undefined) {
              assert.fail("two intents were queued");
            }

            // The intent holds a hash until it is delivered or ended: plant a well-formed one to see it removed.
            const planted = `$2b$12$${"a".repeat(53)}`;
            yield* sql`update outbox set payload = jsonb_set(payload, '{passwordHash}', to_jsonb(${planted}::text)) where id in (${Number(ended)}, ${Number(sent)})`;

            yield* delivery.markDead(ended, "gave up");

            const row = yield* claimOrFail(sent, 30);
            yield* delivery.markDelivered(sent, row.claimToken);

            const hashes = yield* sql<{
              readonly hash: string | null;
            }>`select payload ->> 'passwordHash' as hash from outbox where id in (${Number(ended)}, ${Number(sent)})`;

            assert.deepStrictEqual(
              Arr.map(hashes, (entry) => entry.hash),
              [null, null]
            );
          })
      );

      layerTest.effect(
        "the sweep finds a pending row only when no receipt covers it: not before the threshold, not after a receipt, not under a live claim, not once delivered",
        () =>
          Effect.gen(function* effectProgram() {
            yield* atStart;
            const { delivery, sql } = yield* services;
            yield* sql`truncate outbox restart identity`;
            const threshold = DateTime.add(AT, { minutes: 10 });

            const stale = (at: DateTime.Utc) =>
              delivery.stale({
                before: DateTime.subtract(at, { minutes: 10 }),
                limit: 50,
              });

            const fresh = yield* one("fresh");
            assert.deepStrictEqual(
              yield* stale(AT),
              [],
              "a row that has just committed is not stale"
            );

            yield* TestClock.adjust("10 minutes");
            assert.deepStrictEqual(
              yield* stale(threshold),
              [fresh],
              "a row with no receipt is stale once the threshold has passed"
            );

            yield* delivery.markQueued([fresh]);
            assert.deepStrictEqual(
              yield* stale(threshold),
              [],
              "the queue's receipt covers it for another threshold"
            );

            yield* TestClock.adjust("10 minutes");
            assert.deepStrictEqual(
              yield* stale(DateTime.add(threshold, { minutes: 10 })),
              [fresh],
              "a receipt that is itself old covers nothing"
            );

            const row = yield* claimOrFail(fresh, 600);
            assert.deepStrictEqual(
              yield* stale(DateTime.add(threshold, { minutes: 10 })),
              [],
              "a live claim is somebody's work in progress"
            );

            // A failure dates the next attempt: the row is stale only a threshold after it.
            yield* delivery.markFailed(
              fresh,
              row.claimToken,
              "timeout",
              DateTime.add(threshold, { minutes: 15 })
            );
            assert.deepStrictEqual(
              yield* stale(DateTime.add(threshold, { minutes: 20 })),
              []
            );
            assert.deepStrictEqual(
              yield* stale(DateTime.add(threshold, { minutes: 25 })),
              [fresh]
            );

            const again = yield* claimOrFail(fresh, 30);
            yield* delivery.markDelivered(fresh, again.claimToken);
            assert.deepStrictEqual(
              yield* stale(DateTime.add(threshold, { days: 1 })),
              []
            );
          })
      );

      layerTest.effect(
        "the overview counts every status and lists only what is not delivered, each in its state, with no payload",
        () =>
          Effect.gen(function* effectProgram() {
            yield* atStart;
            const { delivery, reports, sql } = yield* services;
            yield* sql`truncate outbox restart identity`;

            const waiting = yield* one("hemmelig tekst om en person");
            const queued = yield* one("i kø");
            const retrying = yield* one("prøver igjen");
            const failed = yield* one("mislyktes");
            const delivered = yield* one("levert");

            yield* delivery.markQueued([queued]);

            const retry = yield* claimOrFail(retrying, 30);
            yield* delivery.markFailed(
              retrying,
              retry.claimToken,
              "slack StatusCodeError",
              DateTime.add(AT, { minutes: 5 })
            );
            yield* delivery.markDead(failed, "gave up");

            const sentRow = yield* claimOrFail(delivered, 30);
            yield* delivery.markDelivered(delivered, sentRow.claimToken);

            const overview = yield* reports.overview;

            assert.deepStrictEqual(overview.counts, {
              delivered: 1,
              failed: 1,
              pending: 3,
            });

            assert.deepStrictEqual(
              pipe(
                overview.open,
                Arr.map((row) => [row.id, row.state, row.lastError])
              ),
              [
                [failed, "failed", "gave up"],
                [retrying, "retrying", "slack StatusCodeError"],
                [queued, "queued", null],
                [waiting, "waiting", null],
              ]
            );

            assert.isFalse(
              Arr.some(overview.open, (row) =>
                Arr.some(Rec.values(row), (value) =>
                  String(value).includes("hemmelig")
                )
              ),
              "the overview holds no message content"
            );
          })
      );
    });
  }
);
