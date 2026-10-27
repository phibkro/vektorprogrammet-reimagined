/**
 * The handlers of `TeamsRpc` (ADR 0006). Every handler is built with `TeamsDomain.handle`: it finds what the command
 * is about, asks the grant table, and only then runs. A membership's state is calculated from its term and the current
 * semester (`term.ts`); the Membership machine says which command may start from which state, and a refusal by the
 * machine is a `Conflict`, as is a write that finds the row changed since it was read (the conditional updates of
 * `MembershipRepository`). Nothing is written outside the transaction the caller opened.
 *
 * A command about one person takes that person's lock first (`AggregateLocks`, spec 0006b), reads what it decides on
 * through the token (`findLocked`) and writes through it, so two commands on one person queue instead of interleaving.
 */
import { DateTime, Effect, Predicate } from "effect";

import { recordAudit } from "../audit/auditLog.ts";
import * as Commands from "../kernel/commands.ts";
import { departmentResource } from "../kernel/domain.ts";
import * as Machine from "../kernel/machine.ts";
import { currentSemester } from "../organisation/commands.ts";
import { semesterWindow } from "../organisation/semester.ts";
import type { Semester } from "../organisation/semester.ts";
import { FieldOfStudyRepository } from "../organisation/services.ts";
import { AggregateLocks, lockAdminList } from "../shared/aggregate.ts";
import { Conflict, validationFailed } from "../shared/errors.ts";
import type { MembershipId, TeamId } from "../shared/ids.ts";
import { InTransaction } from "../shared/transaction.ts";
import {
  MembershipMachine,
  TeamsDomain,
  TeamsRpc,
  changeMembership,
  createAdminGrant,
  createMembership,
  createPerson,
  createTeam,
  deactivateTeam,
  deleteAdminGrant,
  deleteMembership,
  endEarlyMembership,
  extendMembership,
  sendEndingSoon,
  updateTeam,
} from "./declaration.ts";
import { runEndingSoon } from "./endingSoon.ts";
import {
  AdminGrantRepository,
  MembershipRepository,
  PersonRepository,
  PositionRepository,
  TeamRepository,
} from "./services.ts";
import {
  defaultEnd,
  isBeforeSemester,
  membershipState,
  previousSemester,
} from "./term.ts";

/** Norwegian texts of the refusals, which are user-facing. */
const TEAM_INACTIVE =
  "Teamet er deaktivert, og nye medlemmer kan ikke legges til.";

const OTHER_DEPARTMENT = "Personen studerer ikke ved teamets avdeling.";

const START_IN_THE_PAST =
  "Startsemesteret kan ikke være før inneværende semester.";

const END_BEFORE_START = "Sluttsemesteret kan ikke være før startsemesteret.";

const LAST_ADMIN =
  "Den siste administratorplassen som varer etter dette semesteret kan ikke fjernes.";

const UNTIL_PAST = "Administratorplassen må vare lenger enn nå.";

/** Why the Membership machine refused a command, as the user reads it. */
const REFUSED = {
  changeMembership:
    "Medlemskapet kan bare endres mens det er aktivt, og fra et semester innenfor perioden. Last siden på nytt.",
  deleteMembership:
    "Bare et medlemskap som ikke har startet kan kanselleres. Last siden på nytt.",
  endEarlyMembership:
    "Medlemskapet kan bare avsluttes mens det er aktivt, og fra et semester innenfor perioden. Last siden på nytt.",
  extendMembership:
    "Medlemskapet kan bare forlenges mens det er aktivt, og til et senere semester enn dagens slutt. Last siden på nytt.",
} as const;

const loadMembership = Effect.fn("loadMembership")(function* loadMembership(
  id: MembershipId
) {
  const memberships = yield* MembershipRepository;
  const teams = yield* TeamRepository;
  const membership = yield* memberships.findById(id);
  const team = yield* teams.findById(membership.teamId);

  return { membership, memberships, team };
});

const teamOf = Effect.fn("teamOf")(function* teamOf(id: TeamId) {
  const teams = yield* TeamRepository;

  return yield* teams.findById(id);
});

/** What a command on an existing membership is about: its department, and the person it belongs to (for `Self`). */
const aboutMembership = (id: MembershipId) =>
  Effect.map(loadMembership(id), ({ membership, team }) => ({
    departmentId: team.departmentId,
    personId: membership.personId,
  }));

