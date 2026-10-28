import { assert, describe, it } from "@effect/vitest";
import { OutboxClaimToken, OutboxDelivery } from "@vektorprogrammet/db";
import {
  EmailAddress,
  OutboxMessageId,
  OutboxMessage as OutboxMessageSchema,
  OutboxSweep,
  anonymous,
  systemPrincipal,
  WorkspaceWriter,
} from "@vektorprogrammet/domain";
import type { OutboxMessage, Principal } from "@vektorprogrammet/domain";
import {
  Array as Arr,
  DateTime,
  Duration,
  Effect,
  Layer,
  Logger,
  Predicate,
  pipe,
} from "effect";
import { TestClock } from "effect/testing";

import { AccountDelivery } from "../src/server/accountDelivery";
import { deliverOutbox, failOutbox } from "../src/server/outboxDelivery";
import { deliveryDecisions } from "../src/server/outboxQueue";
import { withEnding, withOutbox } from "../src/server/outboxSweep";
import { DeliveryFailed, MessageSender } from "../src/server/senders";
import { makeTables, memoryLayer } from "./support/memory";
import type { MemoryTables } from "./support/memory";
import { ADMIN, leaderOf } from "./support/principals";

const message: OutboxMessage = OutboxMessageSchema.cases.Email.make({
  replyTo: null,
  subject: "Henvendelse",
  text: "Hei",
  to: EmailAddress.make("avdeling@example.org"),
});

const pendingRow = (id: string) => ({
  attempts: 0,
  claimToken: null,
  id: OutboxMessageId.make(id),
  lastError: null,
  message,
  nextAttemptAt: null,
  status: "pending" as const,
});

const senderLayer = (fails: boolean, sent: OutboxMessage[]) =>
  Layer.succeed(
    MessageSender,
    MessageSender.of({
      send: (outgoing) =>
        fails
          ? Effect.fail(new DeliveryFailed({ reason: "transport down" }))
          : Effect.sync(() => {
              sent.push(outgoing);
            }),
    })
  );

const services = (
  tables: MemoryTables,
  fails: boolean,
  sent: OutboxMessage[] = []
) =>
  Layer.mergeAll(
    memoryLayer(tables),
    senderLayer(fails, sent),
    Layer.mock(AccountDelivery, {}),
    Layer.mock(WorkspaceWriter, {})
  );

const ids = (...names: readonly string[]) =>
  pipe(
    names,
    Arr.map((name) => OutboxMessageId.make(name))
  );

const run = (
  tables: MemoryTables,
  fails: boolean,
  named: readonly string[],
  sent: OutboxMessage[] = []
) =>
  deliverOutbox(ids(...named)).pipe(
    Effect.provide(services(tables, fails, sent))
  );

const seconds = (attempts: number) =>
  Duration.toSeconds(OutboxSweep.retryDelay(attempts));

