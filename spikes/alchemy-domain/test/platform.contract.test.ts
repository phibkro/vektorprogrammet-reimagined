/**
 * `@alchemy.run/domain` ships no suite for its `Platform` contract (the 2.0.0-beta.84 tarball has `src`, `lib` and
 * `skills` only; the repository's domain tests are Stories on the in-memory platform). These are the behaviours of
 * `AggregateStore.send` and its consumers that a platform has to keep, written once and run on `Domain.InMemory` and
 * on the PostgreSQL platform. What the PostgreSQL platform adds (atomicity with its projections, an outbox that
 * survives a failed delivery, a lock that makes a second sender wait, a stored answer for a rejected command) is in
 * the PostgreSQL-only block, and says so in the titles.
 */
import * as Domain from "@alchemy.run/domain";
import { Internals } from "@alchemy.run/domain/Model";
import { assert, layer } from "@effect/vitest";
import {
  Array as Arr,
  Cause,
  DateTime,
  Effect,
  Exit,
  Layer,
  MutableRef,
  Option,
  Predicate,
  Random,
  Schedule,
} from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { PostgresPlatformControl } from "../src/postgresPlatform.ts";
import {
  Counter,
  CounterId,
  CounterModel,
  CounterTotals,
  CounterView,
  Decay,
  Incremented,
  Increment,
  MIRROR,
  MemoryTotalsStore,
  SqlTotalsStore,
  TotalsStore,
  handlers,
} from "./support/counter.ts";
import type { Capped } from "./support/counter.ts";
import { meetsHeldLock, race } from "./support/race.ts";
import { postgresPlatform } from "./support/world.ts";

// ------------------------------------------------------------------------------------------------ the worlds

/** The clock of the PostgreSQL platform in these tests: a test moves it to make a scheduled command due. */
const clock = MutableRef.make(
  DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-27T12:00:00Z"))
);

const inMemoryWorld = CounterModel.layer(handlers).pipe(
  Layer.provideMerge(Layer.mergeAll(Domain.InMemory, MemoryTotalsStore))
);

/** Delivery of an event to a view or a policy fails once for the counter named `exploding`, and works after that. */
const failedDeliveries = MutableRef.make(0);

const postgresWorld = CounterModel.layer(handlers).pipe(
  Layer.provideMerge(
    SqlTotalsStore.pipe(
      Layer.provideMerge(
        postgresPlatform({
          beforeDeliver: (delivery) =>
            delivery.source === "Counter/exploding" &&
            MutableRef.get(failedDeliveries) === 0
              ? Effect.sync(() => MutableRef.set(failedDeliveries, 1)).pipe(
                  Effect.andThen(Effect.die("a delivery that fails once"))
                )
              : Effect.void,
          now: Effect.sync(() => MutableRef.get(clock)),
        })
      )
    )
  )
);

// ----------------------------------------------------------------------------------------------- the helpers

/** Waits for an effect to satisfy `holds`: the consumers that run after a commit need a moment on every platform. */
const eventually = <A, E, R>(
  read: Effect.Effect<A, E, R>,
  holds: (value: A) => boolean,
  what: string
) =>
  read.pipe(
    Effect.filterOrFail(holds, () => `${what}: not yet`),
    Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 250 }),
    Effect.orDie
  );

const fresh = (tag: string) =>
  Effect.map(Random.nextIntBetween(0, 2 ** 31), (n) =>
    CounterId.make(`${tag}-${n.toString(36)}`)
  );

const aggregateStore = Effect.gen(function* aggregateStore() {
  const internals = yield* Internals;
  const store = internals.aggregates.get("Counter");

  if (store === undefined) {
    return yield* Effect.die("the Counter aggregate is not hosted");
  }

  return { internals, store };
});

const eventsOf = (id: string) =>
  Effect.gen(function* readEvents() {
    const { store } = yield* aggregateStore;

    return store.events === undefined ? [] : yield* store.events(id);
  });

const totalOf = (id: string) =>
  Effect.gen(function* readTotal() {
    return (yield* (yield* Counter).state(CounterId.make(id))).total;
  });

