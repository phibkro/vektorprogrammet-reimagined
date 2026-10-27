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

/** One membership that is active this semester, reduced to what the permission algebra reads. */
export const MembershipFact = Schema.Struct({
  departmentId: DepartmentId,
  function: TeamFunction,
  leader: Schema.Boolean,
  teamId: TeamId,
});

export type MembershipFact = typeof MembershipFact.Type;

/**
 * The acting party of one request or job.
 *
 * - `Anonymous`: nobody signed in.
 * - `Person`: the person's memberships that are active this semester, and the latest end of the admin
 *   grants that were valid when the facts were loaded (absent when the person is not an admin).
 * - `System`: a scheduled job.
 */
export const Principal = Schema.TaggedUnion({
  Anonymous: {},
  Person: {
    adminUntil: Schema.optionalKey(Schema.DateTimeUtc),
    memberships: Schema.Array(MembershipFact),
    personId: PersonId,
  },
  System: { job: SystemJob },
});

export type Principal = typeof Principal.Type;

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
