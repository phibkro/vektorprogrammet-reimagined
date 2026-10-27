/**
 * The Person aggregate: one person's memberships, decided together. It is the kernel's Person root of spec 0006b,
 * as an event-sourced aggregate: the commands that `packages/db` runs under `AggregateLocks.lock("Person", id)` are
 * decided here on the instance's own state, and the platform's row lock on the instance is the lock.
 *
 * The rules are the kernel's, not new ones: the Membership machine (`Teams.MembershipMachine`) says which command may
 * start from which state, the term arithmetic is `teams/term.ts`, and a membership never overlaps another of the same
 * person in the same team (`membership_no_overlap` in the database, decided here on the state).
 *
 * Events carry ids and terms, never a name, an e-mail address or any other personal value: the personal data of a
 * person stays in the `person` row, which an erasure can overwrite (`erasure.ts`).
 */
import * as Domain from "@alchemy.run/domain";
import type { DecideContext } from "@alchemy.run/domain/Aggregate";
import {
  MEMBERSHIP_OVERLAPS,
  Machine,
  MembershipId,
  PositionId,
  Semester,
  TeamId,
  Teams,
  defaultEnd,
  isBeforeSemester,
  membershipState,
  previousSemester,
  semesterOrdinal,
} from "@vektorprogrammet/domain";
import { Array as Arr, Effect, Option, Schema } from "effect";

import { semesterForDate } from "./calendar.ts";
import { CommandFacts } from "./context.ts";
import { GrantGuard, requireGrant } from "./guard.ts";
import { PersonKey } from "./ids.ts";
import type { PersonKeyValue } from "./ids.ts";
import {
  AlreadyExists,
  Conflict,
  Forbidden,
  NotFound,
  ValidationFailed,
  invalid,
} from "./rejections.ts";

// ------------------------------------------------------------------------------------------------- state

export const StoredMembershipSchema = Schema.Struct({
  end: Semester,
  id: MembershipId,
  leader: Schema.Boolean,
  positionId: PositionId,
  start: Semester,
  teamId: TeamId,
});

export type StoredMembershipValue = typeof StoredMembershipSchema.Type;

export const PersonStateSchema = Schema.Struct({
  memberships: Schema.Array(StoredMembershipSchema),
});

export type PersonStateValue = typeof PersonStateSchema.Type;

// ------------------------------------------------------------------------------------------------ events

export class MembershipAdded extends Domain.Event("MembershipAdded", {
  end: Semester,
  id: MembershipId,
  leader: Schema.Boolean,
  positionId: PositionId,
  start: Semester,
  teamId: TeamId,
}) {}

export class MembershipExtended extends Domain.Event("MembershipExtended", {
  end: Semester,
  id: MembershipId,
}) {}

export class MembershipEndedEarly extends Domain.Event("MembershipEndedEarly", {
  end: Semester,
  id: MembershipId,
}) {}

export class MembershipCancelled extends Domain.Event("MembershipCancelled", {
  id: MembershipId,
}) {}

// ---------------------------------------------------------------------------------------------- commands
//
// A command is named as the kernel names it (`createMembership`, not `CreateMembership`), so that the tag is the key of
// the grant table and of `docs/system/commands.md`: one name, no mapping. Its target is the person's instance, and its
// input is the kernel's payload without the person, plus what the kernel allocates in a handler and a decider cannot
// (`membershipId`, from the table's own sequence, chosen by the sender and recorded in the event).

const refusals = [
  Forbidden,
  NotFound,
  ValidationFailed,
  AlreadyExists,
  Conflict,
] as const;

export class CreateMembership extends Domain.Command("createMembership", {
  events: [MembershipAdded],
  input: {
    end: Schema.optionalKey(Semester),
    leader: Schema.Boolean,
    membershipId: MembershipId,
    positionId: PositionId,
    start: Semester,
    teamId: TeamId,
  },
  middleware: [GrantGuard],
  rejects: refusals,
  target: PersonKey,
}) {}

export class ExtendMembership extends Domain.Command("extendMembership", {
  events: [MembershipExtended],
  input: { end: Semester, membershipId: MembershipId },
  middleware: [GrantGuard],
  rejects: refusals,
  target: PersonKey,
}) {}

