/**
 * C12 change audit: one row per staff write, written in the write's
 * transaction. Replaces the legacy Slack-as-audit-log (`DbSubscriber`).
 */
import { Context, DateTime, Effect, Schema } from "effect";

import type { Staff } from "../shared/actor.ts";
import { EntityName, UserId } from "../shared/ids.ts";

export const AuditAction = Schema.Literals([
  "department.created",
  "department.updated",
  "fieldOfStudy.created",
  "fieldOfStudy.updated",
  "socialEvent.created",
  "publicFile.registered",
]);

export type AuditAction = typeof AuditAction.Type;

export const AuditEntry = Schema.Struct({
  action: AuditAction,
  actorId: UserId,
  at: Schema.DateTimeUtc,
  entity: EntityName,
  /** The entity's id or natural key, as text. */
  entityKey: Schema.String,
});

export type AuditEntry = typeof AuditEntry.Type;

export class AuditLog extends Context.Service<
  AuditLog,
  {
    /** Inserts one audit row in the current transaction. */
    readonly record: (entry: AuditEntry) => Effect.Effect<void>;
  }
>()("@vektorprogrammet/domain/audit/AuditLog") {}

/** Records a staff write at the current `Clock` instant. */
export const recordAudit = Effect.fnUntraced(function* recordAudit(
  actor: Staff,
  action: AuditAction,
  entity: EntityName,
  entityKey: string | number
) {
  const at = yield* DateTime.now;
  const log = yield* AuditLog;
  yield* log.record({
    action,
    actorId: actor.userId,
    at,
    entity,
    entityKey: String(entityKey),
  });
});