/** Outbox rows of one counter that no consumer has been told about yet. */
const pendingOf = (id: string) =>
  Effect.gen(function* readPending() {
    const sql = yield* SqlClient;

    const rows = yield* sql<{
      readonly count: number;
    }>`select count(*)::int as count
      from alchemy_delivery where aggregate = 'Counter' and id = ${id} and delivered_at is null`;

    return rows[0]?.count ?? 0;
  });

// ------------------------------------------------------------------------------- what every platform keeps

/** What both worlds provide: the services of the model and its port, not the platform's own extras. */
type ContractEnv = Extract<
  Layer.Success<typeof inMemoryWorld>,
  Layer.Success<typeof postgresWorld>
>;

interface Behaviour {
  readonly name: string;
  /** A behaviour fails with a rejection or a timeout that it did not expect, or with an assertion (a defect). */
  readonly body: Effect.Effect<
    void,
    Capped | Domain.ConsistencyTimeout,
    ContractEnv
  >;
}

const behaviours: readonly Behaviour[] = [
  {
    body: Effect.gen(function* acceptedReceipt() {
      const counters = yield* Counter;
      const id = yield* fresh("receipt");

      const receipt = yield* counters.send(id, new Increment({ by: 3 }), {
        commandId: `${id}:1`,
      });

      assert.strictEqual(receipt.stream, `Counter/${id}`);
      assert.strictEqual(receipt.version, 1);
      assert.deepStrictEqual(receipt.reply, { total: 3 });
      assert.deepStrictEqual(
        Arr.map(receipt.events, (event) => event._tag),
        ["Incremented"]
      );
    }),
    name: "an accepted command answers with its receipt: stream, version, events and reply",
  },
  {
    body: Effect.gen(function* rejection() {
      const counters = yield* Counter;
      const id = yield* fresh("rejected");

      const exit = yield* Effect.exit(
        counters.send(id, new Increment({ by: 11 }))
      );

      assert.isTrue(
        Option.exists(Exit.findErrorOption(exit), Predicate.isTagged("Capped")),
        "the command is refused with its declared rejection"
      );
      assert.deepStrictEqual(yield* counters.state(id), { total: 0 });
      assert.strictEqual((yield* eventsOf(id)).length, 0);
    }),
    name: "a rejected command records no event and leaves the state as it was",
  },
  {
    body: Effect.gen(function* duplicate() {
      const counters = yield* Counter;
      const id = yield* fresh("duplicate");

      const first = yield* counters.send(id, new Increment({ by: 3 }), {
        commandId: "same",
      });

      const second = yield* counters.send(id, new Increment({ by: 3 }), {
        commandId: "same",
      });

      assert.strictEqual(second.version, first.version);
      assert.deepStrictEqual(second.reply, first.reply);
      assert.deepStrictEqual(
        yield* counters.state(id),
        { total: 3 },
        "decided once: 3, not 6"
      );
      assert.strictEqual((yield* eventsOf(id)).length, 1);
    }),
    name: "a resent commandId answers with the first receipt and is decided once",
  },
  {
    body: Effect.gen(function* sequence() {
      const counters = yield* Counter;
      const id = yield* fresh("sequence");

      yield* Effect.forEach(
        [1, 2, 3],
        (by) => counters.send(id, new Increment({ by })),
        {
          discard: true,
        }
      );

      assert.deepStrictEqual(
        Arr.map(yield* eventsOf(id), (stored) => stored.envelope.seq),
        [1, 2, 3]
      );
      assert.deepStrictEqual(yield* counters.state(id), { total: 6 });
    }),
    name: "events carry consecutive seq from 1 and the state is their fold",
  },
  {
    body: Effect.gen(function* projection() {
      const counters = yield* Counter;
      const store = yield* TotalsStore;
      const id = yield* fresh("projection");
      const receipt = yield* counters.send(id, new Increment({ by: 4 }));

      yield* CounterTotals.caughtUp(receipt);

      assert.deepStrictEqual(Option.getOrNull(yield* store.read(id)), 4);
    }),
    name: "a projection has handled the events of a command once its receipt is caught up",
  },
  {
    body: Effect.gen(function* view() {
      const counters = yield* Counter;
      const views = yield* CounterView;
      const id = yield* fresh("view");

      yield* Effect.forEach(
        [1, 2, 3],
        (by) => counters.send(id, new Increment({ by })),
        {
          discard: true,
        }
      );

      yield* eventually(
        views.query(Counter.ref(id)),
        Option.exists((state) => state.total === 6),
        "the view folds the three events in order"
      );
    }),
    name: "a view folds a source's events in the order they were committed",
  },
  {
    body: Effect.gen(function* policy() {
      const counters = yield* Counter;
      const id = yield* fresh("policy");

      yield* counters.send(id, new Increment({ by: 2 }));

      yield* eventually(
        totalOf(`${MIRROR}${id}`),
        (total) => total === 2,
        "the policy reacts to the event with a command of its own"
      );
    }),
    name: "a policy reacts after the commit by sending a command",
  },
  {
    body: Effect.gen(function* history() {
      const counters = yield* Counter;
      const views = yield* CounterView;
      const { internals, store } = yield* aggregateStore;
      const id = yield* fresh("history");

      if (store.seed === undefined) {
        return yield* Effect.die("the platform cannot seed events");
      }

      yield* store.seed(id, [
        internals.kernel.encodeEvent(new Incremented({ by: 5, total: 5 })),
      ]);

      yield* eventually(
        views.query(Counter.ref(id)),
        Option.exists((state) => state.total === 5),
        "history reaches the view"
      );
      assert.deepStrictEqual(yield* counters.state(id), { total: 5 });
      yield* Effect.sleep("150 millis");
      assert.strictEqual(
        yield* totalOf(`${MIRROR}${id}`),
        0,
        "history never triggers a policy"
      );

      return yield* Effect.void;
    }),
    name: "seeded history reaches views and never triggers policies",
  },
];

