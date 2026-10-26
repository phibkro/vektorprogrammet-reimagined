/**
 * C12 change audit: one row per write, written in the write's transaction. Replaces the legacy Slack-as-audit-log
 * (`DbSubscriber`). Every row records the principal that acted (spec 0006, R1): a person id, or the name of the
 * scheduled job, never both. Session and device fields come with sign-in (spec 0007).
 */
import { Context, DateTime, Effect, Match, Schema } from "effect";

import { SystemJob } from "../kernel/principal.ts";
import type { Principal } from "../kernel/principal.ts";
import { EntityName, PersonId } from "../shared/ids.ts";

export const AuditAction = Schema.Literals([
  "department.created",
  "department.updated",
  "fieldOfStudy.created",
  "fieldOfStudy.updated",
  "socialEvent.created",
  "publicFile.registered",
  "person.registered",
  "team.created",
  "team.updated",
  "team.deactivated",
  "membership.added",
  "membership.extended",
  "membership.changed",
  "membership.endedEarly",
  "membership.cancelled",
  "adminGrant.granted",
  "adminGrant.revoked",
  "endingSoon.sent",
]);

export type AuditAction = typeof AuditAction.Type;

/** Who the row says acted. */
export const AuditPrincipal = Schema.TaggedUnion({
  Person: { personId: PersonId },
  System: { job: SystemJob },
});

export type AuditPrincipal = typeof AuditPrincipal.Type;

export const AuditEntry = Schema.Struct({
  action: AuditAction,
  at: Schema.DateTimeUtc,
  entity: EntityName,
  /** The entity's id or natural key, as text. */
  entityKey: Schema.String,
  principal: AuditPrincipal,
});

export type AuditEntry = typeof AuditEntry.Type;

export class AuditLog extends Context.Service<
  AuditLog,
  {
    /** Inserts one audit row in the current transaction. */
    readonly record: (entry: AuditEntry) => Effect.Effect<void>;
    /** The newest rows first, at most `limit`. */
    readonly latest: (limit: number) => Effect.Effect<readonly AuditEntry[]>;
  }
>()("@vektorprogrammet/domain/audit/AuditLog") {}

/**
 * Records a write of `principal` at the current `Clock` instant. Only a person or a job writes: an anonymous principal
 * holds no grant that writes, so reaching this with one is a bug and a defect.
 */
export const recordAudit = Effect.fnUntraced(function* recordAudit(
  principal: Principal,
  action: AuditAction,
  entity: EntityName,
  entityKey: string | number
) {
  const at = yield* DateTime.now;
  const log = yield* AuditLog;

  const who = yield* Match.value(principal).pipe(
    Match.tagsExhaustive({
      Anonymous: () =>
        Effect.die("an anonymous principal cannot write an audit row"),
      Person: ({ personId }) =>
        Effect.succeed(AuditPrincipal.cases.Person.make({ personId })),
      System: ({ job }) =>
        Effect.succeed(AuditPrincipal.cases.System.make({ job })),
    })
  );

  yield* log.record({
    action,
    at,
    entity,
    entityKey: String(entityKey),
    principal: who,
  });
});
