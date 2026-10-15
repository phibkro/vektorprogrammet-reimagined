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
  AuditLog,
  Outbox,
  OutboxMessage,
  OutboxMessageId,
  type AuditEntry,
} from "@vektorprogrammet/domain";
import type { NonEmptyReadonlyArray } from "effect/Array";
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { Context, DateTime, Effect, Layer, Order, Array as Arr, Schema } from "effect";
import { Drizzle, decodeWith } from "../internal/drizzle.ts";
import { auditLog, outbox } from "../schema.ts";

/** Proof of a current claim on one outbox row. */
export const OutboxClaimToken = Schema.String.pipe(Schema.brand("OutboxClaimToken"));
export type OutboxClaimToken = typeof OutboxClaimToken.Type;

/** A claimed, due outbox row. */
export const ClaimedOutboxMessage = Schema.Struct({
  id: OutboxMessageId,
  claimToken: OutboxClaimToken,
  /** Claims so far, including this one. */
  attempts: Schema.Int,
  message: OutboxMessage,
  createdAt: Schema.DateTimeUtc,
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
    claimDue(options: {
      readonly limit: number;
      readonly leaseSeconds: number;
      readonly ids?: ReadonlyArray<OutboxMessageId> | undefined;
    }): Effect.Effect<ReadonlyArray<ClaimedOutboxMessage>>;
    markDelivered(id: OutboxMessageId, claimToken: OutboxClaimToken): Effect.Effect<OutboxAck>;
    /** Releases the claim: retried at `next`, or never again when `"dead"`. */
    markFailed(
      id: OutboxMessageId,
      claimToken: OutboxClaimToken,
      error: string,
      next: DateTime.Utc | "dead",
    ): Effect.Effect<OutboxAck>;
  }
>()("@vektorprogrammet/db/OutboxDelivery") {}

const encodeMessage = Schema.encodeEffect(OutboxMessage);
const byId = Order.mapInput(Order.Number, (row: { readonly id: number }) => row.id);

/** Outbox row ids are identity integers; the domain carries them as text. */
const rowId = (id: OutboxMessageId): number => Number(id);

export const OutboxLive = Layer.effect(
  Outbox,
  Effect.gen(function* () {
    const db = yield* Drizzle;

    const enqueue = Effect.fn("Outbox.enqueue")(function* (
      messages: NonEmptyReadonlyArray<OutboxMessage>,
    ) {
      const now = DateTime.toDateUtc(yield* DateTime.now);
      const payloads = yield* Effect.forEach(messages, (message) =>
        Effect.orDie(encodeMessage(message)),
      );
      const rows = yield* db
        .insert(outbox)
        .values(
          payloads.map((payload) => ({
            kind: payload._tag,
            payload,
            nextAttemptAt: now,
            createdAt: now,
          })),
        )
        .returning({ id: outbox.id })
        .pipe(Effect.orDie);
      // Identity values follow the VALUES order, so id order is the caller's order.
      return Arr.sort(rows, byId).map((row) => OutboxMessageId.make(String(row.id)));
    });

    return Outbox.of({ enqueue });
  }),
);

export const OutboxDeliveryLive = Layer.effect(
  OutboxDelivery,
  Effect.gen(function* () {
    const db = yield* Drizzle;
    const decodeClaimed = decodeWith(Schema.Array(ClaimedOutboxMessage));

    const claimDue = Effect.fn("OutboxDelivery.claimDue")(function* (options: {
      readonly limit: number;
      readonly leaseSeconds: number;
      readonly ids?: ReadonlyArray<OutboxMessageId> | undefined;
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
            or(isNull(outbox.claimedUntil), lte(outbox.claimedUntil, nowDate)),
            options.ids === undefined ? undefined : inArray(outbox.id, options.ids.map(rowId)),
          ),
        )
        .orderBy(asc(outbox.id))
        .limit(options.limit)
        .for("update", { skipLocked: true });
      const rows = yield* db
        .update(outbox)
        .set({
          claimToken: sql`gen_random_uuid()`,
          claimedUntil: DateTime.toDateUtc(DateTime.add(now, { seconds: options.leaseSeconds })),
          attempts: sql`${outbox.attempts} + 1`,
        })
        .where(inArray(outbox.id, due))
        .returning({
          id: outbox.id,
          claimToken: outbox.claimToken,
          attempts: outbox.attempts,
          payload: outbox.payload,
          createdAt: outbox.createdAt,
        })
        .pipe(Effect.orDie);
      return yield* decodeClaimed(
        Arr.sort(rows, byId).map((row) => ({
          id: String(row.id),
          claimToken: row.claimToken,
          attempts: row.attempts,
          message: row.payload,
          createdAt: DateTime.fromDateUnsafe(row.createdAt),
        })),
      );
    });

    const release = Effect.fnUntraced(function* (
      id: OutboxMessageId,
      claimToken: OutboxClaimToken,
      changes: Partial<typeof outbox.$inferInsert>,
    ) {
      const rows = yield* db
        .update(outbox)
        .set({ ...changes, claimToken: null, claimedUntil: null })
        .where(
          and(
            eq(outbox.id, rowId(id)),
            eq(outbox.claimToken, claimToken),
            eq(outbox.status, "pending"),
          ),
        )
        .returning({ id: outbox.id })
        .pipe(Effect.orDie);
      const ack: OutboxAck = rows.length === 1 ? "recorded" : "claimLost";
      return ack;
    });

    const markDelivered = Effect.fn("OutboxDelivery.markDelivered")(function* (
      id: OutboxMessageId,
      claimToken: OutboxClaimToken,
    ) {
      const now = yield* DateTime.now;
      return yield* release(id, claimToken, {
        status: "delivered",
        deliveredAt: DateTime.toDateUtc(now),
      });
    });

    const markFailed = Effect.fn("OutboxDelivery.markFailed")(function* (
      id: OutboxMessageId,
      claimToken: OutboxClaimToken,
      error: string,
      next: DateTime.Utc | "dead",
    ) {
      return yield* release(
        id,
        claimToken,
        next === "dead"
          ? { status: "dead", lastError: error }
          : { nextAttemptAt: DateTime.toDateUtc(next), lastError: error },
      );
    });

    return OutboxDelivery.of({ claimDue, markDelivered, markFailed });
  }),
);

export const AuditLogLive = Layer.effect(
  AuditLog,
  Effect.gen(function* () {
    const db = yield* Drizzle;

    const record = Effect.fn("AuditLog.record")(function* (entry: AuditEntry) {
      yield* db
        .insert(auditLog)
        .values({
          action: entry.action,
          actorId: entry.actorId,
          entity: entry.entity,
          entityKey: entry.entityKey,
          at: DateTime.toDateUtc(entry.at),
        })
        .pipe(Effect.orDie);
    });

    return AuditLog.of({ record });
  }),
);