export class EndEarlyMembership extends Domain.Command("endEarlyMembership", {
  events: [MembershipEndedEarly],
  input: { membershipId: MembershipId, semester: Semester },
  middleware: [GrantGuard],
  rejects: refusals,
  target: PersonKey,
}) {}

export class DeleteMembership extends Domain.Command("deleteMembership", {
  events: [MembershipCancelled],
  input: { membershipId: MembershipId },
  middleware: [GrantGuard],
  rejects: refusals,
  target: PersonKey,
}) {}

// --------------------------------------------------------------------------------------------- the rules

/** Norwegian texts of the handler's refusals, which are user-facing (private to `teams/commands.ts`, so repeated). */
const TEAM_INACTIVE =
  "Teamet er deaktivert, og nye medlemmer kan ikke legges til.";

const OTHER_DEPARTMENT = "Personen studerer ikke ved teamets avdeling.";

const START_IN_THE_PAST =
  "Startsemesteret kan ikke være før inneværende semester.";

const END_BEFORE_START = "Sluttsemesteret kan ikke være før startsemesteret.";

/** Why the Membership machine refused a command, as the user reads it (`teams/commands.ts`, `REFUSED`). */
const REFUSED = {
  deleteMembership:
    "Bare et medlemskap som ikke har startet kan kanselleres. Last siden på nytt.",
  endEarlyMembership:
    "Medlemskapet kan bare avsluttes mens det er aktivt, og fra et semester innenfor perioden. Last siden på nytt.",
  extendMembership:
    "Medlemskapet kan bare forlenges mens det er aktivt, og til et senere semester enn dagens slutt. Last siden på nytt.",
} as const;

interface Term {
  readonly end: Semester;
  readonly start: Semester;
}

const overlaps = (left: Term, right: Term): boolean =>
  semesterOrdinal(left.start) <= semesterOrdinal(right.end) &&
  semesterOrdinal(right.start) <= semesterOrdinal(left.end);

/** Another membership of the same team whose term meets `term`: what `membership_no_overlap` refuses. */
const clashes = (
  state: PersonStateValue,
  teamId: TeamId,
  term: Term,
  ignoring?: MembershipId
): boolean =>
  Arr.some(
    state.memberships,
    (other) =>
      other.teamId === teamId && other.id !== ignoring && overlaps(other, term)
  );

const overlap = (id: MembershipId) =>
  new AlreadyExists({
    entity: "Membership",
    key: String(id),
    message: MEMBERSHIP_OVERLAPS,
  });

const missing = (id: MembershipId) =>
  new NotFound({ entity: "Membership", key: String(id) });

const changed = (id: MembershipId, command: keyof typeof REFUSED) =>
  new Conflict({
    entity: "Membership",
    key: String(id),
    message: REFUSED[command],
  });

/** The membership a command is about, in this person's state, with the state it is in this semester. */
const find = (state: PersonStateValue, id: MembershipId, current: Semester) =>
  Option.map(
    Arr.findFirst(state.memberships, (membership) => membership.id === id),
    (membership) => ({
      membership,
      state: membershipState(membership, current),
    })
  );

const createMembership = Effect.fn("Person.createMembership")(
  function* createMembership(
    state: PersonStateValue,
    command: CreateMembership,
    { now }: DecideContext<PersonKeyValue>
  ) {
    yield* requireGrant("createMembership");
    const { personDepartmentId, team } = yield* CommandFacts;

    if (team === undefined || personDepartmentId === undefined) {
      return yield* Effect.die(
        "createMembership needs the facts of its team and person"
      );
    }

    if (!team.active) {
      return yield* invalid(["teamId"], TEAM_INACTIVE);
    }

    if (personDepartmentId !== team.departmentId) {
      return yield* invalid(["personId"], OTHER_DEPARTMENT);
    }

    const term = {
      end: command.end ?? defaultEnd(command.start, team.defaultTerm),
      start: command.start,
    };

    if (isBeforeSemester(term.end, term.start)) {
      return yield* invalid(["end"], END_BEFORE_START);
    }

    const current = semesterForDate(now);

    if (
      !Machine.can(
        Teams.MembershipMachine,
        "createMembership",
        Machine.Boundary,
        {
          current,
          requested: term.start,
          term,
        }
      )
    ) {
      return yield* invalid(["start"], START_IN_THE_PAST);
    }

    if (clashes(state, command.teamId, term)) {
      return yield* overlap(command.membershipId);
    }

    return [
      new MembershipAdded({
        ...term,
        id: command.membershipId,
        leader: command.leader,
        positionId: command.positionId,
        teamId: command.teamId,
      }),
    ];
  }
);

