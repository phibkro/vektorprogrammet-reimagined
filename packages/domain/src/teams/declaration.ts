/**
 * The teams domain as data (spec 0006, `docs/system/teams.md`): the commands of `TeamsRpc`, the Membership machine,
 * and the grants. `tools/docgen` renders the Reference of `teams.md` from this file, so a change here is a change
 * to that page, and `bun run check:docs` fails until it is regenerated.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

import * as Commands from "../kernel/commands.ts";
import * as Domain from "../kernel/domain.ts";
import * as Grant from "../kernel/grant.ts";
import * as Machine from "../kernel/machine.ts";
import { TeamFunction } from "../kernel/principal.ts";
import * as Subject from "../kernel/subject.ts";
import { Semester, SemesterOrder } from "../organisation/semester.ts";
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
import type { MembershipTerm } from "./term.ts";

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
  Commands.Info,
  Commands.info({
    replaces: ["RULE-157", "RULE-321"],
    summary: "Create a team in a department.",
  })
);

export const editTeam = Rpc.make("editTeam", {
  error: DomainErrorSchema,
  payload: { id: TeamId, ...TeamDetails.fields },
  success: Team,
}).annotate(
  Commands.Info,
  Commands.info({
    replaces: ["RULE-157", "RULE-321"],
    summary: "Change a team's name, function and default term.",
  })
);

export const deactivateTeam = Rpc.make("deactivateTeam", {
  error: DomainErrorSchema,
  payload: { id: TeamId },
  success: Team,
}).annotate(
  Commands.Info,
  Commands.info({
    replaces: ["RULE-233", "RULE-329"],
    summary: "Deactivate a team. A team is never deleted.",
  })
);

export const registerPerson = Rpc.make("registerPerson", {
  error: DomainErrorSchema,
  payload: PersonInput,
  success: Person,
}).annotate(
  Commands.Info,
  Commands.info({
    note: "Granted for the department of the chosen field of study.",
    replaces: ["RULE-164"],
    summary:
      "Register a person, with the field of study that gives them a department.",
  })
);

export const addMember = Rpc.make("addMember", {
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
  Commands.Info,
  Commands.info({
    machine: "Membership",
    replaces: ["RULE-164", "RULE-206", "RULE-284"],
    summary:
      "Add a person to a team for a term. The end defaults to the team's default term.",
  })
);

export const extend = Rpc.make("extend", {
  error: DomainErrorSchema,
  payload: { end: Semester, id: MembershipId },
  success: Membership,
}).annotate(
  Commands.Info,
  Commands.info({
    machine: "Membership",
    replaces: ["RULE-234", "RULE-251", "RULE-252"],
    summary: "Extend a membership to a later end semester.",
  })
);

export const change = Rpc.make("change", {
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
  Commands.Info,
  Commands.info({
    machine: "Membership",
    note: "A move to a team in another department also needs the grant in the receiving department, in the same transaction.",
    summary:
      "Change the position, team or leader flag from a semester: the old membership ends and a new one starts.",
  })
);

export const endEarly = Rpc.make("endEarly", {
  error: DomainErrorSchema,
  payload: { id: MembershipId, semester: Semester },
  success: Membership,
}).annotate(
  Commands.Info,
  Commands.info({
    machine: "Membership",
    replaces: ["RULE-298"],
    summary: "End a membership from a semester. A member can end their own.",
  })
);

export const cancel = Rpc.make("cancel", {
  error: DomainErrorSchema,
  payload: { id: MembershipId },
  success: Schema.Void,
}).annotate(
  Commands.Info,
  Commands.info({
    machine: "Membership",
    summary: "Cancel a membership that has not started.",
  })
);

export const grantAdmin = Rpc.make("grantAdmin", {
  error: DomainErrorSchema,
  payload: { personId: PersonId, until: Schema.DateTimeUtcFromString },
  success: AdminGrant,
}).annotate(
  Commands.Info,
  Commands.info({
    note: "Never for oneself.",
    replaces: ["RULE-113", "RULE-308"],
    summary: "Put a person on the admin list until a date.",
  })
);

export const revokeAdmin = Rpc.make("revokeAdmin", {
  error: DomainErrorSchema,
  payload: { id: AdminGrantId },
  success: Schema.Void,
}).annotate(
  Commands.Info,
  Commands.info({
    note: "Never one's own, and never the last place that ends after the current semester.",
    replaces: ["RULE-113", "RULE-308"],
    summary: "Take a place off the admin list.",
  })
);

export const sendEndingSoon = Rpc.make("sendEndingSoon", {
  error: DomainErrorSchema,
  success: Schema.Struct({ sent: Schema.Int }),
}).annotate(
  Commands.Info,
  Commands.info({
    job: "endingSoon",
    summary:
      "Four weeks before the semester ends, e-mail each team leader the memberships of the department that end.",
  })
);

export const TeamsRpc = RpcGroup.make(
  createTeam,
  editTeam,
  deactivateTeam,
  registerPerson,
  addMember,
  extend,
  change,
  endEarly,
  cancel,
  grantAdmin,
  revokeAdmin,
  sendEndingSoon
);

// ---------------------------------------------------------------- the Membership machine

/** What a Membership guard reads: the term the command is about, the current semester, the semester it names. */
export interface MembershipMoment {
  readonly term: MembershipTerm;
  readonly current: Semester;
  /** The new end of `extend`, the first semester without the membership of `endEarly` and `change`, the start of `addMember`. */
  readonly requested: Semester;
}

