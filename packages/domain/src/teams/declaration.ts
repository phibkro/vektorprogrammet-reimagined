/**
 * The teams domain as data (spec 0006, `docs/system/teams.md`): the commands of `TeamsRpc`, the Membership machine,
 * and the grants. `tools/docgen` renders the Reference of `teams.md` from this file, so a change here is a change
 * to that page, and `bun run check:docs` fails until it is regenerated.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

import {
  Info,
  board,
  grant,
  info,
  leader,
  member,
  self,
  system,
  make as declareDomain,
} from "../kernel/domain.ts";
import * as Guard from "../kernel/guard.ts";
import * as Machine from "../kernel/machine.ts";
import { TeamFunction } from "../kernel/principal.ts";
import { Semester } from "../organisation/semester.ts";
import { DomainErrorSchema } from "../shared/errors.ts";
import {
  AdminGrantId,
  DepartmentId,
  MembershipId,
  PersonId,
  PositionId,
  TeamId,
} from "../shared/ids.ts";
import { requiredText } from "../shared/validation.ts";
import {
  AdminGrant,
  DefaultTerm,
  Membership,
  Person,
  PersonInput,
  Team,
  TeamDetails,
} from "./entities.ts";
import { MembershipState } from "./term.ts";

// ---------------------------------------------------------------- commands

export const createTeam = Rpc.make("createTeam", {
  error: DomainErrorSchema,
  payload: {
    defaultTerm: DefaultTerm,
    departmentId: DepartmentId,
    function: TeamFunction,
    name: requiredText({ maxLength: 250 }),
  },
  success: Team,
}).annotate(
  Info,
  info({
    method: "create",
    replaces: ["RULE-157", "RULE-321"],
    resource: "Team",
    summary: "Create a team in a department.",
  })
);

export const updateTeam = Rpc.make("updateTeam", {
  error: DomainErrorSchema,
  payload: { id: TeamId, ...TeamDetails.fields },
  success: Team,
}).annotate(
  Info,
  info({
    method: "update",
    replaces: ["RULE-157", "RULE-321"],
    resource: "Team",
    summary: "Change a team's name, function and default term.",
  })
);

export const deactivateTeam = Rpc.make("deactivateTeam", {
  error: DomainErrorSchema,
  payload: { id: TeamId },
  success: Team,
}).annotate(
  Info,
  info({
    method: ":deactivate",
    replaces: ["RULE-233", "RULE-329"],
    resource: "Team",
    summary: "Deactivate a team. A team is never deleted.",
  })
);

export const createPerson = Rpc.make("createPerson", {
  error: DomainErrorSchema,
  payload: PersonInput,
  success: Person,
}).annotate(
  Info,
  info({
    method: "create",
    note: "Granted for the department of the chosen field of study.",
    replaces: ["RULE-164"],
    resource: "Person",
    summary:
      "Register a person, with the field of study that gives them a department.",
  })
);

export const createMembership = Rpc.make("createMembership", {
  error: DomainErrorSchema,
  payload: {
    end: Schema.optionalKey(Semester),
    leader: Schema.Boolean,
    personId: PersonId,
    positionId: PositionId,
    start: Semester,
    teamId: TeamId,
  },
  success: Membership,
}).annotate(
  Info,
  info({
    machine: "Membership",
    method: "create",
    replaces: ["RULE-164", "RULE-206", "RULE-284"],
    resource: "Membership",
    summary:
      "Add a person to a team for a term. The end defaults to the team's default term.",
  })
);

export const extendMembership = Rpc.make("extendMembership", {
  error: DomainErrorSchema,
  payload: { end: Semester, id: MembershipId },
  success: Membership,
}).annotate(
  Info,
  info({
    machine: "Membership",
    method: ":extend",
    replaces: ["RULE-234", "RULE-251", "RULE-252"],
    resource: "Membership",
    summary: "Extend a membership to a later end semester.",
  })
);

export const changeMembership = Rpc.make("changeMembership", {
  error: DomainErrorSchema,
  payload: {
    from: Semester,
    id: MembershipId,
    leader: Schema.optionalKey(Schema.Boolean),
    positionId: Schema.optionalKey(PositionId),
    teamId: Schema.optionalKey(TeamId),
  },
  success: Schema.Struct({ ended: Membership, started: Membership }),
}).annotate(
  Info,
  info({
    machine: "Membership",
    method: ":change",
    note: "A move to a team in another department also needs the grant in the receiving department, in the same transaction.",
    resource: "Membership",
    summary:
      "Change the position, team or leader flag from a semester: the old membership ends and a new one starts.",
  })
);

export const endEarlyMembership = Rpc.make("endEarlyMembership", {
  error: DomainErrorSchema,
  payload: { id: MembershipId, semester: Semester },
  success: Membership,
}).annotate(
  Info,
  info({
    machine: "Membership",
    method: ":endEarly",
    replaces: ["RULE-298"],
    resource: "Membership",
    summary: "End a membership from a semester. A member can end their own.",
  })
);

export const deleteMembership = Rpc.make("deleteMembership", {
  error: DomainErrorSchema,
  payload: { id: MembershipId },
  success: Schema.Void,
}).annotate(
  Info,
  info({
    machine: "Membership",
    method: "delete",
    resource: "Membership",
    summary: "Cancel a membership that has not started.",
  })
);

export const createAdminGrant = Rpc.make("createAdminGrant", {
  error: DomainErrorSchema,
  payload: { personId: PersonId, until: Schema.DateTimeUtcFromString },
  success: AdminGrant,
}).annotate(
  Info,
  info({
    method: "create",
    note: "Never for oneself.",
    replaces: ["RULE-113", "RULE-308"],
    resource: "AdminGrant",
    summary: "Put a person on the admin list until a date.",
  })
);

export const deleteAdminGrant = Rpc.make("deleteAdminGrant", {
  error: DomainErrorSchema,
  payload: { id: AdminGrantId },
  success: Schema.Void,
}).annotate(
  Info,
  info({
    method: "delete",
    note: "Never one's own, and never the last place that ends after the current semester and that an Active account holds.",
    replaces: ["RULE-113", "RULE-308"],
    resource: "AdminGrant",
    summary: "Take a place off the admin list.",
  })
);

export const sendEndingSoon = Rpc.make("sendEndingSoon", {
  error: DomainErrorSchema,
  success: Schema.Struct({ sent: Schema.Int }),
}).annotate(
  Info,
  info({
    job: "endingSoon",
    method: ":sendEndingSoon",
    resource: "Membership",
    summary:
      "Four weeks before the semester ends, e-mail each team leader the memberships of the department that end.",
  })
);

export const TeamsRpc = RpcGroup.make(
  createTeam,
  updateTeam,
  deactivateTeam,
  createPerson,
  createMembership,
  extendMembership,
  changeMembership,
  endEarlyMembership,
  deleteMembership,
  createAdminGrant,
  deleteAdminGrant,
  sendEndingSoon
);

// ---------------------------------------------------------------- the Membership machine

/** The inputs the membership guards read. A term here is the two stored semesters, already validated at entry. */
export const MembershipMoment = Schema.Struct({
  current: Semester,
  requested: Semester,
  term: Schema.Struct({ end: Semester, start: Semester }),
});