layer(inMemoryWorld, { excludeTestServices: true })(
  "Platform contract on Domain.InMemory",
  (it) => {
    for (const behaviour of behaviours) {
      it.effect(behaviour.name, () => behaviour.body);
    }
  }
);

layer(postgresWorld, { excludeTestServices: true })(
  "Platform contract on PostgreSQL",
  (it) => {
    for (const behaviour of behaviours) {
      it.effect(behaviour.name, () => behaviour.body);
    }
  }
);

// ------------------------------------------------------------------------------------ what only PostgreSQL adds

layer(postgresWorld, { excludeTestServices: true })(
  "PostgreSQL platform only",
  (it) => {
    it.effect(
      "a resent commandId that was rejected gets the same rejection, even when the state would now accept it (no second decision)",
      () =>
        Effect.gen(function* storedRejection() {
          const counters = yield* Counter;
          const id = yield* fresh("stored-rejection");

          yield* counters.send(id, new Increment({ by: 8 }));

          const first = yield* Effect.exit(
            counters.send(id, new Increment({ by: 5 }), {
              commandId: "overdrawn",
            })
          );

          yield* counters.send(id, new Decay({ by: 8 }));

          const again = yield* Effect.exit(
            counters.send(id, new Increment({ by: 5 }), {
              commandId: "overdrawn",
            })
          );

          const other = yield* counters.send(id, new Increment({ by: 5 }), {
            commandId: "overdrawn-again",
          });

          assert.isTrue(
            Option.exists(
              Exit.findErrorOption(first),
              Predicate.isTagged("Capped")
            )
          );
          assert.isTrue(
            Option.exists(
              Exit.findErrorOption(again),
              Predicate.isTagged("Capped")
            ),
            "the answer to a commandId is stored, so a retry gets it back"
          );
          assert.strictEqual(
            other.reply.total,
            5,
            "a new commandId is a new decision and is accepted"
          );
        })
    );

    it.effect(
      "twenty concurrent sends of one commandId commit one event, and every caller gets the same receipt",
      () =>
        Effect.gen(function* concurrentDuplicates() {
          const counters = yield* Counter;
          const id = yield* fresh("concurrent-duplicates");

          const exits = yield* race(
            Arr.makeBy(20, () =>
              counters.send(id, new Increment({ by: 1 }), {
                commandId: "one-decision",
              })
            )
          );

          assert.isTrue(Arr.every(exits, Exit.isSuccess));
          assert.strictEqual((yield* eventsOf(id)).length, 1);
          assert.deepStrictEqual(yield* counters.state(id), { total: 1 });
          assert.strictEqual(
            new Set(
              Arr.map(
                Arr.filter(exits, Exit.isSuccess),
                (exit) => exit.value.version
              )
            ).size,
            1
          );
        })
    );

    it.effect(
      "a send inside a caller's transaction commits and rolls back with it: events, state, projection row, outbox rows and the reactions they would cause",
      () =>
        Effect.gen(function* insideCallersTransaction() {
          const counters = yield* Counter;
          const sql = yield* SqlClient;
          const store = yield* TotalsStore;
          const id = yield* fresh("callers-transaction");

          yield* counters.send(id, new Increment({ by: 3 }));
          yield* eventually(
            totalOf(`${MIRROR}${id}`),
            (total) => total === 3,
            "the first reaction"
          );

          yield* eventually(
            pendingOf(id),
            (pending) => pending === 0,
            "the outbox is drained"
          );

          const rolledBack = yield* Effect.exit(
            sql.withTransaction(
              Effect.gen(function* failingTransaction() {
                const receipt = yield* counters.send(
                  id,
                  new Increment({ by: 2 }),
                  {
                    commandId: "inside-a-failing-transaction",
                  }
                );

                assert.strictEqual(
                  receipt.version,
                  2,
                  "the send itself succeeded"
                );

                return yield* Effect.die(
                  "the surrounding transaction fails after the send"
                );
              })
            )
          );

          assert.isTrue(
            Exit.isFailure(rolledBack) && Cause.hasDies(rolledBack.cause)
          );
          assert.deepStrictEqual(yield* counters.state(id), { total: 3 });
          assert.deepStrictEqual(Option.getOrNull(yield* store.read(id)), 3);
          assert.strictEqual(
            yield* pendingOf(id),
            0,
            "the rolled-back send left no outbox row"
          );

          yield* Effect.sleep("150 millis");
          assert.strictEqual(
            yield* totalOf(`${MIRROR}${id}`),
            3,
            "no consumer was told about an event that never committed"
          );

          yield* sql.withTransaction(
            counters.send(id, new Increment({ by: 2 }), {
              commandId: "inside-a-good-transaction",
            })
          );
          yield* eventually(
            totalOf(`${MIRROR}${id}`),
            (total) => total === 5,
            "the reaction after the outer commit"
          );
        })
    );

    it.effect(
      "a failed delivery does not fail the committed command; its outbox row stays and the sweeper delivers it",
      () =>
        Effect.gen(function* failedDelivery() {
          const counters = yield* Counter;
          const control = yield* PostgresPlatformControl;
          const views = yield* CounterView;

          const receipt = yield* counters.send(
            CounterId.make("exploding"),
            new Increment({ by: 2 })
          );

          assert.strictEqual(receipt.version, 1, "the command committed");
          assert.isAbove(
            yield* pendingOf("exploding"),
            0,
            "the delivery is waiting in the outbox"
          );
          assert.isTrue(
            Option.isNone(yield* views.query(Counter.ref("exploding"))) ||
              Option.exists(
                yield* views.query(Counter.ref("exploding")),
                (state) => state.total === 0
              )
          );

          const delivered = yield* control.sweep;

          assert.isAbove(delivered, 0);
          yield* eventually(
            views.query(Counter.ref("exploding")),
            Option.exists((state) => state.total === 2),
            "the swept delivery reaches the view"
          );
          yield* eventually(
            pendingOf("exploding"),
            (pending) => pending === 0,
            "the outbox row is marked"
          );
        })
    );

    it.effect(
      "a delivery that repeats (a crash after the consumer ran, before the row was marked) reacts once: the policy's command is deduplicated by its receipt",
      () =>
        Effect.gen(function* repeatedDelivery() {
          const counters = yield* Counter;
          const control = yield* PostgresPlatformControl;
          const sql = yield* SqlClient;
          const id = yield* fresh("repeated");

          yield* counters.send(id, new Increment({ by: 2 }));
          yield* eventually(
            totalOf(`${MIRROR}${id}`),
            (total) => total === 2,
            "the first reaction"
          );

          yield* sql`update alchemy_delivery set delivered_at = null where aggregate = 'Counter' and id = ${id}`;
          yield* control.sweep;
          yield* Effect.sleep("200 millis");

          assert.strictEqual(
            yield* totalOf(`${MIRROR}${id}`),
            2,
            "the repeat sent the same command id again, and the mirror decided once"
          );
        })
    );

    it.effect(
      "a second sender waits for the instance's row lock before it writes anything; a sender of another instance does not wait",
      () =>
        Effect.gen(function* rowLock() {
          const counters = yield* Counter;
          const sql = yield* SqlClient;
          const id = yield* fresh("locked");
          const other = yield* fresh("not-locked");

          yield* counters.send(id, new Increment({ by: 1 }));

          const holdsLock = sql`select 1 from alchemy_aggregate
          where aggregate = 'Counter' and id = ${id} for no key update`;

          const waits = yield* meetsHeldLock(
            holdsLock,
            "%alchemy_aggregate%",
            counters.send(id, new Increment({ by: 1 }))
          );

          assert.strictEqual(
            waits.waiting,
            1,
            "the send waits on the held row lock"
          );
          assert.deepStrictEqual(
            waits.wrote,
            [],
            "and has written nothing while it waits"
          );
          assert.isFalse(
            waits.hasTransactionId,
            "it has no transaction id yet either"
          );
          assert.isTrue(
            Exit.isSuccess(waits.exit),
            "after the lock is released it goes through"
          );
          assert.deepStrictEqual(yield* counters.state(id), { total: 2 });

          const passes = yield* meetsHeldLock(
            holdsLock,
            "%alchemy_aggregate%",
            counters.send(other, new Increment({ by: 1 }))
          );

          assert.strictEqual(
            passes.waiting,
            0,
            "a different instance has its own row and does not wait"
          );
          assert.isFalse(passes.stillRunning);
        })
    );

    it.effect(
      "a scheduled command is durable, fires when it is due on the platform's clock, and rescheduling a commandId replaces the pending one",
      () =>
        Effect.gen(function* schedule() {
          const counters = yield* Counter;
          const control = yield* PostgresPlatformControl;
          const id = yield* fresh("scheduled");

          yield* counters.send(id, new Increment({ by: 6 }));

          const start = MutableRef.get(clock);

          yield* counters.schedule(id, new Decay({ by: 1 }), {
            at: DateTime.makeUnsafe(start + 5000),
            commandId: `${id}:tick`,
          });
          yield* counters.schedule(id, new Decay({ by: 4 }), {
            at: DateTime.makeUnsafe(start + 9000),
            commandId: `${id}:tick`,
          });

          assert.strictEqual(yield* control.fireDue, 0, "nothing is due yet");
          MutableRef.set(clock, start + 6000);
          assert.strictEqual(
            yield* control.fireDue,
            0,
            "the first time was replaced by the later one"
          );
          MutableRef.set(clock, start + 10_000);
          assert.strictEqual(yield* control.fireDue, 1);
          assert.deepStrictEqual(
            yield* counters.state(id),
            { total: 2 },
            "the replacement ran: 6 - 4"
          );
          assert.strictEqual(
            yield* control.fireDue,
            0,
            "a fired command does not fire again"
          );
        })
    );
    it.effect(
      "view and policy consumer logs retain committed checkpoints and recovery is idempotent",
      () =>
        Effect.gen(function* consumerRecovery() {
          const counters = yield* Counter;
          const control = yield* PostgresPlatformControl;
          const sql = yield* SqlClient;
          const views = yield* CounterView;
          const id = yield* fresh("consumer-recovery");

          yield* counters.send(id, new Increment({ by: 4 }));
          yield* eventually(
            views.query(Counter.ref(id)),
            Option.exists((state) => state.total === 4),
            "the view applied its input"
          );
          yield* eventually(
            totalOf(`${MIRROR}${id}`),
            (total) => total === 4,
            "the policy committed its command once"
          );

          const rows = yield* sql<{
            readonly consumer: string;
            readonly handled: number;
            readonly total: number;
          }>`
            select consumer, count(*)::int as total, count(*) filter (where handled_at is not null)::int as handled
            from alchemy_consumer_input where delivery->>'source' in (${`Counter/${id}`}, ${`Counter/${MIRROR}${id}`})
            group by consumer order by consumer`;

          const viewLog = Arr.findFirst(
            rows,
            (row) => row.consumer === "view:CounterView"
          );

          const policyLog = Arr.findFirst(
            rows,
            (row) => row.consumer === "policy:Echo"
          );

          assert.deepStrictEqual(
            viewLog,
            Option.some({ consumer: "view:CounterView", handled: 2, total: 2 })
          );
          assert.deepStrictEqual(
            policyLog,
            Option.some({ consumer: "policy:Echo", handled: 2, total: 2 })
          );

          const checkpoints = yield* sql<{
            readonly consumer: string;
            readonly source: string;
            readonly seq: number;
          }>`
            select consumer, source, seq from alchemy_consumer_checkpoint
            where source in (${`Counter/${id}`}, ${`Counter/${MIRROR}${id}`}) order by consumer, source`;

          assert.deepStrictEqual(
            Arr.map(checkpoints, (row) => [row.consumer, row.source, row.seq]),
            [
              ["policy:Echo", `Counter/${id}`, 1],
              ["policy:Echo", `Counter/${MIRROR}${id}`, 1],
              ["view:CounterView", `Counter/${id}`, 1],
              ["view:CounterView", `Counter/${MIRROR}${id}`, 1],
            ]
          );

          yield* control.recover;
          assert.strictEqual((yield* eventsOf(`${MIRROR}${id}`)).length, 1);
          assert.deepStrictEqual(
            yield* views.query(Counter.ref(id)),
            Option.some({ total: 4 })
          );
        })
    );
  }
);

