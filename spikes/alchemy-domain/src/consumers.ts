import type {
  Delivery,
  PolicyKit,
  ViewKit,
  ViewSnapshot,
} from "@alchemy.run/domain/Platform";
import { emptySnapshot } from "@alchemy.run/domain/Platform";
import {
  Array as Arr,
  Context,
  Effect,
  Layer,
  Option,
  Record as Rec,
  Schema,
  Schedule,
  Stream,
} from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { DeliverySchema, EnvelopeSchema, toJsonText } from "./rows.ts";

const POLL = "50 millis";

const InputRow = Schema.Struct({
  delivery: DeliverySchema,
  position: Schema.Int,
});

const CheckpointRow = Schema.Struct({ seq: Schema.Int, source: Schema.String });

const SnapshotRow = Schema.Struct({
  seq: Schema.Int,
  state: Schema.NullOr(Schema.Unknown),
  version: Schema.Int,
});

const EntryRow = Schema.Struct({
  envelope: EnvelopeSchema,
  event: Schema.Unknown,
  seq: Schema.Int,
  state: Schema.NullOr(Schema.Unknown),
});

type Input = typeof InputRow.Type;

type Checkpoint = typeof CheckpointRow.Type;

type Snapshot = typeof SnapshotRow.Type;

type Entry = typeof EntryRow.Type;

const poll = <A>(readValue: Effect.Effect<A>) =>
  Stream.fromEffectSchedule(readValue, Schedule.spaced(POLL));

/** Durable per-key input logs. Admission commits before handling; each fold commits its state, checkpoint,
 * and handler writes together. A crash between admission and handling leaves a recoverable input row. */
