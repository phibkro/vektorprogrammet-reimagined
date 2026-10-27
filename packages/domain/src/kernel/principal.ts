/**
 * Who is acting (spec 0006, R1). `apps/web` loads the principal before the Effect program starts and provides
 * `CurrentPrincipal` per request; a scheduled job runs as its own `System` principal. A person's permissions are
 * pure functions of these facts (`subject.ts`): no role is stored anywhere (ADR 0001).
 */
import { Context, Schema } from "effect";

import { DepartmentId, PersonId, TeamId } from "../shared/ids.ts";

/** What a team is for; it decides what the team's members can do (GLOSSARY "Team function"). */
export const TeamFunction = Schema.Literals([
  "board",
  "economy",
  "it",
  "recruitment",
  "placement",
  "other",
]);

export type TeamFunction = typeof TeamFunction.Type;

/** The scheduled jobs. Each runs as `System(job)`; later slices add their jobs here. */
export const SystemJob = Schema.Literals([
  "semesters",
  "outboxSweep",
  "endingSoon",
]);

export type SystemJob = typeof SystemJob.Type;

/** The kind of client that made a command for audit attribution. */
export const AuditClient = Schema.Literals([
  "browser",
  "server",
  "scheduler",
  "import",
]);

export type AuditClient = typeof AuditClient.Type;

/** One membership that is active this semester, reduced to what the permission algebra reads. */
export const MembershipFact = Schema.Struct({
  departmentId: DepartmentId,
  function: TeamFunction,
  leader: Schema.Boolean,
  teamId: TeamId,
});

export type MembershipFact = typeof MembershipFact.Type;

/** The resource named by a credential restriction. */
export const PrincipalResource = Schema.Struct({
  departmentId: Schema.optionalKey(DepartmentId),
  personId: Schema.optionalKey(PersonId),
});

export type PrincipalResource = typeof PrincipalResource.Type;

/** A credential grants no authority beyond this command and resource. */
export const Narrowing = Schema.Struct({
  command: Schema.String,
  resource: PrincipalResource,
});

export type Narrowing = typeof Narrowing.Type;

/**
 * The acting party of one request or job.
 *
 * - `Anonymous`: nobody signed in.
 * - `Person`: the person's memberships that are active this semester, and the latest end of the admin
 *   grants that were valid when the facts were loaded (absent when the person is not an admin).
 * - `System`: a scheduled job.
 */
const PrincipalSchema = Schema.TaggedUnion({
  Anonymous: {},
  Person: {
    adminUntil: Schema.optionalKey(Schema.DateTimeUtc),
    client: Schema.optionalKey(AuditClient),
    memberships: Schema.Array(MembershipFact),
    narrowing: Schema.optionalKey(Schema.Array(Narrowing)),
    personId: PersonId,
    sessionId: Schema.optionalKey(Schema.NonEmptyString),
  },
  System: { job: SystemJob },
});

/** Restricting an already restricted principal adds a constraint; it never replaces one. */
export const Principal = Object.assign(PrincipalSchema, {
  narrow: (
    principal: Extract<
      typeof PrincipalSchema.Type,
      { readonly _tag: "Person" }
    >,
    restriction: Narrowing
  ) => ({
    ...principal,
    narrowing: [...(principal.narrowing ?? []), restriction],
  }),
});

export type Principal = typeof PrincipalSchema.Type;

export type AnonymousPrincipal = Extract<
  Principal,
  { readonly _tag: "Anonymous" }
>;

export type PersonPrincipal = Extract<Principal, { readonly _tag: "Person" }>;

export type SystemPrincipal = Extract<Principal, { readonly _tag: "System" }>;

export const anonymous: AnonymousPrincipal = Principal.cases.Anonymous.make({});

/** The principal a scheduled job runs as. */
export const systemPrincipal = (job: SystemJob): SystemPrincipal =>
  Principal.cases.System.make({ job });

/** The acting principal for the current request or job. */
export class CurrentPrincipal extends Context.Service<
  CurrentPrincipal,
  Principal
>()("@vektorprogrammet/domain/kernel/CurrentPrincipal") {}
