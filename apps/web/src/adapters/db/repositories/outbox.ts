import { and, asc, desc, eq, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import {
  DateTime,
  Effect,
  Layer,
  Match,
  Option,
  Order,
  Predicate,
  Array as Arr,
  pipe,
  Schema,
} from "effect";
import type { NonEmptyReadonlyArray } from "effect/Array";

import { EntityName, OutboxMessageId, PersonId } from "../../../domain/ids.ts";
import { AuditClient, SystemJob } from "../../../domain/kernel/principal.ts";
import * as OutboxSweep from "../../../domain/outbox/declaration.ts";
import {
  ClaimedOutboxMessage,
  OutboxClaim,
  OutboxClaimToken,
  OutboxDelivery,
} from "../../../domain/outbox/delivery.ts";
import type { OutboxAck } from "../../../domain/outbox/delivery.ts";
import { OutboxMessage } from "../../../domain/outbox/messages.ts";
import { Outbox } from "../../../domain/outbox/outbox.ts";
import type { DeclaredMessage } from "../../../domain/outbox/outbox.ts";
import {
  OutboxOverview,
  OutboxReports,
  OVERVIEW_ROWS,
  deliveryState,
} from "../../../domain/outbox/status.ts";
/**
 * Transactional outbox (architecture §4) and C12 audit writer.
 *
 * `Outbox.enqueue` and `AuditLog.record` write in the caller's transaction
 * (receipt: committed together with the command's rows). `OutboxDeliveryLive`
 * implements the domain's `OutboxDelivery`, whose delivery contract (ordering,
 * claims, fencing, attempts and dead letters, receipts) is stated where the
 * port is declared (`packages/domain/src/outbox/delivery.ts`).
 */
import {
  AuditAction,
  AuditLog,
  AuditPrincipal,
} from "../../../features/audit/domain/auditLog.ts";
import type { AuditEntry } from "../../../features/audit/domain/auditLog.ts";
import { Drizzle, decodeWith } from "../internal/drizzle.ts";
import { verified } from "../live.ts";
import { auditLog, outbox } from "../schema.ts";

const encodeMessage = Schema.encodeUnknownEffect(OutboxMessage);

const byId = Order.mapInput(
  Order.Number,
  (row: { readonly id: number }) => row.id
);

export const OutboxLive = Layer.effect(
  Outbox,
  Effect.gen(function* OutboxLive() {
    const db = yield* Drizzle;

    const enqueue = Effect.fn("Outbox.enqueue")(function* enqueue(
      messages: NonEmptyReadonlyArray<DeclaredMessage>
    ) {
      const now = DateTime.toDateUtc(yield* DateTime.now);

      const payloads = yield* Effect.forEach(messages, (message) =>
        Effect.orDie(encodeMessage(message))
      );

      const rows = yield* db
        .insert(outbox)
        .values(
          pipe(
            payloads,
            Arr.map((payload) => ({
              createdAt: now,
              kind: payload._tag,
              nextAttemptAt: now,
              payload,
            }))
          )
        )
        .returning({ id: outbox.id })
        .pipe(Effect.orDie);

      // Identity values follow the VALUES order, so id order is the caller's order.
      return pipe(
        Arr.sort(rows, byId),
        Arr.map((row) => OutboxMessageId.make(String(row.id)))
      );
    });

    return yield* verified("Outbox", Outbox.of({ enqueue }));
  })
);

/** A row that a delivery may take now: this one, still pending, and no live claim holds it. */
const takeable = (id: OutboxMessageId, nowDate: Date) =>
  and(
    eq(outbox.id, Number(id)),
    eq(outbox.status, "pending"),
    or(isNull(outbox.claimedUntil), lte(outbox.claimedUntil, nowDate))
  );

/** Privacy intents must remain recoverable after an arbitrary provider outage. */
const unlimited = sql`${outbox.kind} in (${sql.join(
  Arr.map(OutboxSweep.DeliveryPolicy.unlimitedKinds, (kind) => sql`${kind}`),
  sql`, `
)})`;

export const OutboxDeliveryLive = Layer.effect(
  OutboxDelivery,
  Effect.gen(function* OutboxDeliveryLive() {
    const db = yield* Drizzle;
    const decodeClaimed = Schema.decodeUnknownEffect(ClaimedOutboxMessage);

    /** Why a row could not be taken: it is pending (a live claim holds it, or one has just been released), or it is not. */
    const whyNot = Effect.fnUntraced(function* whyNot(id: OutboxMessageId) {
      const rows = yield* db
        .select({ status: outbox.status })
        .from(outbox)
        .where(eq(outbox.id, Number(id)))
        .pipe(Effect.orDie);

      return rows[0]?.status === "pending"
        ? ("held" as const)
        : ("settled" as const);
    });

    const claim = Effect.fn("OutboxDelivery.claim")(function* claim(
      id: OutboxMessageId,
      leaseSeconds: number
    ) {
      const now = yield* DateTime.now;
      const nowDate = DateTime.toDateUtc(now);

      // A crashed final attempt expires into a terminal failure, not an extra send.
      yield* db
        .update(outbox)
        .set({
          claimToken: null,
          claimedUntil: null,
          lastError: sql`coalesce(${outbox.lastError}, 'delivery lease expired')`,
          status: "dead",
        })
        .where(
          and(
            takeable(id, nowDate),
            lte(outbox.nextAttemptAt, nowDate),
            sql`not (${unlimited})`,
            sql`${outbox.attempts} >= ${OutboxSweep.DeliveryPolicy.attempts}`
          )
        )
        .pipe(Effect.orDie);

      // One conditional UPDATE is the whole claim. A second delivery of the same id waits for the row lock of the first,
      // then re-reads the row (READ COMMITTED), finds a live claim and matches nothing.
      const rows = yield* db
        .update(outbox)
        .set({
          attempts: sql`${outbox.attempts} + 1`,
          claimToken: sql`gen_random_uuid()`,
          claimedUntil: DateTime.toDateUtc(
            DateTime.add(now, { seconds: leaseSeconds })
          ),
        })
        .where(
          and(
            takeable(id, nowDate),
            lte(outbox.nextAttemptAt, nowDate),
            sql`(${unlimited} or ${outbox.attempts} < ${OutboxSweep.DeliveryPolicy.attempts})`
          )
        )
        .returning({
          attempts: outbox.attempts,
          claimToken: outbox.claimToken,
          createdAt: outbox.createdAt,
          id: outbox.id,
          kind: outbox.kind,
          payload: outbox.payload,
        })
        .pipe(Effect.orDie);

      const [row] = rows;

      if (row === undefined) {
        return (yield* whyNot(id)) === "held"
          ? OutboxClaim.cases.Held.make({})
          : OutboxClaim.cases.Settled.make({});
      }

      if (row.claimToken === null) {
        return yield* Effect.die("a claim that was just taken has no token");
      }

      // A payload that no longer decodes (a schema changed without a migration) is a fact about this row, not a defect of
      // the system: the claim is held and handed back as `Undeliverable`, so the caller records a class on the row and
      // the row can end. The decode error is never kept or logged: it can print the payload's values.
      const decoded = yield* Effect.result(
        decodeClaimed({
          attempts: row.attempts,
          claimToken: row.claimToken,
          createdAt: DateTime.fromDateUnsafe(row.createdAt),
          id: String(row.id),
          message: row.payload,
        })
      );

      return Predicate.isTagged(decoded, "Success")
        ? OutboxClaim.cases.Claimed.make({ row: decoded.success })
        : OutboxClaim.cases.Undeliverable.make({
            attempts: row.attempts,
            claimToken: OutboxClaimToken.make(row.claimToken),
            kind: row.kind,
          });
    });

    const release = Effect.fnUntraced(function* release(
      id: OutboxMessageId,
      claimToken: OutboxClaimToken,
      changes: PgUpdateSetSource<typeof outbox>
    ) {
      const rows = yield* db
        .update(outbox)
        .set({ ...changes, claimToken: null, claimedUntil: null })
        .where(
          and(
            eq(outbox.id, Number(id)),
            eq(outbox.claimToken, claimToken),
            eq(outbox.status, "pending")
          )
        )
        .returning({ id: outbox.id })
        .pipe(Effect.orDie);

      const ack: OutboxAck = rows.length === 1 ? "recorded" : "claimLost";

      return ack;
    });

    const markDelivered = Effect.fn("OutboxDelivery.markDelivered")(
      function* markDelivered(
        id: OutboxMessageId,
        claimToken: OutboxClaimToken
      ) {
        const now = yield* DateTime.now;

        return yield* release(id, claimToken, {
          deliveredAt: DateTime.toDateUtc(now),
          status: "delivered",
        });
      }
    );

    const markFailed = Effect.fn("OutboxDelivery.markFailed")(
      function* markFailed(
        id: OutboxMessageId,
        claimToken: OutboxClaimToken,
        error: string,
        next: DateTime.Utc
      ) {
        return yield* release(id, claimToken, {
          lastError: error,
          nextAttemptAt: DateTime.toDateUtc(next),
          status: sql`case when not (${unlimited}) and ${outbox.attempts} >= ${OutboxSweep.DeliveryPolicy.attempts} then 'dead'::outbox_status else 'pending'::outbox_status end`,
        });
      }
    );

    const due = Effect.fn("OutboxDelivery.due")(function* due(options: {
      readonly limit: number;
    }) {
      const nowDate = DateTime.toDateUtc(yield* DateTime.now);

      const rows = yield* db
        .select({ id: outbox.id })
        .from(outbox)
        .where(
          and(
            eq(outbox.status, "pending"),
            or(isNull(outbox.claimedUntil), lte(outbox.claimedUntil, nowDate)),
            lte(outbox.nextAttemptAt, nowDate)
          )
        )
        .orderBy(asc(outbox.id))
        .limit(options.limit)
        .pipe(Effect.orDie);

      return pipe(
        rows,
        Arr.map((row) => OutboxMessageId.make(String(row.id)))
      );
    });

    /**
     * The fence (spec 0024 R9): a row lock that the caller's transaction keeps. `FOR NO KEY UPDATE` is what another
     * consumer's claim (an `UPDATE` of a non-key column) waits for; under READ COMMITTED a claim that committed first
     * makes the `WHERE` find no row, so the answer is `claimLost`.
     */
    const holdClaim = Effect.fn("OutboxDelivery.holdClaim")(function* holdClaim(
      id: OutboxMessageId,
      claimToken: OutboxClaimToken
    ) {
      const rows = yield* db
        .select({ id: outbox.id })
        .from(outbox)
        .where(
          and(
            eq(outbox.id, Number(id)),
            eq(outbox.claimToken, claimToken),
            eq(outbox.status, "pending")
          )
        )
        .for("no key update")
        .pipe(Effect.orDie);

      const ack: OutboxAck = rows.length === 1 ? "recorded" : "claimLost";

      return ack;
    });

    return yield* verified(
      "OutboxDelivery",
      OutboxDelivery.of({
        claim,
        due,
        holdClaim,
        markDelivered,
        markFailed,
      })
    );
  })
);

/**
 * What the Integrations page reads of the outbox (spec 0008b): a count for each status, and the newest rows that are not
 * delivered with their state. Two reads, not one snapshot: the page is a status, and a row that moves between them is
 * shown in either place. It reads the kind, the counters, the times and the class of the last error, never the payload.
 */
export const OutboxReportsLive = Layer.effect(
  OutboxReports,
  Effect.gen(function* OutboxReportsLive() {
    const db = yield* Drizzle;
    const decodeOverview = decodeWith(OutboxOverview);

    const overview = Effect.gen(function* overview() {
      const counted = yield* db
        .select({ n: sql<number>`count(*)::int`, status: outbox.status })
        .from(outbox)
        .groupBy(outbox.status)
        .pipe(Effect.orDie);

      const rows = yield* db
        .select({
          attempts: outbox.attempts,
          id: outbox.id,
          kind: outbox.kind,
          lastError: outbox.lastError,
          nextAttemptAt: outbox.nextAttemptAt,
          status: outbox.status,
        })
        .from(outbox)
        .where(ne(outbox.status, "delivered"))
        .orderBy(desc(outbox.id))
        .limit(OVERVIEW_ROWS)
        .pipe(Effect.orDie);

      const countOf = (status: "pending" | "delivered" | "dead") =>
        Option.match(
          Arr.findFirst(counted, (entry) => entry.status === status),
          { onNone: () => 0, onSome: (entry) => entry.n }
        );

      return yield* decodeOverview({
        counts: {
          delivered: countOf("delivered"),
          failed: countOf("dead"),
          pending: countOf("pending"),
        },
        open: pipe(
          rows,
          Arr.map((row) => ({
            attempts: row.attempts,
            id: String(row.id),
            kind: row.kind,
            lastError: row.lastError,
            nextAttemptAt: DateTime.fromDateUnsafe(row.nextAttemptAt),
            state: deliveryState({
              lastError: row.lastError,
              status: row.status === "dead" ? "dead" : "pending",
            }),
          }))
        ),
      });
    });

    return OutboxReports.of({ overview });
  })
);

/** The audit row's principal columns: a person id or a job name, one of the two. */
const principalColumns = (principal: AuditPrincipal) =>
  Match.value(principal).pipe(
    Match.tagsExhaustive({
      Person: ({ personId }) => ({ personId, systemJob: null }),
      System: ({ job }) => ({ personId: null, systemJob: job }),
    })
  );

/** What `audit_log` stores; the check constraint keeps exactly one of the two principal columns set. */
const StoredAuditEntry = Schema.Struct({
  action: AuditAction,
  at: Schema.DateTimeUtcFromDate,
  client: AuditClient,
  counts: Schema.NullOr(Schema.Record(Schema.String, Schema.Int)),
  entity: EntityName,
  entityKey: Schema.String,
  personId: Schema.NullOr(PersonId),
  sessionId: Schema.NullOr(Schema.NonEmptyString),
  systemJob: Schema.NullOr(SystemJob),
});

const decodeStoredEntry = decodeWith(StoredAuditEntry);

const entryOf = Effect.fnUntraced(function* entryOf(
  row: typeof auditLog.$inferSelect
) {
  const { counts, personId, systemJob, ...decoded } =
    yield* decodeStoredEntry(row);

  // A row that counts nothing has no `counts`, as an entry that was written without them has none.
  const stored = counts === null ? decoded : { ...decoded, counts };

  if (personId !== null) {
    return {
      ...stored,
      principal: AuditPrincipal.cases.Person.make({ personId }),
    };
  }

  if (systemJob !== null) {
    return {
      ...stored,
      principal: AuditPrincipal.cases.System.make({ job: systemJob }),
    };
  }

  return yield* Effect.die("an audit row names neither a person nor a job");
});

export const AuditLogLive = Layer.effect(
  AuditLog,
  Effect.gen(function* AuditLogLive() {
    const db = yield* Drizzle;

    const record = Effect.fn("AuditLog.record")(function* record(
      entry: AuditEntry
    ) {
      yield* db
        .insert(auditLog)
        .values({
          action: entry.action,
          at: DateTime.toDateUtc(entry.at),
          client: entry.client,
          counts: entry.counts ?? null,
          entity: entry.entity,
          entityKey: entry.entityKey,
          sessionId: entry.sessionId,
          ...principalColumns(entry.principal),
        })
        .pipe(Effect.orDie);
    });

    const latest = Effect.fn("AuditLog.latest")(function* latest(
      limit: number
    ) {
      const rows = yield* db
        .select()
        .from(auditLog)
        .orderBy(desc(auditLog.id))
        .limit(limit)
        .pipe(Effect.orDie);

      return yield* Effect.forEach(rows, entryOf);
    });

    return yield* verified("AuditLog", AuditLog.of({ latest, record }));
  })
);
