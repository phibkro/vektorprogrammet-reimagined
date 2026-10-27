import type * as Aggregate from "@alchemy.run/domain/Aggregate";
/**
 * A PostgreSQL `Platform` for `@alchemy.run/domain` (2.0.0-beta.84): aggregates and projections on the repository's
 * PostgreSQL, with in-memory views and policies. Streams are unsupported.
 *
 * What `AggregateStore.send` does here (the platform contract: single writer per id, dedupe by `commandId`, events,
 * state, receipt and deliveries committed together, then at-least-once ordered delivery):
 *
 * ```
 * BEGIN
 *   insert the instance row if absent                       (alchemy_aggregate)
 *   SELECT … FOR NO KEY UPDATE                              the one writer; a different id never waits
 *   receipt for this commandId?  → return it                dedupe: one decision per commandId
 *   kit.handle(state, command)   → Rejected | Accepted      pure decide + evolve
 *   UPDATE state, version WHERE version = <read>            a second guard behind the lock
 *   INSERT events, receipt, deliveries to views and policies (the outbox)
 *   apply the projections of the events                     same transaction: the SQL read models
 * COMMIT
 * drain the outbox, in order, outside the transaction
 * ```
 *
 * Receipt of `send`: the events are committed and every projection has applied them; consumers other than
 * projections have their delivery rows, and are told after the commit, at least once.
 *
 * Hyperdrive rules (AGENTS.md): row locks inside a transaction only. No advisory lock, no LISTEN/NOTIFY, no session
 * state. The outbox is drained under a lease row with an expiry, not under a lock held across the delivery.
 *
 * `instanceLock` and `versionGuard` exist so that a test can remove each defence and watch the race fail (the
 * negative controls of REPORT.md). Production would not expose them.
 */