describe("outbox delivery by id (spec 0008b)", () => {
  it("the retry delay doubles from the declared base and stops at the declared cap", () => {
    const base = Duration.toSeconds(OutboxSweep.DeliveryPolicy.retryBase);
    const cap = Duration.toSeconds(OutboxSweep.DeliveryPolicy.retryCap);

    assert.deepStrictEqual(
      [seconds(1), seconds(2), seconds(3)],
      [base, 2 * base, 4 * base]
    );
    assert.strictEqual(seconds(OutboxSweep.DeliveryPolicy.attempts + 20), cap);

    // A law, not a table: every delay is within the declaration and none is shorter than the one before.
    for (let attempts = 1; attempts < 60; attempts += 1) {
      assert.isTrue(seconds(attempts) >= base);
      assert.isTrue(seconds(attempts) <= cap);
      assert.isTrue(seconds(attempts + 1) >= seconds(attempts));
    }
  });

  it.effect("delivers the rows that were named and marks them delivered", () =>
    Effect.gen(function* effectProgram() {
      const tables = makeTables({ outbox: [pendingRow("a"), pendingRow("b")] });
      const sent: OutboxMessage[] = [];
      const results = yield* run(tables, false, ["a", "b"], sent);

      assert.deepStrictEqual(
        pipe(
          results,
          Arr.map((result) => result._tag)
        ),
        ["Delivered", "Delivered"]
      );
      assert.strictEqual(sent.length, 2);
      assert.deepStrictEqual(
        pipe(
          tables.outbox,
          Arr.map((row) => row.status)
        ),
        ["delivered", "delivered"]
      );
    })
  );

  it.effect("claims only the rows that were named", () =>
    Effect.gen(function* effectProgram() {
      const tables = makeTables({ outbox: [pendingRow("a"), pendingRow("b")] });
      yield* run(tables, false, ["b"]);
      assert.deepStrictEqual(
        pipe(
          tables.outbox,
          Arr.map((row) => row.status)
        ),
        ["pending", "delivered"]
      );
    })
  );

  it.effect(
    "a second delivery of the same id sends nothing: a delivered row is settled, and a row under another claim is held",
    () =>
      Effect.gen(function* effectProgram() {
        const tables = makeTables({
          outbox: [
            pendingRow("a"),
            {
              ...pendingRow("b"),
              claimToken: OutboxClaimToken.make("claimed-elsewhere"),
            },
          ],
        });

        const sent: OutboxMessage[] = [];
        yield* run(tables, false, ["a"], sent);

        const again = yield* run(tables, false, ["a", "b", "missing"], sent);

        assert.deepStrictEqual(
          pipe(
            again,
            Arr.map((result) => result._tag)
          ),
          ["Settled", "Held", "Settled"]
        );
        assert.strictEqual(sent.length, 1, "the provider heard of 'a' once");
      })
  );

  it.effect(
    "a failed send leaves the row pending with the class of the failure and the policy's delay, and is never dead from here",
    () =>
      Effect.gen(function* effectProgram() {
        const tables = makeTables({ outbox: [pendingRow("a")] });
        const [first] = yield* run(tables, true, ["a"]);

        assert.isTrue(Predicate.isTagged(first, "Retrying"));
        assert.strictEqual(
          Predicate.isTagged(first, "Retrying") ? first.afterSeconds : -1,
          Duration.toSeconds(OutboxSweep.retryDelay(1))
        );
        assert.strictEqual(tables.outbox[0]?.lastError, "transport down");
        assert.strictEqual(tables.outbox[0]?.status, "pending");
        assert.isNull(tables.outbox[0]?.claimToken);

        // However often it fails, only the dead-letter queue ends it: eight failures in a row stay pending.
        for (
          let attempt = 2;
          attempt <= OutboxSweep.DeliveryPolicy.attempts + 2;
          attempt += 1
        ) {
          yield* TestClock.adjust("24 hours");
          yield* run(tables, true, ["a"]);
        }

        assert.strictEqual(tables.outbox[0]?.status, "pending");
        assert.strictEqual(
          tables.outbox[0]?.attempts,
          OutboxSweep.DeliveryPolicy.attempts + 2
        );

        // The next delivery that works records it.
        const [last] = yield* run(tables, false, ["a"]);
        assert.isTrue(Predicate.isTagged(last, "Delivered"));
      })
  );

  it.effect(
    "the dead-letter queue ends a pending row; a delivered one, a held one and a missing one stay as they are",
    () =>
      Effect.gen(function* effectProgram() {
        const tables = makeTables({
          outbox: [
            { ...pendingRow("a"), lastError: "transport down" },
            { ...pendingRow("b"), status: "delivered" as const },
            { ...pendingRow("c"), claimToken: OutboxClaimToken.make("live") },
            pendingRow("d"),
          ],
        });

        const results = yield* failOutbox(
          ids("a", "b", "c", "d", "missing")
        ).pipe(Effect.provide(services(tables, false)));

        assert.deepStrictEqual(
          pipe(
            results,
            Arr.map((result) => result._tag)
          ),
          ["Failed", "Settled", "Held", "Settled", "Settled"]
        );
        assert.deepStrictEqual(
          pipe(
            tables.outbox,
            Arr.map((row) => row.status)
          ),
          ["dead", "delivered", "pending", "pending"],
          "row d never failed at a provider (the queue's attempts went on an outage): it stays pending for the sweep"
        );
        assert.strictEqual(
          tables.outbox[0]?.lastError,
          "transport down",
          "the class of the last failure is kept"
        );

        // A dead row is never delivered again, by any message.
        const sent: OutboxMessage[] = [];
        yield* run(tables, false, ["a"], sent);
        assert.strictEqual(sent.length, 0);
      })
  );

  it.effect(
    "an outage that makes every delivery die retries the message with the policy's delay for its own delivery count, not a flat one",
    () =>
      Effect.gen(function* backoffOfDefects() {
        const tables = makeTables({ outbox: [pendingRow("1")] });

        const outage = Layer.mergeAll(
          services(tables, false),
          Layer.mock(AccountDelivery, {})
        );

        const delays = yield* Effect.forEach(
          Arr.range(1, OutboxSweep.DeliveryPolicy.attempts),
          (attempts) =>
            deliveryDecisions([{ attempts, body: "1" }]).pipe(
              Effect.updateService(OutboxDelivery, (real) =>
                OutboxDelivery.of({
                  ...real,
                  claim: () => Effect.die("the database is unreachable"),
                })
              ),
              Effect.provide(outage),
              Effect.map((decisions) =>
                Arr.map(decisions, (decision) =>
                  Predicate.isTagged(decision, "Retry")
                    ? decision.afterSeconds
                    : -1
                )
              )
            )
        );

        assert.deepStrictEqual(
          delays.flat(),
          Arr.map(Arr.range(1, OutboxSweep.DeliveryPolicy.attempts), (n) =>
            Math.ceil(seconds(n))
          ),
          "each delivery's retry waits the policy's delay for its count"
        );
        assert.isAbove(
          delays.flat().at(-1) ?? 0,
          delays.flat()[0] ?? 0,
          "and the delay grows: the attempts last hours, not minutes"
        );
        assert.strictEqual(
          tables.outbox[0]?.status,
          "pending",
          "nothing was written to the row"
        );
      })
  );

  it.effect(
    "a sender that dies after the claim is a failure of the row: a class is recorded, the claim is released, the retry waits the policy's delay, and the log holds no address",
    () =>
      Effect.gen(function* poisonRow() {
        const tables = makeTables({ outbox: [pendingRow("1")] });
        const logged: string[] = [];

        const dying = Layer.mergeAll(
          memoryLayer(tables),
          Layer.succeed(
            MessageSender,
            MessageSender.of({
              send: () => Effect.die(new Error("avdeling@example.org")),
            })
          ),
          Layer.mock(AccountDelivery, {}),
          Layer.mock(WorkspaceWriter, {}),
          Logger.layer([
            Logger.map(Logger.formatJson, (line) => {
              logged.push(line);
            }),
          ])
        );

        const decisions = yield* deliveryDecisions([
          { attempts: 1, body: "1" },
        ]).pipe(Effect.provide(dying));

        assert.deepStrictEqual(
          Arr.map(decisions, (decision) =>
            Predicate.isTagged(decision, "Retry") ? decision.afterSeconds : -1
          ),
          [Math.ceil(seconds(1))]
        );
        assert.strictEqual(tables.outbox[0]?.status, "pending");
        assert.strictEqual(tables.outbox[0]?.lastError, "delivery defect");
        assert.isNull(tables.outbox[0]?.claimToken);
        assert.isAbove(logged.length, 0, "the defect was logged");
        assert.isFalse(
          Arr.some(logged, (line) => line.includes("avdeling@example.org")),
          "the log holds the defect's class, never its text"
        );
      })
  );
});

