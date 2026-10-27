/**
 * Subject sets (ADR 0001): who a grant names. Each is a pure function of the principal's facts and, for the sets
 * that depend on a department or on a person, of the resource the command is about. A grant row names several
 * sets and holds when any of them does; nothing denies.
 *
 * The sets split by what they read, so a grant row cannot pair a set with a scope it cannot use
 * (`grant.ts` types the pairs):
 * - `Global` sets read only the principal: `Anyone`, `Admin`, `System(job)`;
 * - `Personal` sets compare the principal with the person the resource belongs to: `Self`;
 * - `Departmental` sets read the principal's memberships: `Member`, `Leader`, `Fn(function)`.
 */
import { Array as Arr, Match, Predicate, Schema } from "effect";

import { CodePurpose, codePolicy } from "../accounts/code.ts";
import { SystemJob, TeamFunction } from "./principal.ts";
import type {
  MembershipFact,
  Principal,
  PrincipalResource,
} from "./principal.ts";

/**
 * Where a grant applies (`docs/system/teams.md`): the actor's own records, the departments in which the
 * actor qualifies for the subject set, or everything.
 */
export type Scope = "own" | "department" | "all";

/** What a command is about, as far as permissions go: the department of the record, the person it belongs to. */
export type Resource = PrincipalResource;

export const Any = Schema.TaggedUnion({
  Admin: {},
  Anyone: {},
  Fn: { function: TeamFunction },
  Holder: { purpose: CodePurpose },
  Leader: {},
  Member: {},
  Self: {},
  System: { job: SystemJob },
});

export type Any = typeof Any.Type;

export type Global = Extract<
  Any,
  { readonly _tag: "Admin" | "Anyone" | "System" }
>;

export type Personal = Extract<Any, { readonly _tag: "Holder" | "Self" }>;

export type Departmental = Extract<
  Any,
  { readonly _tag: "Fn" | "Leader" | "Member" }
>;

/** Every caller, also without sign-in. */
export const anyone: Global = Any.cases.Anyone.make({});

/** A person on the admin list whose place has not ended. */
export const admin: Global = Any.cases.Admin.make({});

/** A scheduled job, running as its own principal (R1). */
export const system = (job: SystemJob): Global =>
  Any.cases.System.make({ job });

/** The person that the resource belongs to. */
export const self: Personal = Any.cases.Self.make({});

/** The recipient of a valid single-use code, restricted to its purpose and person. */
export const holder = (purpose: CodePurpose): Personal =>
  Any.cases.Holder.make({ purpose });

/** Has an active membership in a team of the department. */
export const member: Departmental = Any.cases.Member.make({});

/** Has an active membership with the leader flag in a team of the department. */
export const leader: Departmental = Any.cases.Leader.make({});

/** Has an active membership in a team of the department whose function is `teamFunction`. */
export const fn = (teamFunction: TeamFunction): Departmental =>
  Any.cases.Fn.make({ function: teamFunction });

/** `Fn(board, *)`: a member of a board team. */
export const board: Departmental = fn("board");

const inScope =
  (scope: Scope, resource: Resource) =>
  (membership: MembershipFact): boolean =>
    scope === "all" ||
    (scope === "department" &&
      resource.departmentId === membership.departmentId);

const someMembership = (
  principal: Principal,
  scope: Scope,
  resource: Resource,
  test: (membership: MembershipFact) => boolean
): boolean =>
  Predicate.isTagged(principal, "Person") &&
  Arr.some(
    principal.memberships,
    (membership) => test(membership) && inScope(scope, resource)(membership)
  );

/**
 * Whether `subject` holds for `principal` under `scope` and about `resource`. A subject paired with a scope it
 * cannot use never holds, and a department scope without a department on the resource never holds: deny by default.
 */
export const holds = (
  subject: Any,
  scope: Scope,
  principal: Principal,
  resource: Resource
): boolean =>
  Any.match(subject, {
    Admin: () =>
      scope === "all" &&
      Predicate.isTagged(principal, "Person") &&
      principal.adminUntil !== undefined,
    Anyone: () => scope === "all",
    Fn: ({ function: teamFunction }) =>
      someMembership(
        principal,
        scope,
        resource,
        (membership) => membership.function === teamFunction
      ),
    Holder: ({ purpose }) =>
      scope === "own" &&
      Predicate.isTagged(principal, "Person") &&
      resource.personId === principal.personId &&
      Arr.some(
        principal.narrowing ?? [],
        (restriction) =>
          restriction.command === codePolicy[purpose].command &&
          restriction.resource.personId === principal.personId
      ),
    Leader: () =>
      someMembership(
        principal,
        scope,
        resource,
        (membership) => membership.leader
      ),
    Member: () => someMembership(principal, scope, resource, () => true),
    Self: () =>
      scope === "own" &&
      Predicate.isTagged(principal, "Person") &&
      resource.personId === principal.personId,
    System: ({ job }) =>
      scope === "all" &&
      Predicate.isTagged(principal, "System") &&
      principal.job === job,
  });

/** The notation of `docs/system/teams.md`: `Leader(d)`, `Board`, `System(endingSoon)`. */
export const notation = (subject: Any): string =>
  Any.match(subject, {
    Admin: () => "Admin",
    Anyone: () => "Anyone",
    Fn: ({ function: teamFunction }) =>
      teamFunction === "board" ? "Board" : `Fn(${teamFunction}, d)`,
    Holder: ({ purpose }) => `Holder(${purpose})`,
    Leader: () => "Leader(d)",
    Member: () => "Member(d)",
    Self: () => "Self",
    System: ({ job }) => `System(${job})`,
  });

/** Who the subject set is, in words ("You are …" in the generated tables). */
export const label = (subject: Any): string =>
  Match.value(subject).pipe(
    Match.tagsExhaustive({
      Admin: () => "An admin",
      Anyone: () => "Anyone, also without signing in",
      Fn: ({ function: teamFunction }) =>
        teamFunction === "board"
          ? "A member of the board"
          : `A member of a team with the ${teamFunction} function`,
      Holder: ({ purpose }) => `The holder of the ${purpose} code`,
      Leader: () => "A team leader in the department",
      Member: () => "A member of a team in the department",
      Self: () => "The person the record belongs to",
      System: ({ job }) => `The ${job} job`,
    })
  );

/** The definition of each subject set, for the generated reference. The order is the order of the table. */
export const catalog: readonly {
  readonly notation: string;
  readonly definition: string;
}[] = [
  { definition: "Every caller, also without sign-in", notation: "Anyone" },
  {
    definition: "The person that the resource `r` belongs to",
    notation: "Self",
  },
  {
    definition:
      "The holder of a code for purpose `p`, restricted to its command and person",
    notation: "Holder(p)",
  },
  {
    definition: "Has an active membership in a team of department `d`",
    notation: "Member(d)",
  },
  {
    definition:
      "Has an active membership with `leader = true` in a team of `d`",
    notation: "Leader(d)",
  },
  {
    definition:
      "Has an active membership in a team of `d` whose function is `f`",
    notation: "Fn(f, d)",
  },
  {
    definition: "`Fn(board, *)`: has an active membership in a board team",
    notation: "Board",
  },
  {
    definition:
      "Is on the admin list, and the place has not ended (`docs/system/administration.md`)",
    notation: "Admin",
  },
  {
    definition:
      "A scheduled job (`semesters`, `outboxSweep`, `endingSoon`), which runs as its own principal",
    notation: "System(job)",
  },
];