import * as InMemory from "@alchemy.run/domain/InMemory";
import { Platform } from "@alchemy.run/domain/Platform";
import type {
  Accepted,
  AggregateKit,
  AggregateStore,
  Delivery,
  Json,
  ProjectionKit,
  ProjectionStore,
  SendResult,
  StoredEvent,
} from "@alchemy.run/domain/Platform";
import {
  Array as Arr,
  Clock,
  Context,
  Effect,
  Layer,
  Option,
  Predicate,
  Record as Rec,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { SqlSchema } from "effect/sql";
import { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { migrate } from "./ddl.ts";
import { StaleInstance } from "./errors.ts";
import {
  CheckpointRow,
  DeliveryRow,
  InstanceRow,
  PendingInstance,
  ScheduledRow,
  SendResultSchema,
  StateRow,
  StoredEventSchema,
  checkpointsOf,
  toJsonText,
} from "./rows.ts";

// ----------------------------------------------------------------------------------------------------- options

export interface PostgresPlatformOptions {
  /** Epoch milliseconds a command is stamped with. Default: the Effect clock. */
  readonly now?: Effect.Effect<number>;
  /** `none` reads the instance without a row lock. A negative control; production is `row`. */
  readonly instanceLock?: "row" | "none";
  /** `false` writes state without the `WHERE version = <read>` condition. A negative control. */
  readonly versionGuard?: boolean;
  /** Runs between reading an instance and deciding on it (a test's barrier for a forced interleaving). */
  readonly afterRead?: (aggregate: string, id: string) => Effect.Effect<void>;
  /** Runs before each delivery of the outbox (a test's way to make a delivery fail or wait). */
  readonly beforeDeliver?: (delivery: Delivery) => Effect.Effect<void>;
  /** Create the Platform's tables when the layer is built. Default `true`. */
  readonly migrate?: boolean;
}

/** What a sweeper, a scheduled job or a test can ask of the platform besides the `Platform` contract. */
export class PostgresPlatformControl extends Context.Service<
  PostgresPlatformControl,
  {
    /** Deliver every undelivered row, in order per instance. What the Worker's scheduled handler would run. */
    readonly sweep: Effect.Effect<number>;
    /** Send every scheduled command that is due on the platform's clock. */
    readonly fireDue: Effect.Effect<number>;
    /** Undelivered outbox rows, for tests and diagnostics. */
    readonly pendingDeliveries: Effect.Effect<number>;
  }
>()("@vektorprogrammet/spike-alchemy-domain/PostgresPlatformControl") {}

interface Settings {
  readonly lockInstance: "row" | "none";
  readonly versionGuard: boolean;
}

/** How long one drain owns an instance's outbox before another may take over (a crashed drain). */
const LEASE_SECONDS = 60;

/** How often a `changes` or `tail` stream reads again. Live reads poll: Hyperdrive has no LISTEN. */
const POLL = "50 millis";

const poll = <A>(read: Effect.Effect<A>) =>
  Stream.fromEffectSchedule(read, Schedule.spaced(POLL));

// ----------------------------------------------------------------------------------------------- instances

/** The statements that read and write one aggregate instance and what it commits with it. */
const makeInstances = (sql: SqlClient, settings: Settings) => {
  const instanceQuery = (aggregate: string, id: string, commandId: string) =>
    settings.lockInstance === "row"
      ? sql`select a.state, a.version, r.result as receipt
          from alchemy_aggregate a
          left join alchemy_receipt r
            on r.aggregate = a.aggregate and r.id = a.id and r.command_id = ${commandId}
          where a.aggregate = ${aggregate} and a.id = ${id}
          for no key update of a`
      : sql`select a.state, a.version, r.result as receipt
          from alchemy_aggregate a
          left join alchemy_receipt r
            on r.aggregate = a.aggregate and r.id = a.id and r.command_id = ${commandId}
          where a.aggregate = ${aggregate} and a.id = ${id}`;

  const readInstance = SqlSchema.findOneOption({
    Request: Schema.Struct({
      aggregate: Schema.String,
      commandId: Schema.String,
      id: Schema.String,
    }),
    Result: InstanceRow,
    execute: ({ aggregate, commandId, id }) =>
      instanceQuery(aggregate, id, commandId),
  });

  /** The instance, locked; created first when it has never been written. */
  const locked = Effect.fnUntraced(function* locked(
    aggregate: string,
    id: string,
    commandId: string
  ) {
    const request = { aggregate, commandId, id };
    const found = yield* readInstance(request);

    if (Option.isSome(found)) {
      return found.value;
    }

    yield* sql`insert into alchemy_aggregate (aggregate, id)
      values (${aggregate}, ${id}) on conflict do nothing`;

    const created = yield* readInstance(request);

    if (Option.isNone(created)) {
      return yield* Effect.die(`${aggregate}/${id} vanished after its insert`);
    }

    return created.value;
  });

  const writeState = Effect.fnUntraced(function* writeState(
    aggregate: string,
    id: string,
    readVersion: number,
    state: Json,
    version: number
  ) {
    const text = yield* toJsonText(state);

    const rows = settings.versionGuard
      ? yield* sql`update alchemy_aggregate set state = ${text}, version = ${version}
          where aggregate = ${aggregate} and id = ${id} and version = ${readVersion}
          returning version`
      : yield* sql`update alchemy_aggregate set state = ${text}, version = ${version}
          where aggregate = ${aggregate} and id = ${id}
          returning version`;

    if (Arr.isReadonlyArrayEmpty(rows)) {
      return yield* Effect.die(
        new StaleInstance({ aggregate, expected: readVersion, id })
      );
    }

    return yield* Effect.void;
  });

  const insertEvents = Effect.fnUntraced(function* insertEvents(
    aggregate: string,
    id: string,
    events: readonly StoredEvent[]
  ) {
    const rows = yield* Effect.forEach(events, (stored) =>
      Effect.all({
        envelope: toJsonText(stored.envelope),
        event: toJsonText(stored.event),
      }).pipe(
        Effect.map((text) => ({
          aggregate,
          envelope: text.envelope,
          event: text.event,
          id,
          seq: stored.envelope.seq,
        }))
      )
    );

    if (Arr.isReadonlyArrayNonEmpty(rows)) {
      yield* sql`insert into alchemy_event ${sql.insert(rows)}`;
    }
  });

  const insertReceipt = Effect.fnUntraced(function* insertReceipt(
    aggregate: string,
    id: string,
    commandId: string,
    sent: SendResult
  ) {
    const text = yield* toJsonText(sent);

    yield* sql`insert into alchemy_receipt (aggregate, id, command_id, result)
      values (${aggregate}, ${id}, ${commandId}, ${text})`;
  });

  const insertDeliveries = Effect.fnUntraced(function* insertDeliveries(
    aggregate: string,
    id: string,
    deliveries: readonly Delivery[]
  ) {
    const rows = yield* Effect.forEach(deliveries, (delivery) =>
      toJsonText(delivery).pipe(
        Effect.map((text) => ({
          aggregate,
          delivery: text,
          id,
          source_seq: delivery.seq,
        }))
      )
    );

    if (Arr.isReadonlyArrayNonEmpty(rows)) {
      yield* sql`insert into alchemy_delivery ${sql.insert(rows)}`;
    }
  });

  return { insertDeliveries, insertEvents, insertReceipt, locked, writeState };
};

// ----------------------------------------------------------------------------------------------- projections

/**
 * Projections run inside the transaction of the `send` that produced their input. A delivery at or below the
 * checkpoint of its source is dropped (at-least-once, replays); the rest run in input order, in batches of the
 * projection's `batch.size`, and the checkpoints move with them. A handler that dies rolls back the whole `send`.
 */
const makeProjections = (
  sql: SqlClient,
  hosted: ReadonlyMap<string, ProjectionKit>
) => {
  const readCheckpoints = SqlSchema.findAll({
    Request: Schema.Struct({ key: Schema.String, projection: Schema.String }),
    Result: CheckpointRow,
    execute: ({ key, projection }) =>
      sql`select source, seq from alchemy_projection_checkpoint
        where projection = ${projection} and key = ${key}`,
  });

  const acceptedSoFar = Effect.fnUntraced(function* acceptedSoFar(
    projection: string,
    key: string,
    count: number
  ) {
    const rows = yield* sql<{
      readonly accepted: number;
    }>`insert into alchemy_projection_key (projection, key, accepted)
      values (${projection}, ${key}, ${count})
      on conflict (projection, key)
      do update set accepted = alchemy_projection_key.accepted + ${count}
      returning accepted`;

    return rows[0]?.accepted ?? count;
  });

  const writeCheckpoints = (
    projection: string,
    key: string,
    batch: readonly Delivery[]
  ) =>
    Effect.forEach(
      Rec.toEntries(Arr.groupBy(batch, (delivery) => delivery.source)),
      ([source, deliveries]) =>
        sql`insert into alchemy_projection_checkpoint (projection, key, source, seq)
          values (${projection}, ${key}, ${source}, ${Math.max(...Arr.map(deliveries, (delivery) => delivery.seq))})
          on conflict (projection, key, source)
          do update set seq = greatest(alchemy_projection_checkpoint.seq, excluded.seq)`,
      { discard: true }
    );

  /** The deliveries of a group that its projection has not handled yet. */
  const unhandled = Effect.fnUntraced(function* unhandled(
    projection: string,
    key: string,
    group: readonly Delivery[]
  ) {
    const checkpoints = checkpointsOf(
      yield* readCheckpoints({ key, projection })
    );

    return Arr.filter(
      group,
      (delivery) => (checkpoints[delivery.source] ?? 0) < delivery.seq
    );
  });

  /** One projection key's deliveries from one `send`, in order. */
  const runGroup = Effect.fnUntraced(function* runGroup(
    group: Arr.NonEmptyReadonlyArray<Delivery>,
    at: number
  ) {
    const [{ key, target }] = group;
    const projection = target.name;
    const kit = hosted.get(projection);

    if (kit === undefined) {
      return yield* Effect.die(
        `projection ${projection} is not hosted on this platform`
      );
    }

    // Serialize each projection key before reading its checkpoints.
    yield* acceptedSoFar(projection, key, 0);
    const fresh = yield* unhandled(projection, key, group);
    const size = kit.options.batch?.size ?? 1;

    const base =
      (yield* acceptedSoFar(projection, key, fresh.length)) - fresh.length;

    yield* Effect.forEach(
      Arr.chunksOf(fresh, size),
      (chunk, index) =>
        kit.run(
          key,
          Arr.map(chunk, (delivery, offset): Accepted => ({
            at,
            delivery,
            position: base + index * size + offset + 1,
          }))
        ),
      { discard: true }
    );

    yield* writeCheckpoints(projection, key, fresh);

    return yield* Effect.void;
  });

  const apply = (deliveries: readonly Delivery[], at: number) =>
    Effect.forEach(
      Rec.values(
        Arr.groupBy(
          deliveries,
          (delivery) => `${delivery.target.name}\u0000${delivery.key}`
        )
      ),
      (group) => runGroup(group, at),
      { discard: true }
    );

  return { apply, readCheckpoints };
};

// ----------------------------------------------------------------------------------------------------- outbox

/**
 * Deliveries to views and policies: a row in the transaction that commits the event, a drain after it. Delivery
 * runs outside any transaction (a delivery may send a command, which opens its own), one drain per instance at a
 * time by lease. A row is marked after its delivery, so a crash in between delivers it again, and consumers drop a
 * duplicate by `(source, seq)`.
 */
const makeOutbox = (
  sql: SqlClient,
  kits: ReadonlyMap<string, AggregateKit>,
  beforeDeliver: PostgresPlatformOptions["beforeDeliver"]
) => {
  const claimLease = (aggregate: string, id: string) =>
    sql`insert into alchemy_delivery_lease (aggregate, id, lease_until)
      values (${aggregate}, ${id}, now() + make_interval(secs => ${LEASE_SECONDS}))
      on conflict (aggregate, id)
      do update set lease_until = excluded.lease_until
        where alchemy_delivery_lease.lease_until < now()
      returning aggregate`.pipe(Effect.map(Arr.isReadonlyArrayNonEmpty));

  const releaseLease = (aggregate: string, id: string) =>
    sql`delete from alchemy_delivery_lease
      where aggregate = ${aggregate} and id = ${id}`.pipe(
      Effect.ignoreCause({ log: true })
    );

  const pending = SqlSchema.findAll({
    Request: Schema.Struct({ aggregate: Schema.String, id: Schema.String }),
    Result: DeliveryRow,
    execute: ({ aggregate, id }) =>
      sql`select position, delivery from alchemy_delivery
        where aggregate = ${aggregate} and id = ${id} and delivered_at is null
        order by position limit 100`,
  });

  const deliverRow = (kit: AggregateKit, row: typeof DeliveryRow.Type) =>
    (beforeDeliver?.(row.delivery) ?? Effect.void).pipe(
      Effect.andThen(kit.deliver(row.delivery)),
      Effect.andThen(
        sql`update alchemy_delivery set delivered_at = now()
          where position = ${row.position}`
      )
    );

  /** Delivers the instance's undelivered rows in order; answers how many it delivered. */
  const drain = Effect.fnUntraced(function* drain(
    aggregate: string,
    id: string
  ) {
    const kit = kits.get(aggregate);

    if (kit === undefined) {
      return 0;
    }

    let total = 0;

    while (yield* claimLease(aggregate, id)) {
      const rows = yield* pending({ aggregate, id });

      yield* Effect.forEach(rows, (row) => deliverRow(kit, row), {
        discard: true,
      }).pipe(Effect.ensuring(releaseLease(aggregate, id)));

      total += rows.length;

      if (Arr.isReadonlyArrayEmpty(rows)) {
        break;
      }
    }

    return total;
  });

  /** A failed delivery never fails a committed command: the rows stay for the sweeper. */
  const drainAfterCommit = (aggregate: string, id: string) =>
    drain(aggregate, id).pipe(
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Effect.logError(
          `delivery of ${aggregate}/${id} failed; the sweeper delivers it again`,
          cause
        )
      )
    );

  const sweep = Effect.gen(function* sweep() {
    const instances = yield* SqlSchema.findAll({
      Request: Schema.Void,
      Result: PendingInstance,
      execute: () =>
        sql`select distinct aggregate, id from alchemy_delivery
          where delivered_at is null order by aggregate, id`,
    })();

    const counts = yield* Effect.forEach(instances, (instance) =>
      drain(instance.aggregate, instance.id)
    );

    return Arr.reduce(counts, 0, (sum, count) => sum + count);
  }).pipe(Effect.orDie);

  const pendingCount = SqlSchema.findOne({
    Request: Schema.Void,
    Result: Schema.Struct({ pending: Schema.Int }),
    execute: () =>
      sql`select count(*)::int as pending from alchemy_delivery where delivered_at is null`,
  })().pipe(
    Effect.map((row) => row.pending),
    Effect.orDie
  );

  return { drainAfterCommit, pendingCount, sweep };
};

// ----------------------------------------------------------------------------------------------------- aggregate

/** What a statement can fail with: the driver, or a row or document that does not decode (both become defects at `send`). */
type StatementError = SqlError | Schema.SchemaError;

/** The statements of one aggregate instance (`makeInstances`). */
interface Instances {
  readonly locked: (
    aggregate: string,
    id: string,
    commandId: string
  ) => Effect.Effect<typeof InstanceRow.Type, StatementError>;
  readonly writeState: (
    aggregate: string,
    id: string,
    readVersion: number,
    state: Json,
    version: number
  ) => Effect.Effect<void, StatementError>;
  readonly insertEvents: (
    aggregate: string,
    id: string,
    events: readonly StoredEvent[]
  ) => Effect.Effect<void, StatementError>;
  readonly insertReceipt: (
    aggregate: string,
    id: string,
    commandId: string,
    sent: SendResult
  ) => Effect.Effect<void, StatementError>;
  readonly insertDeliveries: (
    aggregate: string,
    id: string,
    deliveries: readonly Delivery[]
  ) => Effect.Effect<void, StatementError>;
}

/** The projections that run inside the `send` transaction (`makeProjections`). */
interface Projections {
  readonly apply: (
    deliveries: readonly Delivery[],
    at: number
  ) => Effect.Effect<void, StatementError>;
  readonly readCheckpoints: (request: {
    readonly key: string;
    readonly projection: string;
  }) => Effect.Effect<readonly (typeof CheckpointRow.Type)[], StatementError>;
}

/** Delivery to views and policies after the commit (`makeOutbox`). */
interface Outbox {
  readonly drainAfterCommit: (
    aggregate: string,
    id: string
  ) => Effect.Effect<void>;
}

interface AggregateDeps {
  readonly sql: SqlClient;
  readonly now: Effect.Effect<number>;
  readonly options: PostgresPlatformOptions;
  readonly instances: Instances;
  readonly projections: Projections;
  readonly outbox: Outbox;
}

/** What `persist` writes for an accepted decision, or for a seed. */
interface Persisted {
  readonly id: string;
  readonly readVersion: number;
  readonly state: Json;
  readonly version: number;
  readonly events: readonly StoredEvent[];
  readonly deliveries: readonly Delivery[];
  readonly at: number;
}

const makeAggregateStore = (
  deps: AggregateDeps,
  kit: AggregateKit
): AggregateStore => {
  const { sql, now, options, instances, projections, outbox } = deps;
  const aggregate = kit.name;

  /**
   * Writes what an accepted decision (or a seed) produced. The projections apply in the same transaction, and the
   * outbox is drained when the outermost transaction commits (`afterCommit`): a `send` inside a caller's
   * transaction delivers nothing if that transaction rolls back.
   */
  const persist = Effect.fnUntraced(function* persist(input: Persisted) {
    yield* instances.writeState(
      aggregate,
      input.id,
      input.readVersion,
      input.state,
      input.version
    );
    yield* instances.insertEvents(aggregate, input.id, input.events);

    const toConsumers = Arr.filter(
      input.deliveries,
      (delivery) => delivery.target.kind !== "projection"
    );

    yield* instances.insertDeliveries(aggregate, input.id, toConsumers);

    yield* projections.apply(
      Arr.filter(
        input.deliveries,
        (delivery) => delivery.target.kind === "projection"
      ),
      input.at
    );

    if (Arr.isReadonlyArrayNonEmpty(toConsumers)) {
      yield* sql.afterCommit(outbox.drainAfterCommit(aggregate, input.id));
    }
  });

  /** Decides on the locked instance, and stores the answer with its effects. */
  const decide = Effect.fnUntraced(function* decide(
    id: string,
    command: Json,
    meta: Aggregate.SendMeta,
    found: typeof InstanceRow.Type,
    at: number
  ) {
    const { commandId, context, ...optional } = meta;

    const result = yield* kit.handle({
      command,
      commandId,
      context,
      id,
      now: at,
      state: found.state,
      version: found.version,
      ...optional,
    });

    if (Predicate.isTagged(result, "Rejected")) {
      const rejected = SendResultSchema.cases.Rejected.make({
        rejection: result.rejection,
      });

      yield* instances.insertReceipt(aggregate, id, commandId, rejected);

      return rejected;
    }

    const accepted = SendResultSchema.cases.Accepted.make({
      receipt: {
        events: Arr.map(result.events, (stored) => stored.event),
        reply: result.reply,
        stream: `${aggregate}/${id}`,
        version: result.version,
      },
    });

    yield* persist({
      at,
      deliveries: result.deliveries,
      events: result.events,
      id,
      readVersion: found.version,
      state: result.state,
      version: result.version,
    });
    yield* instances.insertReceipt(aggregate, id, commandId, accepted);

    return accepted;
  });

  const commit = Effect.fnUntraced(function* commit(
    id: string,
    command: Json,
    meta: Aggregate.SendMeta,
    at: number
  ) {
    const found = yield* instances.locked(aggregate, id, meta.commandId);

    if (Predicate.isNotNullish(found.receipt)) {
      return yield* Schema.decodeUnknownEffect(SendResultSchema)(found.receipt);
    }

    yield* options.afterRead?.(aggregate, id) ?? Effect.void;

    return yield* decide(id, command, meta, found, at);
  });

  const send: AggregateStore["send"] = (id, command, meta) =>
    now.pipe(
      Effect.flatMap((at) =>
        sql.withTransaction(commit(id, command, meta, at))
      ),
      Effect.orDie
    );

  const readState = SqlSchema.findOneOption({
    Request: Schema.Struct({ id: Schema.String }),
    Result: StateRow,
    execute: ({ id }) =>
      sql`select state, version from alchemy_aggregate
        where aggregate = ${aggregate} and id = ${id}`,
  });

  const stateOf = (id: string) =>
    readState({ id }).pipe(
      Effect.map(Option.getOrElse(() => ({ state: null, version: 0 }))),
      Effect.orDie
    );

  const readEvents = SqlSchema.findAll({
    Request: Schema.Struct({ after: Schema.Int, id: Schema.String }),
    Result: StoredEventSchema,
    execute: ({ after, id }) =>
      sql`select event, envelope from alchemy_event
        where aggregate = ${aggregate} and id = ${id} and seq > ${after}
        order by seq`,
  });

  const eventsAfter = (id: string, after: number) =>
    readEvents({ after, id }).pipe(Effect.orDie);

  const schedule: AggregateStore["schedule"] = (id, command, meta, due) =>
    Effect.gen(function* scheduling() {
      const at = "at" in due ? due.at : (yield* now) + due.afterMillis;
      const commandText = yield* toJsonText(command);
      const metaText = yield* toJsonText(meta);

      yield* sql`insert into alchemy_scheduled (aggregate, id, command_id, command, meta, due_ms)
        values (${aggregate}, ${id}, ${meta.commandId}, ${commandText}, ${metaText}, ${at})
        on conflict (aggregate, id, command_id)
        do update set command = excluded.command, meta = excluded.meta, due_ms = excluded.due_ms
          where alchemy_scheduled.fired_at is null`;
    }).pipe(Effect.orDie);

  const seed = (id: string, events: readonly Json[]) =>
    now.pipe(
      Effect.flatMap((at) =>
        sql.withTransaction(
          Effect.gen(function* seeding() {
            const found = yield* instances.locked(aggregate, id, "seed");

            const seeded = kit.seed({
              commandId: `seed:${id}:${found.version}`,
              events,
              id,
              now: at,
              state: found.state,
              version: found.version,
            });

            yield* persist({
              at,
              deliveries: seeded.deliveries,
              events: seeded.events,
              id,
              readVersion: found.version,
              state: seeded.state,
              version: seeded.version,
            });
          })
        )
      ),
      Effect.orDie
    );

  const tail: AggregateStore["tail"] = (id, after) =>
    Stream.unwrap(
      Effect.sync(() => {
        let last = after;

        return poll(Effect.suspend(() => eventsAfter(id, last))).pipe(
          Stream.flatMap((events) => {
            last = events.at(-1)?.envelope.seq ?? last;

            return Stream.fromIterable(events);
          })
        );
      })
    );

  return {
    changes: (id) =>
      poll(stateOf(id)).pipe(
        Stream.changesWith((left, right) => left.version === right.version)
      ),
    events: (id) => eventsAfter(id, 0),
    schedule,
    seed,
    send,
    state: stateOf,
    tail,
  };
};

// ---------------------------------------------------------------------------------------------- scheduling

/**
 * Sends each due command through the aggregate's own `send`, then marks it fired. A crash between the two sends
 * it again, and its receipt answers: scheduled commands run at least once and take effect once.
 */
const makeScheduler = (
  sql: SqlClient,
  now: Effect.Effect<number>,
  stores: ReadonlyMap<string, AggregateStore>
) =>
  Effect.gen(function* fireDue() {
    const at = yield* now;

    const due = yield* SqlSchema.findAll({
      Request: Schema.Finite,
      Result: ScheduledRow,
      execute: (cutoff) =>
        sql`select aggregate, id, command_id as "commandId", command, meta
          from alchemy_scheduled
          where fired_at is null and due_ms <= ${cutoff}
          order by due_ms, command_id`,
    })(at);

    yield* Effect.forEach(
      due,
      (row) =>
        Effect.gen(function* fireOne() {
          const store = stores.get(row.aggregate);

          if (store === undefined) {
            return yield* Effect.die(
              new Error(
                `scheduled aggregate ${
                  row.aggregate
                } is not hosted on this platform`
              )
            );
          }

          yield* store.send(row.id, row.command, row.meta);

          yield* sql`update alchemy_scheduled set fired_at = now()
            where aggregate = ${row.aggregate} and id = ${row.id}
              and command_id = ${row.commandId}`;

          return yield* Effect.void;
        }),
      { discard: true }
    );

    return due.length;
  }).pipe(Effect.orDie);

// ---------------------------------------------------------------------------------------------------- platform

/**
 * Builds the `Platform` over a `SqlClient`. Provides `PostgresPlatformControl` too. It provides no `WorkflowEngine`: a
 * model with sagas needs a durable one, and that is not part of this spike.
 */
export const layer = (
  options: PostgresPlatformOptions = {}
): Layer.Layer<Platform | PostgresPlatformControl, never, SqlClient> =>
  Layer.effectContext(
    Effect.gen(function* buildPostgresPlatform() {
      const sql = yield* SqlClient;
      const memory = yield* Layer.build(InMemory.make().layer);
      const inMemory = Context.get(memory, Platform);
      const now = options.now ?? Clock.currentTimeMillis;

      if (options.migrate !== false) {
        yield* migrate.pipe(Effect.orDie);
      }

      // The stores find kits and projections at run time: `Model.build` hosts aggregates before projections.
      const kits = new Map<string, AggregateKit>();
      const stores = new Map<string, AggregateStore>();
      const hostedProjections = new Map<string, ProjectionKit>();

      const instances = makeInstances(sql, {
        lockInstance: options.instanceLock ?? "row",
        versionGuard: options.versionGuard ?? true,
      });

      const projections = makeProjections(sql, hostedProjections);
      const outbox = makeOutbox(sql, kits, options.beforeDeliver);

      const projectionStore = (kit: ProjectionKit): ProjectionStore => ({
        checkpoints: (key) =>
          projections
            .readCheckpoints({ key, projection: kit.name })
            .pipe(Effect.map(checkpointsOf), Effect.orDie),
        receive: (delivery) =>
          now.pipe(
            Effect.flatMap((at) => projections.apply([delivery], at)),
            sql.withTransaction,
            Effect.orDie
          ),
      });

      const platform = Platform.of({
        aggregate: (_definition, kit) =>
          Effect.sync(() => {
            const store = makeAggregateStore(
              { instances, now, options, outbox, projections, sql },
              kit
            );

            kits.set(kit.name, kit);
            stores.set(kit.name, store);

            return store;
          }),
        policy: inMemory.policy,
        projection: (_definition, kit) =>
          Effect.sync(() => {
            hostedProjections.set(kit.name, kit);

            return projectionStore(kit);
          }),
        stream: (definition) =>
          Effect.die(
            new Error(
              `PostgreSQL spike does not support stream ${
                definition.streamName
              }`
            )
          ),
        view: inMemory.view,
      });

      return Context.make(Platform, platform).pipe(
        Context.add(
          PostgresPlatformControl,
          PostgresPlatformControl.of({
            fireDue: makeScheduler(sql, now, stores),
            pendingDeliveries: outbox.pendingCount,
            sweep: outbox.sweep,
          })
        )
      );
    })
  );
