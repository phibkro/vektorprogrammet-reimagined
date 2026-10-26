/**
 * The principals the web tests act as, with the facts `PrincipalDirectory` would load for such a person (spec 0006,
 * R1): the memberships active this semester, and the end of the admin place. Nothing here is a role: a leader is
 * a person with a membership whose `leader` flag is set.
 */
import {
  DepartmentId,
  PersonId,
  Principal,
  TeamId,
} from "@vektorprogrammet/domain";
import type { TeamFunction } from "@vektorprogrammet/domain";
import { DateTime } from "effect";

const LATE = DateTime.makeUnsafe("2099-12-31T23:59:59Z");

/** An administrator whose place has a long time to run, and who belongs to no team. */
export const adminOf = (personId: number): Principal =>
  Principal.cases.Person.make({
    adminUntil: LATE,
    memberships: [],
    personId: PersonId.make(personId),
  });

/** An administrator who is nobody in particular. */
export const ADMIN: Principal = adminOf(900_001);

/** A signed-in person with no team and no admin place: the control panel has nothing to show them. */
export const WITHOUT_TEAM: Principal = Principal.cases.Person.make({
  memberships: [],
  personId: PersonId.make(900_002),
});

interface MembershipOptions {
  /** A team's leader; false (a plain member) unless said otherwise. */
  readonly leader?: boolean;
  /** What the team is for; the recruitment team unless said otherwise. */
  readonly function?: TeamFunction;
  readonly personId?: number;
  readonly teamId?: number;
}

/** A person with one active membership in a team of `departmentId`. */
export const memberOf = (
  departmentId: number,
  options: MembershipOptions = {}
): Principal =>
  Principal.cases.Person.make({
    memberships: [
      {
        departmentId: DepartmentId.make(departmentId),
        function: options.function ?? "recruitment",
        leader: options.leader ?? false,
        teamId: TeamId.make(options.teamId ?? 1),
      },
    ],
    personId: PersonId.make(options.personId ?? 900_003),
  });

/** A person who leads a team of `departmentId`. */
export const leaderOf = (
  departmentId: number,
  options: Omit<MembershipOptions, "leader"> = {}
): Principal => memberOf(departmentId, { ...options, leader: true });
