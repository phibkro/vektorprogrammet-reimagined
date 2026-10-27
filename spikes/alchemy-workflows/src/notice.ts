/**
 * The renewal's notice: the first task of the workflow, a durable fact in PostgreSQL.
 *
 * A renewal is scheduled weeks before its date. The notice records that the person whose membership is to be renewed
 * (and the leaders who may stop it) are to be told, as a row an outbox sweeper would deliver from. It holds
 * identifiers and the renewal date only: the address to mail is looked up by the sweeper at delivery time, never copied
 * here or into the workflow.
 *
 * Guarantee of `queueNotice`: when it returns, the row is committed. `renewal_id` is the primary key and the insert
 * does nothing on conflict, so a retried attempt or a replay after a restart finds the row and reports
 * `created: false`: one notice per renewal. NOTHING IS DELIVERED: no mail is sent and no delivery path is exercised.
 * This slice has no mail transport, and routing the notice through the production outbox would mean declaring a new
 * message kind in the domain, a production edit the spike does not make. The row says "queued", and that is all.
 *
 * The table is the spike's own (`spike_renewal_notice`), created by `migrateNotices`, which the test setup runs
 * explicitly. The Worker does not create tables: a missing one is a loud SQL failure, not a silent assumption.
 */
import { PgClient } from "@effect/sql-pg";
import { DateTime, Effect } from "effect";
import type { Redacted } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { NoticeQueued } from "./renewal.ts";
import type { RenewalInput } from "./renewal.ts";

/** Creates the notice table. Run by the test or admin setup, never by the Worker. */
export const migrateNotices = Effect.gen(function* migrateNotices() {
  const sql = yield* SqlClient;

  yield* sql`create table if not exists spike_renewal_notice (
    renewal_id text primary key,
    person_id integer not null,
    membership_id integer not null,
    due_at timestamptz not null,
    noticed_at timestamptz not null default now()
  )`;
});

/** One small pool for one task attempt: a Hyperdrive connection string is valid for the invocation that read it. */
export const noticeClient = (url: Redacted.Redacted) =>
  PgClient.layer({ maxConnections: 1, multiplex: false, prepare: false, url });

/** Queues the notice of `input`, once. */
export const queueNotice = Effect.fn("renewal.queueNotice")(
  function* queueNotice(input: RenewalInput) {
    const sql = yield* SqlClient;

    const inserted = yield* sql<{ readonly renewalId: string }>`
      insert into spike_renewal_notice (renewal_id, person_id, membership_id, due_at)
      values (${input.renewalId}, ${input.personId}, ${input.membershipId}, ${DateTime.formatIso(input.dueAt)}::timestamptz)
      on conflict (renewal_id) do nothing
      returning renewal_id as "renewalId"`;

    return NoticeQueued.make({
      created: inserted.length === 1,
      renewalId: input.renewalId,
    });
  }
);