const after = (left: Semester, right: Semester): boolean =>
  SemesterOrder(left, right) > 0;

const same = (left: Semester, right: Semester): boolean =>
  SemesterOrder(left, right) === 0;

/** `endEarly` and `change` end the old row before `requested`: inside the term, and not in the past. */
const endsBefore = ({ current, requested, term }: MembershipMoment): boolean =>
  after(requested, term.start) &&
  !after(requested, term.end) &&
  !after(current, requested);

export const MembershipMachine = Machine.make({
  calculated: [
    { from: "Planned", to: "Active", when: "the start semester arrives" },
    { from: "Active", to: "Ended", when: "the end semester has passed" },
  ],
  commands: TeamsRpc,
  name: "Membership",
  states: MembershipState,
  transitions: [
    {
      command: "addMember",
      from: [Machine.Boundary],
      guard: ({ current, term }: MembershipMoment) =>
        after(term.start, current),
      to: "Planned",
      when: "later start",
    },
    {
      command: "addMember",
      from: [Machine.Boundary],
      guard: ({ current, term }: MembershipMoment) => same(term.start, current),
      to: "Active",
      when: "start this semester",
    },
    {
      command: "extend",
      from: ["Active"],
      guard: ({ requested, term }: MembershipMoment) =>
        after(requested, term.end),
      to: "Active",
      when: "new end",
    },
    {
      command: "endEarly",
      from: ["Active"],
      guard: endsBefore,
      to: "Ended",
      when: "semester",
    },
    {
      command: "change",
      from: ["Active"],
      guard: endsBefore,
      to: "Ended",
      when: "the old membership",
    },
    {
      command: "change",
      from: [Machine.Boundary],
      guard: ({ current, requested }: MembershipMoment) =>
        after(requested, current),
      to: "Planned",
      when: "the new membership, starting later",
    },
    {
      command: "change",
      from: [Machine.Boundary],
      guard: ({ current, requested }: MembershipMoment) =>
        same(requested, current),
      to: "Active",
      when: "the new membership, starting now",
    },
    { command: "cancel", from: ["Planned"], to: Machine.Boundary },
  ],
});

// ---------------------------------------------------------------- the domain

export const TeamsDomain = Domain.make({
  commands: TeamsRpc,
  grants: [
    Grant.make(
      [Subject.leader, Subject.board],
      [
        "createTeam",
        "editTeam",
        "deactivateTeam",
        "registerPerson",
        "addMember",
        "extend",
        "change",
        "endEarly",
        "cancel",
        "viewPeople",
      ],
      "department"
    ),
    Grant.make([Subject.self], ["endEarly"], "own"),
    Grant.make([Subject.member], ["viewTeams"], "department"),
    Grant.make([Subject.system("endingSoon")], ["sendEndingSoon"], "all"),
  ],
  machines: [MembershipMachine],
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