/** The transition of `extendMembership`, `endEarlyMembership` and `deleteMembership`: the machine decides. */
const transition = (
  state: PersonStateValue,
  id: MembershipId,
  command: keyof typeof REFUSED,
  requested: Semester | undefined,
  now: Parameters<typeof semesterForDate>[0]
) => {
  const current = semesterForDate(now);

  return Option.match(find(state, id, current), {
    onNone: () => Effect.fail(missing(id)),
    onSome: ({ membership, state: membershipStatus }) => {
      const term = { end: membership.end, start: membership.start };

      return Machine.can(Teams.MembershipMachine, command, membershipStatus, {
        current,
        requested: requested ?? term.start,
        term,
      })
        ? Effect.succeed(membership)
        : Effect.fail(changed(id, command));
    },
  });
};

const extendMembership = Effect.fn("Person.extendMembership")(
  function* extendMembership(
    state: PersonStateValue,
    command: ExtendMembership,
    { now }: DecideContext<PersonKeyValue>
  ) {
    yield* requireGrant("extendMembership");

    const membership = yield* transition(
      state,
      command.membershipId,
      "extendMembership",
      command.end,
      now
    );

    const term = { end: command.end, start: membership.start };

    if (clashes(state, membership.teamId, term, membership.id)) {
      return yield* overlap(membership.id);
    }

    return [new MembershipExtended({ end: command.end, id: membership.id })];
  }
);

const endEarlyMembership = Effect.fn("Person.endEarlyMembership")(
  function* endEarlyMembership(
    state: PersonStateValue,
    command: EndEarlyMembership,
    { now }: DecideContext<PersonKeyValue>
  ) {
    yield* requireGrant("endEarlyMembership");

    const membership = yield* transition(
      state,
      command.membershipId,
      "endEarlyMembership",
      command.semester,
      now
    );

    return [
      new MembershipEndedEarly({
        end: previousSemester(command.semester),
        id: membership.id,
      }),
    ];
  }
);

const deleteMembership = Effect.fn("Person.deleteMembership")(
  function* deleteMembership(
    state: PersonStateValue,
    command: DeleteMembership,
    { now }: DecideContext<PersonKeyValue>
  ) {
    yield* requireGrant("deleteMembership");

    const membership = yield* transition(
      state,
      command.membershipId,
      "deleteMembership",
      undefined,
      now
    );

    return [new MembershipCancelled({ id: membership.id })];
  }
);

// -------------------------------------------------------------------------------------------- aggregate

const replaceEnd = (
  state: PersonStateValue,
  id: MembershipId,
  end: Semester
): PersonStateValue => ({
  memberships: Arr.map(state.memberships, (membership) =>
    membership.id === id ? { ...membership, end } : membership
  ),
});

export class Person extends Domain.Aggregate("Person", {
  commands: [
    CreateMembership,
    ExtendMembership,
    EndEarlyMembership,
    DeleteMembership,
  ],
  decide: {
    createMembership,
    deleteMembership,
    endEarlyMembership,
    extendMembership,
  },
  evolve: {
    MembershipAdded: (state, event) => ({
      memberships: [
        ...state.memberships,
        {
          end: event.end,
          id: event.id,
          leader: event.leader,
          positionId: event.positionId,
          start: event.start,
          teamId: event.teamId,
        },
      ],
    }),
    MembershipCancelled: (state, event) => ({
      memberships: Arr.filter(
        state.memberships,
        (membership) => membership.id !== event.id
      ),
    }),
    MembershipEndedEarly: (state, event) =>
      replaceEnd(state, event.id, event.end),
    MembershipExtended: (state, event) =>
      replaceEnd(state, event.id, event.end),
  },
  id: PersonKey,
  initial: { memberships: [] },
  state: PersonStateSchema,
}) {}
