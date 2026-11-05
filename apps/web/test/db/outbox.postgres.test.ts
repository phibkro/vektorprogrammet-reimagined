/**
 * `OutboxDelivery` on real PostgreSQL (spec 0008b): the claim is one conditional `UPDATE`, so concurrent deliveries of one
 * id never both hold the row; leases expire; claim tokens fence late acknowledgements; a failed row stays pending and says
 * when its next attempt is due; the dead-letter queue's ending never takes a row under a live claim; and the receipt of
 * the queue decides which rows the sweep finds. Time is Effect's `TestClock`.
 */
import { assert, layer } from "@effect/vitest";
import {
  Array as Arr,
  Cause,
  DateTime,
  Effect,
  Exit,
  Option,
  Predicate,
  Schema,
} from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { TestClock } from "effect/testing";

import { OutboxMessageId } from "../../src/core/ids";
import {
  OutboxClaimToken,
  OutboxDelivery,
} from "../../src/core/outbox/delivery";
import type { ClaimedOutboxMessage } from "../../src/core/outbox/delivery";
import { OutboxMessage } from "../../src/core/outbox/messages";
import { Outbox } from "../../src/core/outbox/outbox";
import { OutboxReports } from "../../src/core/outbox/status";
import { Transactor } from "../../src/core/transactions/transactor";
import { postgresDatabase } from "./support/database.ts";
import { TestDatabaseUrl, withClient } from "./support/disposableDatabase.ts";
import { AT, slack } from "./support/fixtures.ts";
import { meetsHeldLock, race } from "./support/race.ts";

/** Every test starts at `AT`; the clock is then the test's to move, so nothing below sets it again. */
const atStart = TestClock.setTime(DateTime.toEpochMillis(AT));

const services = Effect.gen(function* services() {
  return {
    delivery: yield* OutboxDelivery,
    outbox: yield* Outbox,
    reports: yield* OutboxReports,
    sql: yield* SqlClient,
    transactor: yield* Transactor,
  };
});