const layerFor = (principal: Principal) =>
  Layer.mergeAll(
    memoryLayer(makeTables(), principal),
    senderLayer(false, []),
    Layer.mock(AccountDelivery, {}),
    Layer.mock(WorkspaceWriter, {})
  );

/** What a command did for a principal: it ran, or it was refused, or it failed otherwise. */
const verdictOf = Effect.match({
  onFailure: (failure: { readonly _tag: string }) =>
    Predicate.isTagged(failure, "Forbidden") ? "Forbidden" : "another failure",
  onSuccess: () => "allowed",
});

/** Each command as the Worker runs it: through the in-process client, as the principal it is given. */
const commands = [
  [
    "sweepOutbox",
    (principal: Principal) =>
      withOutbox((client) => client.sweepOutbox({ limit: 50 })).pipe(
        Effect.provide(layerFor(principal)),
        verdictOf
      ),
  ],
  [
    "deliverOutbox",
    (principal: Principal) =>
      withOutbox((client) => client.deliverOutbox({ ids: [] })).pipe(
        Effect.provide(layerFor(principal)),
        verdictOf
      ),
  ],
  [
    "failOutbox",
    (principal: Principal) =>
      withEnding((client) => client.failOutbox({ ids: [] })).pipe(
        Effect.provide(layerFor(principal)),
        verdictOf
      ),
  ],
  [
    "recordOutboxFailure",
    (principal: Principal) =>
      withEnding((client) =>
        client.recordOutboxFailure({
          failure: "delivery stack unavailable",
          messages: [],
        })
      ).pipe(Effect.provide(layerFor(principal)), verdictOf),
  ],
] as const;

describe("spec 0006 R1 and spec 0008b: the outbox's four commands are held by the outboxSweep job alone", () => {
  it.effect(
    "the job runs each of them; every other principal, an administrator included, is refused",
    () =>
      Effect.gen(function* grantsEffect() {
        const principals: readonly (readonly [string, Principal])[] = [
          ["the outboxSweep job", systemPrincipal("outboxSweep")],
          ["the semesters job", systemPrincipal("semesters")],
          ["an administrator", ADMIN],
          ["a team leader", leaderOf(1)],
          ["a visitor", anonymous],
        ];

        for (const [name, command] of commands) {
          for (const [who, principal] of principals) {
            const verdict = yield* command(principal);

            assert.strictEqual(
              verdict,
              who === "the outboxSweep job" ? "allowed" : "Forbidden",
              `${name}: ${who}`
            );
          }
        }
      })
  );

  it.effect("the sweep finds stale rows and delivers nothing", () =>
    Effect.gen(function* sweepFinds() {
      yield* TestClock.setTime(
        DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-28T12:00:00Z"))
      );

      const tables = makeTables({ outbox: [pendingRow("a")] });
      const sent: OutboxMessage[] = [];

      const found = yield* withOutbox((client) =>
        client.sweepOutbox({ limit: 50 })
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            memoryLayer(tables, systemPrincipal("outboxSweep")),
            senderLayer(false, sent),
            Layer.mock(AccountDelivery, {}),
            Layer.mock(WorkspaceWriter, {})
          )
        )
      );

      assert.deepStrictEqual(found.stale, ids("a"));
      assert.strictEqual(sent.length, 0);
      assert.strictEqual(tables.outbox[0]?.status, "pending");
    })
  );
});