/**
 * Locks the person that the membership belongs to, reads the membership through the lock, finds its state in the
 * current semester and lets the machine decide: a command the machine refuses is a `Conflict`, because the membership
 * is not in a state the command starts from (any more). The owner of a membership never changes, so the first read
 * only finds whose lock to take; the decision is made on what the second read finds under it.
 */
const beginTransition = Effect.fn("beginTransition")(function* beginTransition(
  id: MembershipId,
  command: keyof typeof REFUSED,
  requested: Semester | null
) {
  yield* InTransaction;
  const locks = yield* AggregateLocks;
  const memberships = yield* MembershipRepository;
  const { personId } = yield* memberships.findById(id);
  const locked = yield* locks.lock("Person", personId);
  const membership = yield* memberships.findLocked(locked, id);
  const current = yield* currentSemester;
  const term = { end: membership.end, start: membership.start };

  const allowed = Machine.can(
    MembershipMachine,
    command,
    membershipState(term, current),
    { current, requested: requested ?? term.start, term }
  );

  if (!allowed) {
    return yield* new Conflict({
      entity: "Membership",
      key: String(id),
      message: REFUSED[command],
    });
  }

  return { current, locked, membership, memberships };
});

const belongsToDepartment = (
  person: { readonly departmentId: number },
  team: { readonly departmentId: number }
): boolean => person.departmentId === team.departmentId;