export type MembershipMoment = typeof MembershipMoment.Type;

const guard = Guard.semesters(MembershipMoment);

/** End the old row before the requested semester, inside its term and not in the past. */
const endsBefore = Schema.makeFilterGroup([
  guard.after(["requested"], ["term", "start"]),
  guard.not(guard.after(["requested"], ["term", "end"])),
  guard.not(guard.after(["current"], ["requested"])),
]);

export const MembershipMachine = Machine.make({
  // The two changes that time makes. `term.test.ts` ties them to `membershipState`, and the diagram's labels are
  // generated from the guards, so there is no second statement of either condition.
  calculated: [
    {
      from: "Planned",
      guard: guard.not(guard.after(["term", "start"], ["current"])),
      to: "Active",
    },
    {
      from: "Active",
      guard: guard.after(["current"], ["term", "end"]),
      to: "Ended",
    },
  ],
  commands: TeamsRpc,
  context: MembershipMoment,
  fields: [
    { kind: "clock", path: ["current"] },
    { kind: "parameter", path: ["requested"] },
    { kind: "stored", path: ["term", "start"] },
    { kind: "stored", path: ["term", "end"] },
  ],
  name: "Membership",
  states: MembershipState,
  terminal: ["Ended"],
  transitions: [
    {
      command: "createMembership",
      from: [Machine.Boundary],
      guard: guard.after(["term", "start"], ["current"]),
      to: "Planned",
      when: "later start",
    },
    {
      command: "createMembership",
      from: [Machine.Boundary],
      guard: guard.same(["term", "start"], ["current"]),
      to: "Active",
      when: "start this semester",
    },
    {
      command: "extendMembership",
      from: ["Active"],
      guard: guard.after(["requested"], ["term", "end"]),
      to: "Active",
      when: "new end",
    },
    {
      command: "endEarlyMembership",
      from: ["Active"],
      guard: endsBefore,
      to: "Ended",
      when: "semester",
    },
    {
      command: "changeMembership",
      from: ["Active"],
      guard: endsBefore,
      to: "Ended",
      when: "the old membership",
    },
    {
      command: "changeMembership",
      from: [Machine.Boundary],
      guard: guard.after(["requested"], ["current"]),
      to: "Planned",
      when: "the new membership, starting later",
    },
    {
      command: "changeMembership",
      from: [Machine.Boundary],
      guard: guard.same(["requested"], ["current"]),
      to: "Active",
      when: "the new membership, starting now",
    },
    { command: "deleteMembership", from: ["Planned"], to: Machine.Boundary },
  ],
});

// ---------------------------------------------------------------- the domain

export const TeamsDomain = declareDomain({
  commands: TeamsRpc,
  grants: [
    grant(
      [leader, board],
      [
        "createTeam",
        "updateTeam",
        "deactivateTeam",
        "createPerson",
        "createMembership",
        "extendMembership",
        "changeMembership",
        "endEarlyMembership",
        "deleteMembership",
        "viewPeople",
      ],
      "department"
    ),
    grant([self], ["endEarlyMembership"], "own"),
    grant([member], ["viewTeams"], "department"),
    grant([system("endingSoon")], ["sendEndingSoon"], "all"),
  ],
  machines: [MembershipMachine],
  // Only an Active membership grants (ADR 0001, ADR 0002): `term.ts` calculates the state, and effx's model checks that
  // no permission comes from a membership outside it.
  memberships: { grantingStates: ["Active"], machine: "Membership" },
  name: "teams",
  reads: {
    viewPeople: {
      replaces: [],
      summary: "See the people of the department.",
    },
    viewTeams: {
      replaces: [],
      summary: "See the teams of the department and their memberships.",
    },
  },
  title: "Teams and people",
});
