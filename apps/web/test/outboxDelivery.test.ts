import { assert, describe, it } from "@effect/vitest";
import {
  EmailAddress,
  OutboxMessageId,
  OutboxMessage as OutboxMessageSchema,
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
  Predicate,
  pipe,
} from "effect";
import { TestClock } from "effect/testing";

import { AccountDelivery } from "../src/server/accountDelivery";
import {
  BASE_RETRY_DELAY,
  MAX_ATTEMPTS,
  deliverOutbox,
  nextAttemptAfterFailure,
} from "../src/server/outboxDelivery";
import { withOutbox } from "../src/server/outboxSweep";
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

const run = (
  tables: MemoryTables,
  fails: boolean,
  sent: OutboxMessage[] = [],
  ids?: readonly string[]
) =>
  deliverOutbox(
    ids === undefined
      ? { limit: 50 }
      : {
          ids: pipe(
            ids,
            Arr.map((id) => OutboxMessageId.make(id))
          ),
          limit: 50,
        }
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        memoryLayer(tables),
        senderLayer(fails, sent),
        Layer.mock(AccountDelivery, {}),
        Layer.mock(WorkspaceWriter, {})
      )
    )
  );

describe("outbox delivery (architecture §4)", () => {
  it("backs off exponentially and marks a row dead after MAX_ATTEMPTS", () => {
    const failedAt = DateTime.makeUnsafe("2026-10-15T12:00:00Z");

    const after = (attempts: number) => {
      const next = nextAttemptAfterFailure(attempts, failedAt);

      return next === "dead"
        ? "dead"
        : DateTime.toEpochMillis(next) - DateTime.toEpochMillis(failedAt);
    };

    const base = Duration.toMillis(BASE_RETRY_DELAY);
    assert.deepStrictEqual(
      [after(1), after(2), after(3)],
      [base, 2 * base, 4 * base]
    );
    assert.strictEqual(after(MAX_ATTEMPTS), "dead");
    assert.isNumber(after(MAX_ATTEMPTS - 1));
  });

  it.effect("delivers due rows and marks them delivered", () =>
    Effect.gen(function* effectProgram() {
      const tables = makeTables({ outbox: [pendingRow("a"), pendingRow("b")] });
      const sent: OutboxMessage[] = [];
      const results = yield* run(tables, false, sent);
      assert.deepStrictEqual(
        pipe(
          results,
          Arr.map((result) => result.outcome)
        ),
        ["delivered", "delivered"]
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

  it.effect("post-commit delivery claims only the given ids", () =>
    Effect.gen(function* effectProgram() {
      const tables = makeTables({ outbox: [pendingRow("a"), pendingRow("b")] });
      yield* run(tables, false, [], ["b"]);
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
    "a failed send is retried later, then dead after MAX_ATTEMPTS",
    () =>
      Effect.gen(function* effectProgram() {
        const tables = makeTables({ outbox: [pendingRow("a")] });
        const first = yield* run(tables, true);
        assert.deepStrictEqual(
          pipe(
            first,
            Arr.map((result) => result.outcome)
          ),
          ["retrying"]
        );
        assert.strictEqual(tables.outbox[0]?.lastError, "transport down");
        // Not due yet: the sweep does not claim it again.
        assert.deepStrictEqual(yield* run(tables, true), []);

        for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt += 1) {
          yield* TestClock.adjust("24 hours");
          yield* run(tables, true);
        }

        assert.strictEqual(tables.outbox[0]?.status, "dead");
        assert.strictEqual(tables.outbox[0]?.attempts, MAX_ATTEMPTS);
        yield* TestClock.adjust("24 hours");
        assert.deepStrictEqual(yield* run(tables, false), []);
      })
  );
});

/** The sweep as the Worker runs it: the command `sweepOutbox`, through the in-process client, as `principal`. */
const sweepAs = (
  principal: Principal,
  tables: MemoryTables,
  sent: OutboxMessage[]
) =>
  withOutbox((client) => client.sweepOutbox({ limit: 50 })).pipe(
    Effect.provide(
      Layer.mergeAll(
        memoryLayer(tables, principal),
        senderLayer(false, sent),
        Layer.mock(AccountDelivery, {}),
        Layer.mock(WorkspaceWriter, {})
      )
    )
  );

describe("spec 0006, R1: the sweep is a command that only the outboxSweep job holds", () => {
  it.effect(
    "the job delivers what is due; every other principal, an administrator included, is refused and sends nothing",
    () =>
      Effect.gen(function* sweepGrantedEffect() {
        const principals: readonly (readonly [string, Principal])[] = [
          ["the outboxSweep job", systemPrincipal("outboxSweep")],
          ["the semesters job", systemPrincipal("semesters")],
          ["an administrator", ADMIN],
          ["a team leader", leaderOf(1)],
          ["a visitor", anonymous],
        ];

        for (const [who, principal] of principals) {
          const tables = makeTables({ outbox: [pendingRow("a")] });
          const sent: OutboxMessage[] = [];

          const verdict = yield* sweepAs(principal, tables, sent).pipe(
            Effect.match({
              onFailure: (failure) =>
                Predicate.isTagged(failure, "Forbidden")
                  ? "Forbidden"
                  : "another failure",
              onSuccess: (results) =>
                pipe(
                  results,
                  Arr.map((result) => result.outcome),
                  Arr.join(",")
                ),
            })
          );

          const delivered = who === "the outboxSweep job";

          assert.strictEqual(
            verdict,
            delivered ? "delivered" : "Forbidden",
            who
          );
          assert.strictEqual(sent.length, delivered ? 1 : 0, who);
          assert.strictEqual(
            tables.outbox[0]?.status,
            delivered ? "delivered" : "pending",
            who
          );
        }
      })
  );
});
