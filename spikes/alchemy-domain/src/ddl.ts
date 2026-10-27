/**
 * The tables of the PostgreSQL Platform, added beside the repository's own migrations (`packages/db/drizzle`).
 *
 * Spike scope: these are plain `create table if not exists` statements that a test applies after the migrated
 * schema, not Drizzle migrations. Nothing here touches a table that `packages/db` owns. The relational tables
 * (`membership`, `admin_grant`, `account`, `person`) stay as they are; the event-sourced aggregates project
 * into them inside the transaction that commits their events (`projections.ts`).
 * The spike keeps names, email and phone only in `alchemy_person_profile`; the id-only `PersonErased` projection deletes
 * that profile row in the same transaction. Membership and administrator history remain pseudonymous.
 *
 * Guarantees the shape gives (the contract of `AggregateStore.send`):
 * - one row per aggregate instance (`alchemy_aggregate`): `send` locks it (`FOR NO KEY UPDATE`), so one instance
 *   has one writer, and different instances never wait for each other;
 * - events, state, version, the receipt and the deliveries commit together or not at all;
 * - `alchemy_receipt` is keyed by `(aggregate, id, command_id)`: a resend finds its first answer;
 * - `alchemy_delivery` is an outbox: a row per consumer that is not a projection, in the order the events were
 *   committed, delivered after the commit and marked when done (at least once);
 * - no advisory lock, no LISTEN/NOTIFY and no session state: Hyperdrive rules (AGENTS.md).
 */
import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

const statements: readonly string[] = [
  `create table if not exists alchemy_aggregate (
     aggregate text not null,
     id text not null,
     version integer not null default 0,
     state jsonb,
     primary key (aggregate, id)
   )`,
  `create table if not exists alchemy_event (
     aggregate text not null,
     id text not null,
     seq integer not null,
     event jsonb not null,
     envelope jsonb not null,
     primary key (aggregate, id, seq),
     foreign key (aggregate, id) references alchemy_aggregate (aggregate, id)
   )`,
  `create table if not exists alchemy_receipt (
     aggregate text not null,
     id text not null,
     command_id text not null,
     result jsonb not null,
     primary key (aggregate, id, command_id),
     foreign key (aggregate, id) references alchemy_aggregate (aggregate, id)
   )`,
  `create table if not exists alchemy_delivery (
     position integer generated always as identity primary key,
     aggregate text not null,
     id text not null,
     source_seq integer not null,
     delivery jsonb not null,
     delivered_at timestamptz,
     foreign key (aggregate, id) references alchemy_aggregate (aggregate, id)
   )`,
  `create index if not exists alchemy_delivery_pending
     on alchemy_delivery (aggregate, id, position) where delivered_at is null`,
  `create table if not exists alchemy_delivery_lease (
     aggregate text not null,
     id text not null,
     lease_until timestamptz not null,
     primary key (aggregate, id)
   )`,
  `create table if not exists alchemy_projection_key (
     projection text not null,
     key text not null,
     accepted integer not null default 0,
     primary key (projection, key)
   )`,
  `create table if not exists alchemy_projection_checkpoint (
     projection text not null,
     key text not null,
     source text not null,
     seq integer not null,
     primary key (projection, key, source)
   )`,
  `create table if not exists alchemy_admin_account (
     person_id integer primary key,
     state text not null
   )`,
  `create table if not exists alchemy_admin_place (
     id integer primary key,
     person_id integer not null,
     granted_by integer,
     until timestamptz not null
   )`,
  `create table if not exists alchemy_scheduled (
     aggregate text not null,
     id text not null,
     command_id text not null,
     command jsonb not null,
     meta jsonb not null,
     due_ms double precision not null,
     fired_at timestamptz,
     primary key (aggregate, id, command_id)
   )`,
  `create table if not exists alchemy_person_profile (
     person_id integer primary key,
     name text not null,
     email text not null,
     phone text not null
   )`,
  `create table if not exists alchemy_consumer_key (
     consumer text not null, key text not null, state jsonb, version integer not null default 0, seq integer not null default 0,
     primary key (consumer, key)
   )`,
  `create table if not exists alchemy_consumer_input (
     position integer generated always as identity primary key, consumer text not null, key text not null, source text not null, seq integer not null, delivery jsonb not null, handled_at timestamptz,
     unique (consumer, key, source, seq), foreign key (consumer, key) references alchemy_consumer_key (consumer, key)
   )`,
  `create index if not exists alchemy_consumer_input_pending on alchemy_consumer_input (consumer, key, position) where handled_at is null`,
  `create table if not exists alchemy_consumer_checkpoint (
     consumer text not null, key text not null, source text not null, seq integer not null,
     primary key (consumer, key, source), foreign key (consumer, key) references alchemy_consumer_key (consumer, key)
   )`,
  `create table if not exists alchemy_view_entry (
     view text not null, key text not null, seq integer not null, event jsonb not null, envelope jsonb not null, state jsonb,
     primary key (view, key, seq)
   )`,
  `create table if not exists alchemy_consumer_outbox (
     position integer generated always as identity primary key, consumer text not null, key text not null, delivery jsonb not null, delivered_at timestamptz
   )`,
  `create index if not exists alchemy_consumer_outbox_pending on alchemy_consumer_outbox (consumer, key, position) where delivered_at is null`,
];

/** Creates the Platform's tables when they are not there. Idempotent; run it after the repository's migrations. */
export const migrate = Effect.gen(function* migrateAlchemyTables() {
  const sql = yield* SqlClient;

  yield* Effect.forEach(statements, (statement) => sql.unsafe(statement), {
    discard: true,
  });
});