// ----------------------------------------------------------------- a projection that dies

/** The totals store, except that it dies when a counter reaches 7: a read model that fails in the middle of a command. */
const dyingStore = Layer.effect(
  TotalsStore,
  Effect.gen(function* dyingStore() {
    const real = yield* TotalsStore;

    return TotalsStore.of({
      read: real.read,
      upsert: (rows) =>
        Arr.some(rows, (row) => row.total === 7)
          ? Effect.die("the projection fails when a counter reaches 7")
          : real.upsert(rows),
    });
  })
);

const dyingWorld = CounterModel.layer(handlers).pipe(
  Layer.provideMerge(
    dyingStore.pipe(
      Layer.provide(SqlTotalsStore),
      Layer.provideMerge(postgresPlatform())
    )
  )
);

layer(dyingWorld, { excludeTestServices: true })(
  "PostgreSQL platform with a failing projection",
  (it) => {
    it.effect(
      "a projection that dies rolls the command back: no event, no state, no receipt, no outbox row, no read-model row",
      () =>
        Effect.gen(function* dyingProjection() {
          const counters = yield* Counter;
          const sql = yield* SqlClient;
          const store = yield* TotalsStore;
          const id = yield* fresh("dying");

          yield* counters.send(id, new Increment({ by: 3 }), {
            commandId: "three",
          });
          yield* eventually(
            pendingOf(id),
            (pending) => pending === 0,
            "the outbox is drained"
          );

          const exit = yield* Effect.exit(
            counters.send(id, new Increment({ by: 4 }), { commandId: "seven" })
          );

          assert.isTrue(
            Exit.isFailure(exit) && Cause.hasDies(exit.cause),
            "the failure is a defect, not a rejection"
          );
          assert.deepStrictEqual(yield* counters.state(id), { total: 3 });
          assert.strictEqual((yield* eventsOf(id)).length, 1);
          assert.deepStrictEqual(Option.getOrNull(yield* store.read(id)), 3);
          assert.strictEqual(yield* pendingOf(id), 0);

          const receipts = yield* sql<{
            readonly count: number;
          }>`select count(*)::int as count
          from alchemy_receipt where id = ${id} and command_id = 'seven'`;

          assert.strictEqual(
            receipts[0]?.count,
            0,
            "no receipt: a resend decides again"
          );
        })
    );
  }
);