export const TeamsHandlers = TeamsRpc.toLayer({
  /** The old membership ends before `from`, and a new one starts at `from` with the remaining term. */
  changeMembership: TeamsDomain.handle(changeMembership, {
    resource: ({ id, teamId }) =>
      Effect.gen(function* resource() {
        const { membership, team } = yield* loadMembership(id);
        const target = yield* teamOf(teamId ?? membership.teamId);

        const here = {
          departmentId: team.departmentId,
          personId: membership.personId,
        };

        return target.departmentId === team.departmentId
          ? here
          : ([
              here,
              {
                departmentId: target.departmentId,
                personId: membership.personId,
              },
            ] as const);
      }),
    run: (input, principal) =>
      Effect.gen(function* run() {
        const positions = yield* PositionRepository;

        const { current, locked, membership, memberships } =
          yield* beginTransition(input.id, "changeMembership", input.from);

        const target = yield* teamOf(input.teamId ?? membership.teamId);
        const positionId = input.positionId ?? membership.positionId;
        yield* positions.findById(positionId);

        if (!target.active) {
          return yield* validationFailed(["teamId"], TEAM_INACTIVE);
        }

        const ended = yield* memberships.setEnd(locked, {
          activeIn: current,
          id: input.id,
          newEnd: previousSemester(input.from),
          observedEnd: membership.end,
        });

        const started = yield* memberships.insert(locked, {
          end: membership.end,
          leader: input.leader ?? membership.leader,
          positionId,
          start: input.from,
          teamId: target.id,
        });

        yield* recordAudit(
          principal,
          "membership.changed",
          "Membership",
          started.id
        );

        return { ended, started };
      }),
  }),
  /** RULE-113, 308: admin only, never for oneself. */
  createAdminGrant: TeamsDomain.handle(createAdminGrant, {
    resource: () => Effect.succeed({}),
    run: ({ personId, until }, principal) =>
      Effect.gen(function* run() {
        yield* InTransaction;
        const locks = yield* AggregateLocks;
        const grants = yield* AdminGrantRepository;
        const now = yield* DateTime.now;

        const granter = Predicate.isTagged(principal, "Person")
          ? principal.personId
          : null;

        if (granter === personId) {
          return yield* TeamsDomain.forbidden("createAdminGrant");
        }

        if (!DateTime.isGreaterThan(until, now)) {
          return yield* validationFailed(["until"], UNTIL_PAST);
        }

        // The list comes before every person: a place changes who is on it.
        const adminList = yield* lockAdminList;
        const locked = yield* locks.lock("Person", personId);

        const created = yield* grants.create(adminList, locked, {
          grantedBy: granter,
          until,
        });

        yield* recordAudit(
          principal,
          "adminGrant.granted",
          "AdminGrant",
          created.id
        );

        return created;
      }),
  }),
  /** RULE-206, 284, 164: a leader, a board member or an admin adds a member of the team's department. */
  createMembership: TeamsDomain.handle(createMembership, {
    resource: ({ teamId }) =>
      Effect.map(teamOf(teamId), ({ departmentId }) => ({ departmentId })),
    run: (input, principal) =>
      Effect.gen(function* run() {
        yield* InTransaction;
        const locks = yield* AggregateLocks;
        const memberships = yield* MembershipRepository;
        const persons = yield* PersonRepository;
        const positions = yield* PositionRepository;
        const current = yield* currentSemester;
        const team = yield* teamOf(input.teamId);
        const locked = yield* locks.lock("Person", input.personId);
        const person = yield* persons.findLocked(locked);
        yield* positions.findById(input.positionId);

        if (!team.active) {
          return yield* validationFailed(["teamId"], TEAM_INACTIVE);
        }

        if (!belongsToDepartment(person, team)) {
          return yield* validationFailed(["personId"], OTHER_DEPARTMENT);
        }

        const term = {
          end: input.end ?? defaultEnd(input.start, team.defaultTerm),
          start: input.start,
        };

        if (isBeforeSemester(term.end, term.start)) {
          return yield* validationFailed(["end"], END_BEFORE_START);
        }

        if (
          !Machine.can(
            MembershipMachine,
            "createMembership",
            Machine.Boundary,
            {
              current,
              requested: term.start,
              term,
            }
          )
        ) {
          return yield* validationFailed(["start"], START_IN_THE_PAST);
        }

        const created = yield* memberships.insert(locked, {
          ...term,
          leader: input.leader,
          positionId: input.positionId,
          teamId: input.teamId,
        });

        yield* recordAudit(
          principal,
          "membership.added",
          "Membership",
          created.id
        );

        return created;
      }),
  }),
  createPerson: TeamsDomain.handle(createPerson, {
    resource: ({ fieldOfStudyId }) =>
      Effect.gen(function* resource() {
        const fieldsOfStudy = yield* FieldOfStudyRepository;
        const { departmentId } = yield* fieldsOfStudy.findById(fieldOfStudyId);

        return { departmentId };
      }),
    run: (draft, principal) =>
      Effect.gen(function* run() {
        yield* InTransaction;
        const persons = yield* PersonRepository;
        const created = yield* persons.create(draft);
        yield* recordAudit(
          principal,
          "person.registered",
          "Person",
          created.id
        );

        return created;
      }),
  }),
  createTeam: TeamsDomain.handle(createTeam, {
    resource: departmentResource,
    run: (draft, principal) =>
      Effect.gen(function* run() {
        yield* InTransaction;
        const teams = yield* TeamRepository;
        const created = yield* teams.create(draft);
        yield* recordAudit(principal, "team.created", "Team", created.id);

        return created;
      }),
  }),
  deactivateTeam: TeamsDomain.handle(deactivateTeam, {
    resource: ({ id }) =>
      Effect.map(teamOf(id), ({ departmentId }) => ({ departmentId })),
    run: ({ id }, principal) =>
      Effect.gen(function* run() {
        yield* InTransaction;
        const teams = yield* TeamRepository;
        const deactivated = yield* teams.deactivate(id);
        yield* recordAudit(principal, "team.deactivated", "Team", id);

        return deactivated;
      }),
  }),
  /** RULE-113, 308: admin only, never one's own place, never the last place that ends after this semester. */
  deleteAdminGrant: TeamsDomain.handle(deleteAdminGrant, {
    resource: () => Effect.succeed({}),
    run: ({ id }, principal) =>
      Effect.gen(function* run() {
        yield* InTransaction;
        const locks = yield* AggregateLocks;
        const grants = yield* AdminGrantRepository;

        // Whether an Active administrator is left spans every administrator, so the list is locked before the
        // holder of the place, and the place cannot change while it is held.
        const adminList = yield* lockAdminList;
        const grant = yield* grants.findById(id);

        if (
          Predicate.isTagged(principal, "Person") &&
          grant.personId === principal.personId
        ) {
          return yield* TeamsDomain.forbidden("deleteAdminGrant");
        }

        const holder = yield* locks.lock("Person", grant.personId);
        const current = yield* currentSemester;

        const outcome = yield* grants.revoke(
          adminList,
          holder,
          id,
          semesterWindow(current).end
        );

        if (outcome === "last") {
          return yield* validationFailed(["id"], LAST_ADMIN);
        }

        yield* recordAudit(principal, "adminGrant.revoked", "AdminGrant", id);

        return yield* Effect.void;
      }),
  }),
  /** RULE-298: a member is not enough to end someone else's membership; the person themself or a leader does it. */
  deleteMembership: TeamsDomain.handle(deleteMembership, {
    resource: ({ id }) => aboutMembership(id),
    run: ({ id }, principal) =>
      Effect.gen(function* run() {
        const { current, locked, membership, memberships } =
          yield* beginTransition(id, "deleteMembership", null);

        yield* memberships.remove(locked, {
          current,
          id,
          observed: { end: membership.end, start: membership.start },
        });

        yield* recordAudit(principal, "membership.cancelled", "Membership", id);
      }),
  }),
  /** RULE-298: the person themself or a leader of the department ends it, from `semester`. */
  endEarlyMembership: TeamsDomain.handle(endEarlyMembership, {
    resource: ({ id }) => aboutMembership(id),
    run: ({ id, semester }, principal) =>
      Effect.gen(function* run() {
        const { current, locked, membership, memberships } =
          yield* beginTransition(id, "endEarlyMembership", semester);

        const ended = yield* memberships.setEnd(locked, {
          activeIn: current,
          id,
          newEnd: previousSemester(semester),
          observedEnd: membership.end,
        });

        yield* recordAudit(
          principal,
          "membership.endedEarly",
          "Membership",
          id
        );

        return ended;
      }),
  }),
  /** RULE-234, 251, 252: `extendMembership` is the only way to stay, and it never reactivates an ended membership. */
  extendMembership: TeamsDomain.handle(extendMembership, {
    resource: ({ id }) => aboutMembership(id),
    run: ({ end, id }, principal) =>
      Effect.gen(function* run() {
        const { current, locked, membership, memberships } =
          yield* beginTransition(id, "extendMembership", end);

        const extended = yield* memberships.setEnd(locked, {
          activeIn: current,
          id,
          newEnd: end,
          observedEnd: membership.end,
        });

        yield* recordAudit(principal, "membership.extended", "Membership", id);

        return extended;
      }),
  }),
  sendEndingSoon: TeamsDomain.handle(sendEndingSoon, {
    resource: () => Effect.succeed({}),
    run: (_, principal) => runEndingSoon(principal),
  }),
  updateTeam: TeamsDomain.handle(updateTeam, {
    resource: ({ id }) =>
      Effect.map(teamOf(id), ({ departmentId }) => ({ departmentId })),
    run: ({ id, ...details }, principal) =>
      Effect.gen(function* run() {
        yield* InTransaction;
        const teams = yield* TeamRepository;
        const updated = yield* teams.update(id, details);
        yield* recordAudit(principal, "team.updated", "Team", id);

        return updated;
      }),
  }),
});