const one = Effect.fnUntraced(function* one(text: string) {
  const { outbox, transactor } = yield* services;
  const [id] = yield* transactor.run(outbox.enqueue([slack(text)]));

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

/** The state of one outbox row: its status, and whether a claim holds it. */
const rowState = Effect.fnUntraced(function* rowState(id: OutboxMessageId) {
  const { sql } = yield* services;

  const rows = yield* sql<{
    readonly claimed: boolean;
    readonly status: string;
  }>`select status, claim_token is not null as claimed from outbox where id = ${Number(id)}`;

  return rows[0];
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
        "the attempt limit terminates failures and expired final leases",
        () =>
          Effect.gen(function* boundedAttempts() {
            yield* atStart;
            const { delivery, sql } = yield* services;
            const failed = yield* one("final failure");
            const expired = yield* one("final lease");
            yield* sql`update outbox set attempts = 7 where id in (${Number(failed)}, ${Number(expired)})`;
            const final = yield* claimOrFail(failed, 30);
            assert.strictEqual(final.attempts, 8);
            yield* delivery.markFailed(failed, final.claimToken, "timeout", AT);
            assert.strictEqual((yield* rowState(failed))?.status, "dead");
            const abandoned = yield* claimOrFail(expired, 30);
            yield* TestClock.adjust("31 seconds");
            assert.strictEqual(
              (yield* delivery.claim(expired, 30))._tag,
              "Settled"
            );
            assert.strictEqual((yield* rowState(expired))?.status, "dead");
            assert.strictEqual(
              yield* delivery.markDelivered(expired, abandoned.claimToken),
              "claimLost"
            );
          })
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
        "a failed row cannot be claimed before its retry is due",
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

            assert.strictEqual((yield* delivery.claim(id, 30))._tag, "Held");
            yield* TestClock.adjust("5 minutes");
            const again = yield* claimOrFail(id, 30);
            assert.strictEqual(again.attempts, 2);
          })
      );

      layerTest.effect(
        "the sweep finds due rows but excludes live claims and future retries",
        () =>
          Effect.gen(function* dueSweep() {
            yield* atStart;
            const { delivery, sql } = yield* services;
            yield* sql`truncate outbox restart identity`;
            const id = yield* one("due");
            const due = () => delivery.due({ limit: 50 });
            assert.include(yield* due(), id);
            const row = yield* claimOrFail(id, 60);
            assert.notInclude(yield* due(), id);
            yield* delivery.markFailed(
              id,
              row.claimToken,
              "timeout",
              DateTime.add(AT, { minutes: 5 })
            );
            assert.notInclude(yield* due(), id);
            yield* TestClock.adjust("5 minutes");
            assert.include(yield* due(), id);
          })
      );

      layerTest.effect(
        "provider deletion remains pending after the ordinary attempt limit",
        () =>
          Effect.gen(function* providerRetries() {
            yield* atStart;
            const { delivery, outbox, sql, transactor } = yield* services;

            const [id] = yield* transactor.run(
              outbox.enqueue([
                OutboxMessage.cases.DeleteAuthUser.make({
                  userId: "00000000-0000-4000-8000-000000000001",
                }),
              ])
            );

            if (id === undefined) {
              return yield* Effect.die("missing outbox id");
            }

            yield* sql`update outbox set attempts = 8 where id = ${Number(id)}`;
            const row = yield* claimOrFail(id, 60);
            assert.strictEqual(row.attempts, 9);
            const next = DateTime.add(AT, { minutes: 5 });
            yield* delivery.markFailed(
              id,
              row.claimToken,
              "provider deletion failed",
              next
            );
            assert.deepStrictEqual(yield* rowState(id), {
              claimed: false,
              status: "pending",
            });
            assert.strictEqual((yield* delivery.claim(id, 60))._tag, "Held");
            yield* TestClock.adjust("5 minutes");
            assert.strictEqual((yield* claimOrFail(id, 60)).attempts, 10);

            return yield* Effect.void;
          })
      );
      layerTest.effect(
        "the overview reports waiting, retrying and failed rows without payloads",
        () =>
          Effect.gen(function* overviewStates() {
            yield* atStart;
            const { reports, delivery, sql } = yield* services;
            yield* sql`truncate outbox restart identity`;
            const waiting = yield* one("secret");
            const retrying = yield* one("retry");
            const failed = yield* one("failed");
            const retry = yield* claimOrFail(retrying, 60);
            yield* delivery.markFailed(
              retrying,
              retry.claimToken,
              "timeout",
              DateTime.add(AT, { minutes: 5 })
            );
            yield* sql`update outbox set attempts = 7 where id = ${Number(failed)}`;
            const last = yield* claimOrFail(failed, 60);
            yield* delivery.markFailed(failed, last.claimToken, "timeout", AT);
            const overview = yield* reports.overview;
            assert.deepStrictEqual(overview.counts, {
              delivered: 0,
              failed: 1,
              pending: 2,
            });
            assert.deepStrictEqual(
              Arr.map(overview.open, (row) => [row.id, row.state]),
              [
                [failed, "failed"],
                [retrying, "retrying"],
                [waiting, "waiting"],
              ]
            );
            assert.isFalse(
              (yield* Schema.encodeEffect(
                Schema.fromJsonString(Schema.Unknown)
              )(overview)).includes("secret")
            );
          })
      );

      layerTest.effect(
        "falsifier 5: markDelivered joins the caller's transaction (its acknowledgement rolls back with it) and commits alone outside one",
        () =>
          Effect.gen(function* joinsTheTransaction() {
            yield* atStart;
            const { delivery, transactor } = yield* services;

            const inside = yield* claimOrFail(yield* one("inside"), 60);

            const rolledBack = yield* Effect.exit(
              transactor.run(
                Effect.andThen(
                  delivery.markDelivered(inside.id, inside.claimToken),
                  Effect.fail("the caller's transaction fails")
                )
              )
            );

            assert.isTrue(Exit.isFailure(rolledBack));

            assert.deepStrictEqual(yield* rowState(inside.id), {
              claimed: true,
              status: "pending",
            });

            // Without a transaction of the caller's the acknowledgement stands on its own, whatever follows.
            const alone = yield* claimOrFail(yield* one("alone"), 60);

            const failedAfter = yield* Effect.exit(
              Effect.andThen(
                delivery.markDelivered(alone.id, alone.claimToken),
                Effect.fail("nothing to roll back")
              )
            );

            assert.isTrue(Exit.isFailure(failedAfter));

            assert.deepStrictEqual(yield* rowState(alone.id), {
              claimed: false,
              status: "delivered",
            });
          })
      );
    });

    // The control opens a second client, which needs the real clock that this layer was built with.
    it.effect(
      "falsifier 5, control: an acknowledgement written on another client than the transaction's commits through the caller's rollback, and the case above sees it",
      () =>
        Effect.gen(function* acknowledgesApart() {
          const url = yield* TestDatabaseUrl;
          const { transactor } = yield* services;
          const claim = yield* claimOrFail(yield* one("apart"), 60);

          const exit = yield* withClient(url, (other) =>
            Effect.exit(
              transactor.run(
                Effect.andThen(
                  other`update outbox set status = 'delivered', delivered_at = now(), claim_token = null, claimed_until = null where id = ${Number(claim.id)} and claim_token = ${claim.claimToken}::uuid`,
                  Effect.fail("the caller's transaction fails")
                )
              )
            )
          );

          // The caller's transaction failed in its own way (a typed failure, not a defect of the second client) ...
          assert.deepStrictEqual(
            Exit.findErrorOption(exit),
            Option.some("the caller's transaction fails"),
            Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "succeeded"
          );

          // ... and the acknowledgement did not join it: it survived the rollback, which is the state that the case
          // above refuses (`pending`, claimed).
          assert.deepStrictEqual(yield* rowState(claim.id), {
            claimed: false,
            status: "delivered",
          });
        })
    );

    it.effect(
      "spec 0024 R9: holdClaim answers `recorded` only for the row's current claim token, and `claimLost` for another token, a delivered row and a row that is not there",
      () =>
        Effect.gen(function* holdsOnlyTheCurrentClaim() {
          const { delivery, transactor } = yield* services;
          const claim = yield* claimOrFail(yield* one("hold"), 60);

          const hold = (id: OutboxMessageId, token: typeof claim.claimToken) =>
            transactor.run(delivery.holdClaim(id, token));

          assert.strictEqual(
            yield* hold(claim.id, claim.claimToken),
            "recorded"
          );

          assert.strictEqual(
            yield* hold(
              claim.id,
              OutboxClaimToken.make("00000000-0000-4000-8000-000000000000")
            ),
            "claimLost"
          );

          assert.strictEqual(
            yield* delivery.markDelivered(claim.id, claim.claimToken),
            "recorded"
          );

          assert.strictEqual(
            yield* hold(claim.id, claim.claimToken),
            "claimLost"
          );

          assert.strictEqual(
            yield* hold(OutboxMessageId.make("999999"), claim.claimToken),
            "claimLost"
          );
        })
    );

    it.effect(
      "spec 0024 R9: a hold keeps the row locked until the caller's transaction ends, so another consumer's claim of it waits (control: without the hold the claim does not wait)",
      () =>
        Effect.gen(function* holdLocksTheRow() {
          const { delivery, sql } = yield* services;
          const waitingForClaim = '%update "outbox" set%';

          const lapsedClaim = Effect.fnUntraced(function* lapsedClaim(
            text: string
          ) {
            const row = yield* claimOrFail(yield* one(text), 60);
            yield* sql`update outbox set claimed_until = now() - interval '1 minute' where id = ${Number(row.id)}`;

            return row;
          });

          const held = yield* lapsedClaim("held");

          const withHold = yield* meetsHeldLock(
            delivery.holdClaim(held.id, held.claimToken),
            waitingForClaim,
            delivery.claim(held.id, 60)
          );

          assert.strictEqual(withHold.waiting, 1);
          assert.isTrue(withHold.stillRunning);

          assert.isTrue(
            Exit.isSuccess(withHold.exit) &&
              Predicate.isTagged(withHold.exit.value, "Claimed")
          );

          const free = yield* lapsedClaim("free");

          const withoutHold = yield* meetsHeldLock(
            Effect.void,
            waitingForClaim,
            delivery.claim(free.id, 60)
          );

          assert.strictEqual(withoutHold.waiting, 0);
          assert.isFalse(withoutHold.stillRunning);
        })
    );
  }
);
