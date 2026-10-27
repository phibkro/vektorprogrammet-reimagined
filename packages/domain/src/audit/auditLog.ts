/**
 * C12 change audit: one row per write, written in the write's transaction. Replaces the legacy Slack-as-audit-log
 * (`DbSubscriber`). Every row records the principal that acted (spec 0006, R1): a person id, or the name of the
 * scheduled job, never both. Session and client fields come with sign-in (spec 0007).
 */
import { Context, DateTime, Effect, Match, Predicate, Schema } from "effect";

import { AuditClient, SystemJob } from "../kernel/principal.ts";
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
  "person.profileUpdated",
  "account.invited",
  "account.activated",
  "account.deactivated",
  "account.reactivated",
  "account.passwordReset",
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
  "consent.given",
  "consent.withdrawn",
  "person.exported",
  "person.erased",
  "person.merged",
  "person.photoSet",
  "person.photoRemoved",
  "alumni.requested",
  "retention.ran",
  "retention.reported",
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
  client: AuditClient,
  /** Integer counts of what a retention run removed or anonymised, per table: never a value (spec 0007b). */
  counts: Schema.optionalKey(Schema.Record(Schema.String, Schema.Int)),
  entity: EntityName,
  /** The entity's id or natural key, as text. */
  entityKey: Schema.String,
  principal: AuditPrincipal,
  sessionId: Schema.NullOr(Schema.NonEmptyString),
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
 * holds no grant that writes, so reaching this with one is a bug and a defect. A retention run passes its integer
 * `counts`, which are numbers and never values.
 */
export const recordAudit = Effect.fnUntraced(function* recordAudit(
  principal: Principal,
  action: AuditAction,
  entity: EntityName,
  entityKey: string | number,
  counts?: Readonly<Record<string, number>>
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

  const entry: AuditEntry = {
    action,
    at,
    client: Predicate.isTagged(principal, "Person")
      ? (principal.client ?? "server")
      : "scheduler",
    entity,
    entityKey: String(entityKey),
    principal: who,
    sessionId: Predicate.isTagged(principal, "Person")
      ? (principal.sessionId ?? null)
      : null,
  };

  yield* log.record(counts === undefined ? entry : { ...entry, counts });
});