/** The teams commands behind the in-process client; see `Commands.inProcess`. */
export const withTeams = Commands.inProcess(TeamsRpc, TeamsHandlers);

/** The server functions' entries: untrusted input in, the command's own result out (`Commands.endpoint`). */
export const TeamsEndpoints = {
  changeMembership: Commands.endpoint(changeMembership, (payload) =>
    withTeams((client) => client.changeMembership(payload))
  ),
  createAdminGrant: Commands.endpoint(createAdminGrant, (payload) =>
    withTeams((client) => client.createAdminGrant(payload))
  ),
  createMembership: Commands.endpoint(createMembership, (payload) =>
    withTeams((client) => client.createMembership(payload))
  ),
  createPerson: Commands.endpoint(createPerson, (payload) =>
    withTeams((client) => client.createPerson(payload))
  ),
  createTeam: Commands.endpoint(createTeam, (payload) =>
    withTeams((client) => client.createTeam(payload))
  ),
  deactivateTeam: Commands.endpoint(deactivateTeam, (payload) =>
    withTeams((client) => client.deactivateTeam(payload))
  ),
  deleteAdminGrant: Commands.endpoint(deleteAdminGrant, (payload) =>
    withTeams((client) => client.deleteAdminGrant(payload))
  ),
  deleteMembership: Commands.endpoint(deleteMembership, (payload) =>
    withTeams((client) => client.deleteMembership(payload))
  ),
  endEarlyMembership: Commands.endpoint(endEarlyMembership, (payload) =>
    withTeams((client) => client.endEarlyMembership(payload))
  ),
  extendMembership: Commands.endpoint(extendMembership, (payload) =>
    withTeams((client) => client.extendMembership(payload))
  ),
  updateTeam: Commands.endpoint(updateTeam, (payload) =>
    withTeams((client) => client.updateTeam(payload))
  ),
};

/** The ending-soon digest (spec 0006): the Worker's `scheduled` handler runs it as `System("endingSoon")`. */
export const endingSoonJob = withTeams((client) => client.sendEndingSoon());