const makeConsumers = (sql: SqlClient) => {
  const writeCheckpoint = (consumer: string, key: string, delivery: Delivery) =>
    sql`insert into alchemy_consumer_checkpoint (consumer, key, source, seq)
      values (${consumer}, ${key}, ${delivery.source}, ${delivery.seq})
      on conflict (consumer, key, source)
      do update set seq = greatest(alchemy_consumer_checkpoint.seq, excluded.seq)`;

  const accept = (consumer: string, key: string, delivery: Delivery) =>
    sql.withTransaction(
      Effect.gen(function* acceptDelivery() {
        yield* sql`insert into alchemy_consumer_key (consumer, key)
          values (${consumer}, ${key}) on conflict do nothing`;
        const text = yield* toJsonText(delivery);
        yield* sql`insert into alchemy_consumer_input (consumer, key, source, seq, delivery)
          values (${consumer}, ${key}, ${delivery.source}, ${delivery.seq}, ${text})
          on conflict (consumer, key, source, seq) do nothing`;
      })
    );

  const pendingKeys = (consumer: string) =>
    sql<{
      readonly key: string;
    }>`select distinct key from alchemy_consumer_input
      where consumer = ${consumer} and handled_at is null order by key`;

  const listPending = (consumer: string, key: string) =>
    sql<Input>`select position, delivery from alchemy_consumer_input
      where consumer = ${consumer} and key = ${key} and handled_at is null order by position`;

  const readCheckpoints = (consumer: string, key: string) =>
    sql<Checkpoint>`select source, seq from alchemy_consumer_checkpoint
      where consumer = ${consumer} and key = ${key}`;

  const writeOutbox = (
    consumer: string,
    key: string,
    deliveries: readonly Delivery[]
  ) =>
    Effect.forEach(
      deliveries,
      (delivery) =>
        toJsonText(delivery).pipe(
          Effect.flatMap(
            (
              text
            ) => sql`insert into alchemy_consumer_outbox (consumer, key, delivery)
            values (${consumer}, ${key}, ${text})`
          )
        ),
      { discard: true }
    );

  const drainOutbox = (
    consumer: string,
    key: string,
    deliver: (delivery: Delivery) => Effect.Effect<void>
  ) =>
    Effect.gen(function* drainConsumerOutbox() {
      const rows =
        yield* sql<Input>`select position, delivery from alchemy_consumer_outbox
        where consumer = ${consumer} and key = ${key} and delivered_at is null order by position`;

      for (const row of rows) {
        yield* deliver(row.delivery);
        yield* sql`update alchemy_consumer_outbox set delivered_at = now() where position = ${row.position}`;
      }
    });

  const writeViewEntries = (
    view: string,
    key: string,
    entries: readonly Entry[]
  ) =>
    Effect.forEach(
      entries,
      (entry) =>
        Effect.all({
          envelope: toJsonText(entry.envelope),
          event: toJsonText(entry.event),
          state: toJsonText(entry.state),
        }).pipe(
          Effect.flatMap(
            (
              text
            ) => sql`insert into alchemy_view_entry (view, key, seq, event, envelope, state)
              values (${view}, ${key}, ${entry.seq}, ${text.event}, ${text.envelope}, ${text.state})
              on conflict (view, key, seq) do nothing`
          )
        ),
      { discard: true }
    );

  const applyViewInput = Effect.fnUntraced(function* applyViewInput(
    kit: ViewKit,
    key: string,
    snapshot: ViewSnapshot,
    delivery: Delivery
  ) {
    const {
      snapshot: nextSnapshot,
      entries,
      downstream,
    } = kit.apply(key, snapshot, [delivery]);

    yield* writeViewEntries(kit.name, key, entries);
    yield* writeCheckpoint(`view:${kit.name}`, key, delivery);
    yield* writeOutbox(`view:${kit.name}`, key, downstream);

    return nextSnapshot;
  });

  const makeView = (kit: ViewKit) => {
    const consumer = `view:${kit.name}`;

    const drain = (key: string) =>
      sql
        .withTransaction(
          Effect.gen(function* drainView() {
            yield* sql`insert into alchemy_consumer_key (consumer, key)
            values (${consumer}, ${key}) on conflict do nothing`;

            const rows =
              yield* sql<Snapshot>`select state, version, seq from alchemy_consumer_key
            where consumer = ${consumer} and key = ${key} for update`;

            const [stored] = rows;
            const checkpointRows = yield* readCheckpoints(consumer, key);

            const checkpoints = Rec.fromEntries(
              Arr.map(
                checkpointRows,
                (item) => [item.source, item.seq] as const
              )
            );

            let snapshot: ViewSnapshot = emptySnapshot;

            if (stored !== undefined) {
              snapshot = {
                checkpoints,
                seq: stored.seq,
                state: stored.state,
                version: stored.version,
              };
            }

            const inputs = yield* listPending(consumer, key);

            for (const input of inputs) {
              const { delivery, position } = input;

              if ((snapshot.checkpoints[delivery.source] ?? 0) < delivery.seq) {
                snapshot = yield* applyViewInput(kit, key, snapshot, delivery);
              }

              yield* sql`update alchemy_consumer_input set handled_at = now() where position = ${position}`;
            }

            const state = yield* toJsonText(snapshot.state);
            yield* sql`update alchemy_consumer_key set state = ${state}, version = ${snapshot.version}, seq = ${snapshot.seq}
            where consumer = ${consumer} and key = ${key}`;
          })
        )
        .pipe(Effect.andThen(drainOutbox(consumer, key, kit.deliver)));

    const receive = (key: string, deliveries: readonly Delivery[]) =>
      Effect.forEach(
        deliveries,
        (delivery) => accept(consumer, key, delivery),
        { discard: true }
      ).pipe(Effect.andThen(drain(key)), Effect.orDie);

    const read = (key: string) =>
      sql<Snapshot>`select state, version, seq from alchemy_consumer_key
        where consumer = ${consumer} and key = ${key}`.pipe(
        Effect.flatMap((rows) => {
          const [stored] = rows;

          if (!stored) {
            return Effect.succeed(emptySnapshot);
          }

          return readCheckpoints(consumer, key).pipe(
            Effect.map((checkpointRows) => ({
              ...stored,
              checkpoints: Rec.fromEntries(
                Arr.map(checkpointRows, (row) => [row.source, row.seq] as const)
              ),
            }))
          );
        }),
        Effect.orDie
      );

    const entries = (key: string) =>
      sql<Entry>`select seq, event, envelope, state from alchemy_view_entry
        where view = ${kit.name} and key = ${key} order by seq`.pipe(
        Effect.orDie
      );

    const recover = Effect.gen(function* recoverViews() {
      const keys = yield* pendingKeys(consumer);

      for (const { key } of keys) {
        yield* drain(key);
      }

      const outbox = yield* sql<{
        readonly key: string;
      }>`select distinct key from alchemy_consumer_outbox
        where consumer = ${consumer} and delivered_at is null order by key`;

      for (const { key } of outbox) {
        yield* drainOutbox(consumer, key, kit.deliver);
      }
    }).pipe(Effect.orDie);

    return {
      changes: (key: string) => poll(read(key)),
      list: (key: string) => entries(key),
      read,
      receive,
      recover,
      tail: (key: string, after: number) =>
        Stream.unwrap(
          Effect.sync(() => {
            let last = after;

            return poll(entries(key)).pipe(
              Stream.flatMap((rows) => {
                const fresh = Arr.filter(rows, (row) => row.seq > last);
                const newest = Arr.last(fresh);

                if (Option.isSome(newest)) {
                  last = newest.value.seq;
                }

                return Stream.fromIterable(fresh);
              })
            );
          })
        ),
    };
  };

  const makePolicy = (kit: PolicyKit) => {
    const consumer = `policy:${kit.name}`;

    const drain = (key: string) =>
      sql.withTransaction(
        Effect.gen(function* drainPolicy() {
          yield* sql`insert into alchemy_consumer_key (consumer, key)
            values (${consumer}, ${key}) on conflict do nothing`;
          yield* sql`select 1 from alchemy_consumer_key where consumer = ${consumer} and key = ${key} for update`;
          const inputs = yield* listPending(consumer, key);
          const checkpointRows = yield* readCheckpoints(consumer, key);

          const checkpoints = Rec.fromEntries(
            Arr.map(checkpointRows, (item) => [item.source, item.seq] as const)
          );

          for (const input of inputs) {
            const { delivery } = input;

            if ((checkpoints[delivery.source] ?? 0) < delivery.seq) {
              yield* kit.run(delivery);
              yield* writeCheckpoint(consumer, key, delivery);
              checkpoints[delivery.source] = Math.max(
                checkpoints[delivery.source] ?? 0,
                delivery.seq
              );
            }

            yield* sql`update alchemy_consumer_input set handled_at = now() where position = ${input.position}`;
          }
        })
      );

    const receive = (delivery: Delivery) =>
      accept(consumer, delivery.key, delivery).pipe(
        Effect.andThen(drain(delivery.key)),
        Effect.orDie
      );

    const recover = Effect.gen(function* recoverPolicies() {
      const keys = yield* pendingKeys(consumer);

      for (const { key } of keys) {
        yield* drain(key);
      }
    }).pipe(Effect.orDie);

    return { receive, recover };
  };

  return { makePolicy, makeView };
};

export class Consumers extends Context.Service<
  Consumers,
  ReturnType<typeof makeConsumers>
>()("@vektorprogrammet/spike-alchemy-domain/Consumers") {
  static readonly layer = Layer.effect(
    Consumers,
    Effect.gen(function* consumersLayer() {
      return Consumers.of(makeConsumers(yield* SqlClient));
    })
  );
}
