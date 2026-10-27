/**
 * A small model for the platform's contract tests: one aggregate, a view, a policy, and a projection that writes a
 * store through a port. The same model runs on `Domain.InMemory` and on the PostgreSQL platform, so each test names
 * a behaviour of the `Platform` contract and not a behaviour of the membership domain.
 */
import * as Domain from "@alchemy.run/domain";
import { Array as Arr, Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

export const CounterId = Schema.String.pipe(Schema.brand("CounterId"));

/** Past this total a counter refuses to grow. */
export const LIMIT = 10;

export class Incremented extends Domain.Event("Incremented", {
  by: Schema.Int,
  total: Schema.Int,
}) {}

export class Capped extends Domain.Rejection("Capped", {
  limit: Schema.Int,
}) {}

/** A fact that no rule can refuse, so it can be scheduled (only commands that never reject can). */
export class Decayed extends Domain.Event("Decayed", {
  by: Schema.Int,
  total: Schema.Int,
}) {}

export class Increment extends Domain.Command("Increment", {
  events: [Incremented],
  input: { by: Schema.Int },
  rejects: [Capped],
  reply: { total: Schema.Int },
  target: CounterId,
}) {}

export class Decay extends Domain.Command("Decay", {
  events: [Decayed],
  input: { by: Schema.Int },
  target: CounterId,
}) {}

export class Counter extends Domain.Aggregate("Counter", {
  commands: [Increment, Decay],
  decide: {
    Decay: (state, command) => [
      new Decayed({
        by: command.by,
        total: Math.max(0, state.total - command.by),
      }),
    ],
    Increment: (state, command) =>
      state.total + command.by > LIMIT
        ? new Capped({ limit: LIMIT })
        : [
            new Incremented({
              by: command.by,
              total: state.total + command.by,
            }),
          ],
  },
  evolve: {
    Decayed: (_state, event) => ({ total: event.total }),
    Incremented: (_state, event) => ({ total: event.total }),
  },
  id: CounterId,
  initial: { total: 0 },
  reply: { Increment: (state) => ({ total: state.total }) },
  state: Schema.Struct({ total: Schema.Int }),
}) {}

export class CounterView extends Domain.View("CounterView", {
  evolve: {
    Decayed: (_view, event) => ({ total: event.total }),
    Incremented: (_view, event) => ({ total: event.total }),
  },
  from: [Counter],
  initial: { total: 0 },
  key: Counter,
  state: Schema.Struct({ total: Schema.Int }),
}) {}

/** Mirrors each counter into `mirror-<id>`: a reaction that sends a command, with the id the platform makes for it. */
export class Echo extends Domain.Policy("Echo", {
  from: Counter,
  on: [Incremented],
}) {}

export const MIRROR = "mirror-";

export const EchoLive = Echo.toLayer(
  Effect.gen(function* echoLive() {
    const counters = yield* Counter;

    return Effect.fnUntraced(function* echo({ event, source }) {
      if (source.id.startsWith(MIRROR)) {
        return;
      }

      yield* counters
        .send(
          CounterId.make(`${MIRROR}${source.id}`),
          new Increment({ by: event.by })
        )
        .pipe(Effect.catchTag("Capped", () => Effect.void));
    });
  })
);

/** The store a projection writes: a port, so the same projection runs on a map and on a table. */
export class TotalsStore extends Context.Service<
  TotalsStore,
  {
    readonly upsert: (
      rows: readonly {
        readonly id: string;
        readonly seq: number;
        readonly total: number;
      }[]
    ) => Effect.Effect<void>;
    readonly read: (id: string) => Effect.Effect<Option.Option<number>>;
  }
>()("@vektorprogrammet/spike-alchemy-domain/test/TotalsStore") {}

export class CounterTotals extends Domain.Projection("CounterTotals", {
  from: [Counter],
  key: Counter,
  on: [Incremented, Decayed],
}) {}

/** An upsert keyed by the stream and `seq`: a replay writes the same row (what the Domain docs ask of a handler). */
export const CounterTotalsLive = CounterTotals.toLayer(
  Effect.gen(function* counterTotalsLive() {
    const store = yield* TotalsStore;

    return Effect.fnUntraced(function* handle(batch) {
      yield* store.upsert(
        Arr.map(batch, ({ envelope, event, key }) => ({
          id: key.id,
          seq: envelope.seq,
          total: event.total,
        }))
      );
    });
  })
);

export class CounterModel extends Domain.Model("CounterModel", {
  aggregates: [Counter],
  policies: [Echo],
  projections: [CounterTotals],
  views: [CounterView],
}) {}

export const handlers = Layer.mergeAll(EchoLive, CounterTotalsLive);

/** The projection's store as a table. `TotalsStore.upsert` joins the transaction of the `send` that runs it. */
export const SqlTotalsStore = Layer.effect(
  TotalsStore,
  Effect.gen(function* sqlTotalsStore() {
    const sql = yield* SqlClient;

    yield* sql`create table if not exists spike_counter_totals (
      counter_id text primary key,
      total integer not null,
      last_seq integer not null
    )`.pipe(Effect.orDie);

    return TotalsStore.of({
      read: (id) =>
        sql<{
          readonly total: number;
        }>`select total from spike_counter_totals where counter_id = ${id}`.pipe(
          Effect.map((rows) => Option.fromNullishOr(rows[0]?.total)),
          Effect.orDie
        ),
      upsert: (rows) =>
        Effect.forEach(
          rows,
          (row) =>
            sql`insert into spike_counter_totals (counter_id, total, last_seq)
              values (${row.id}, ${row.total}, ${row.seq})
              on conflict (counter_id) do update
                set total = excluded.total, last_seq = excluded.last_seq
                where spike_counter_totals.last_seq < excluded.last_seq`,
          { discard: true }
        ).pipe(Effect.orDie),
    });
  })
);

/** The same port on a map: what `Domain.InMemory` runs the projection against. */
export const MemoryTotalsStore = Layer.sync(TotalsStore, () => {
  const totals = new Map<
    string,
    { readonly seq: number; readonly total: number }
  >();

  return TotalsStore.of({
    read: (id) =>
      Effect.sync(() => Option.fromNullishOr(totals.get(id)?.total)),
    upsert: (rows) =>
      Effect.sync(() => {
        for (const row of rows) {
          if ((totals.get(row.id)?.seq ?? 0) < row.seq) {
            totals.set(row.id, { seq: row.seq, total: row.total });
          }
        }
      }),
  });
});
