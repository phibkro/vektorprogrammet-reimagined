/**
 * Transactional outbox (architecture §4) and C12 audit writer.
 *
 * `Outbox.enqueue` and `AuditLog.record` write in the caller's transaction
 * (receipt: committed together with the command's rows). `OutboxDelivery` is
 * the delivery side: at-least-once, claims fenced by a per-row claim token.
 *
 * Delivery contract (FX009):
 * - Ordering: `claimDue` returns due rows in insertion (id) order; there is no
 *   global or per-key ordering guarantee across concurrent claimers.
 * - Claims: `FOR UPDATE SKIP LOCKED` in one `UPDATE … RETURNING`, so two
 *   claimers never receive the same row; a claim expires after `leaseSeconds`.
 * - Fencing: `markDelivered`/`markFailed` change a row only while its claim
 *   token is current; otherwise they report `claimLost` and write nothing.
 * - Attempts and dead letters: `attempts` counts claims; the caller decides the
 *   retry schedule (`markFailed` with the next attempt time) and when a row is
 *   dead (`markFailed` with `"dead"`).
 * - Every timestamp comes from Effect's `Clock`.
 */
import {
  AuditAction,
  AuditLog,
  AuditPrincipal,
  EntityName,
  Outbox,
  OutboxMessage,
  OutboxMessageId,
  PersonId,
  SystemJob,
} from "@vektorprogrammet/domain";
import type { AuditEntry } from "@vektorprogrammet/domain";
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  Context,
  DateTime,
  Effect,
  Layer,
  Match,
  Order,
  Array as Arr,
  pipe,
  Schema,
} from "effect";
import type { NonEmptyReadonlyArray } from "effect/Array";

import { Drizzle, decodeWith } from "../internal/drizzle.ts";
import { auditLog, outbox } from "../schema.ts";

/** Proof of a current claim on one outbox row. */
export const OutboxClaimToken = Schema.String.pipe(
  Schema.brand("OutboxClaimToken")
);

export type OutboxClaimToken = typeof OutboxClaimToken.Type;

/** A claimed, due outbox row. */
export const ClaimedOutboxMessage = Schema.Struct({
  /** Claims so far, including this one. */
  attempts: Schema.Int,
  claimToken: OutboxClaimToken,
  createdAt: Schema.DateTimeUtc,
  id: OutboxMessageId,
  message: OutboxMessage,
});

export type ClaimedOutboxMessage = typeof ClaimedOutboxMessage.Type;

/** `recorded`: the row changed. `claimLost`: the token is no longer current; nothing was written. */
export type OutboxAck = "recorded" | "claimLost";

export class OutboxDelivery extends Context.Service<
  OutboxDelivery,
  {
    /**
     * Claims up to `limit` due rows (pending, due, not under a live claim) for
     * `leaseSeconds`; `ids` restricts the claim to those rows (post-commit delivery).
     */
    readonly claimDue: (options: {
      readonly limit: number;
      readonly leaseSeconds: number;
      readonly ids?: readonly OutboxMessageId[] | undefined;
    }) => Effect.Effect<readonly ClaimedOutboxMessage[]>;
    readonly markDelivered: (
      id: OutboxMessageId,
      claimToken: OutboxClaimToken
    ) => Effect.Effect<OutboxAck>;
    /** Releases the claim: retried at `next`, or never again when `"dead"`. */
    readonly markFailed: (
      id: OutboxMessageId,
      claimToken: OutboxClaimToken,
      error: string,
      next: DateTime.Utc | "dead"
    ) => Effect.Effect<OutboxAck>;
  }
>()("@vektorprogrammet/db/OutboxDelivery") {}

const encodeMessage = Schema.encodeEffect(OutboxMessage);

const byId = Order.mapInput(
  Order.Number,
  (row: { readonly id: number }) => row.id
);

export const OutboxLive = Layer.effect(
  Outbox,
  Effect.gen(function* OutboxLive() {
    const db = yield* Drizzle;

    const enqueue = Effect.fn("Outbox.enqueue")(function* enqueue(
      messages: NonEmptyReadonlyArray<OutboxMessage>
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

    return Outbox.of({ enqueue });
  })
);

export const OutboxDeliveryLive = Layer.effect(
  OutboxDelivery,
  Effect.gen(function* OutboxDeliveryLive() {
    const db = yield* Drizzle;
    const decodeClaimed = decodeWith(Schema.Array(ClaimedOutboxMessage));

    const claimDue = Effect.fn("OutboxDelivery.claimDue")(
      function* claimDue(options: {
        readonly limit: number;
        readonly leaseSeconds: number;
        readonly ids?: readonly OutboxMessageId[] | undefined;
      }) {
        const now = yield* DateTime.now;
        const nowDate = DateTime.toDateUtc(now);

        const due = db
          .select({ id: outbox.id })
          .from(outbox)
          .where(
            and(
              eq(outbox.status, "pending"),
              lte(outbox.nextAttemptAt, nowDate),
              or(
                isNull(outbox.claimedUntil),
                lte(outbox.claimedUntil, nowDate)
              ),
              options.ids === undefined
                ? undefined
                : inArray(outbox.id, pipe(options.ids, Arr.map(Number)))
            )
          )
          .orderBy(asc(outbox.id))
          .limit(options.limit)
          .for("update", { skipLocked: true });

        const rows = yield* db
          .update(outbox)
          .set({
            attempts: sql`${outbox.attempts} + 1`,
            claimToken: sql`gen_random_uuid()`,
            claimedUntil: DateTime.toDateUtc(
              DateTime.add(now, { seconds: options.leaseSeconds })
            ),
          })
          .where(inArray(outbox.id, due))
          .returning({
            attempts: outbox.attempts,
            claimToken: outbox.claimToken,
            createdAt: outbox.createdAt,
            id: outbox.id,
            payload: outbox.payload,
          })
          .pipe(Effect.orDie);

        return yield* decodeClaimed(
          pipe(
            Arr.sort(rows, byId),
            Arr.map((row) => ({
              attempts: row.attempts,
              claimToken: row.claimToken,
              createdAt: DateTime.fromDateUnsafe(row.createdAt),
              id: String(row.id),
              message: row.payload,
            }))
          )
        );
      }
    );

    const release = Effect.fnUntraced(function* release(
      id: OutboxMessageId,
      claimToken: OutboxClaimToken,
      changes: Partial<typeof outbox.$inferInsert>
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
        next: DateTime.Utc | "dead"
      ) {
        return yield* release(
          id,
          claimToken,
          next === "dead"
            ? { lastError: error, status: "dead" }
            : { lastError: error, nextAttemptAt: DateTime.toDateUtc(next) }
        );
      }
    );

    return OutboxDelivery.of({ claimDue, markDelivered, markFailed });
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
  entity: EntityName,
  entityKey: Schema.String,
  personId: Schema.NullOr(PersonId),
  systemJob: Schema.NullOr(SystemJob),
});

const decodeStoredEntry = decodeWith(StoredAuditEntry);

const entryOf = Effect.fnUntraced(function* entryOf(
  row: typeof auditLog.$inferSelect
) {
  const { personId, systemJob, ...stored } = yield* decodeStoredEntry(row);

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
          entity: entry.entity,
          entityKey: entry.entityKey,
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

    return AuditLog.of({ latest, record });
  })
);
