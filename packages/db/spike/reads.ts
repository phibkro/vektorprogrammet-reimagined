/**
 * The two nested reads of the teams domain, twice: the current implementation (the repositories) and RQB v2.
 * Both decode through the domain's Schemas.
 */
import {
  DepartmentId,
  EmailAddress,
  Membership,
  MembershipRepository,
  NotFound,
  Person,
  PersonRepository,
  Team,
  TeamRepository,
  semesterOrdinal,
} from "@vektorprogrammet/domain";
import type { PersonId, Semester, TeamId } from "@vektorprogrammet/domain";
import { Array as Arr, Effect, Order, Schema } from "effect";

import { decodeWith } from "../src/internal/drizzle.ts";
import { Rqb } from "./harness.ts";

// ---------------------------------------------------------------- shapes (as in repositories/teams.ts)

const MembershipView = Schema.Struct({
  ...Membership.fields,
  personName: Schema.String,
  positionName: Schema.String,
});

const ActiveMembership = Schema.Struct({
  ...Membership.fields,
  departmentId: DepartmentId,
  personEmail: EmailAddress,
  personName: Schema.String,
  positionName: Schema.String,
  teamName: Schema.String,
});

interface TermColumns {
  readonly endTerm: Semester["term"];
  readonly endYear: number;
  readonly id: number;
  readonly leader: boolean;
  readonly personId: number;
  readonly positionId: number;
  readonly startTerm: Semester["term"];
  readonly startYear: number;
  readonly teamId: number;
}

const termOf = (row: TermColumns) => ({
  end: { term: row.endTerm, year: row.endYear },
  id: row.id,
  leader: row.leader,
  personId: row.personId,
  positionId: row.positionId,
  start: { term: row.startTerm, year: row.startYear },
  teamId: row.teamId,
});

const decodeTeam = decodeWith(Team);
const decodeViews = decodeWith(Schema.Array(MembershipView));
const decodeActive = decodeWith(Schema.Array(ActiveMembership));
const decodePeople = decodeWith(Schema.Array(Person));

// ---------------------------------------------------------------- read 1: the team page (team + memberships + names)

/** Current: `TeamRepository.findById` and `MembershipRepository.listByTeam` (two statements). */
export const teamPageCurrent = Effect.fnUntraced(function* teamPageCurrent(
  id: TeamId
) {
  const team = yield* (yield* TeamRepository).findById(id);
  const members = yield* (yield* MembershipRepository).listByTeam(id);

  return { members, team };
});

/** RQB v2: one `findFirst` with the memberships, their people and positions. */
export const teamPageRqb = Effect.fnUntraced(function* teamPageRqb(
  id: TeamId,
  strategy?: "basic" | "optimized"
) {
  const db = yield* Rqb;

  const row = yield* db.query.team.findFirst({
    ...(strategy === undefined ? {} : { strategy }),
    where: { id },
    with: {
      memberships: {
        columns: { endOrdinal: false, startOrdinal: false },
        orderBy: { startOrdinal: "asc", id: "asc" },
        with: {
          person: { columns: { name: true } },
          position: { columns: { name: true } },
        },
      },
    },
  });

  if (row === undefined) {
    return yield* new NotFound({ entity: "Team", key: String(id) });
  }

  const members = yield* decodeViews(
    Arr.map(row.memberships, (member) => ({
      ...termOf(member),
      personName: member.person.name,
      positionName: member.position.name,
    }))
  );

  return { members, team: yield* decodeTeam(row) };
});

// ---------------------------------------------------------------- read 2: people with their current memberships

const byTeamNameThenId = Order.combine(
  Order.mapInput(Order.String, (m: { readonly teamName: string; readonly id: number }) => m.teamName),
  Order.mapInput(Order.Number, (m: { readonly teamName: string; readonly id: number }) => m.id)
);

interface PersonWithMemberships {
  readonly person: typeof Person.Type;
  readonly memberships: readonly (typeof ActiveMembership.Type)[];
}

/** Current: `PersonRepository.list(null)` + `MembershipRepository.activeIn(semester)`, joined in memory. */
export const peopleCurrent = Effect.fnUntraced(function* peopleCurrent(
  semester: Semester
) {
  const people = yield* (yield* PersonRepository).list(null);
  const active = yield* (yield* MembershipRepository).activeIn(semester);
  const byPerson = Arr.groupBy(active, (member) => String(member.personId));

  return Arr.map(
    people,
    (person): PersonWithMemberships => ({
      memberships: Arr.sort(byPerson[String(person.id)] ?? [], byTeamNameThenId),
      person,
    })
  );
});

/** RQB v2: one `findMany` on person, with its field of study and its active memberships (ordinal filter). */
export const peopleRqb = Effect.fnUntraced(function* peopleRqb(
  semester: Semester,
  strategy?: "basic" | "optimized"
) {
  const db = yield* Rqb;
  const ordinal = semesterOrdinal(semester);

  const rows = yield* db.query.person.findMany({
    ...(strategy === undefined ? {} : { strategy }),
    orderBy: { name: "asc", id: "asc" },
    with: {
      fieldOfStudy: { columns: { departmentId: true } },
      memberships: {
        columns: { endOrdinal: false, startOrdinal: false },
        orderBy: { id: "asc" },
        where: { endOrdinal: { gte: ordinal }, startOrdinal: { lte: ordinal } },
        with: {
          position: { columns: { name: true } },
          team: { columns: { departmentId: true, name: true } },
        },
      },
    },
  });

  const people = yield* decodePeople(
    Arr.map(rows, (row) => ({
      departmentId: row.fieldOfStudy.departmentId,
      email: row.email,
      fieldOfStudyId: row.fieldOfStudyId,
      id: row.id,
      name: row.name,
    }))
  );

  return yield* Effect.forEach(Arr.zip(people, rows), ([person, row]) =>
    Effect.map(
      decodeActive(
        Arr.map(row.memberships, (member) => ({
          ...termOf(member),
          departmentId: member.team.departmentId,
          personEmail: row.email,
          personName: row.name,
          positionName: member.position.name,
          teamName: member.team.name,
        }))
      ),
      (memberships): PersonWithMemberships => ({
        memberships: Arr.sort(memberships, byTeamNameThenId),
        person,
      })
    )
  );
});

export type { PersonId };

// ---------------------------------------------------------------- read 2b: the active memberships themselves

/** Current: `MembershipRepository.activeIn` (one statement, four joins, `ORDER BY team name, person name, id`). */
export const activeCurrent = Effect.fnUntraced(function* activeCurrent(
  semester: Semester
) {
  return yield* (yield* MembershipRepository).activeIn(semester);
});

interface Named {
  readonly id: number;
  readonly personName: string;
  readonly teamName: string;
}

/** The order of `activeIn`: team name, person name, id. */
const byTeamPersonId = Order.combine(
  Order.combine(
    Order.mapInput(Order.String, (m: Named) => m.teamName),
    Order.mapInput(Order.String, (m: Named) => m.personName)
  ),
  Order.mapInput(Order.Number, (m: Named) => m.id)
);

/**
 * RQB v2 from the membership side: the same rows as `activeIn`. `orderBy` in `findMany` cannot name a column of a
 * relation, so the order `team name, person name, id` is restored in memory.
 */
export const activeRqb = Effect.fnUntraced(function* activeRqb(
  semester: Semester
) {
  const db = yield* Rqb;
  const ordinal = semesterOrdinal(semester);

  const rows = yield* db.query.membership.findMany({
    columns: { endOrdinal: false, startOrdinal: false },
    where: { endOrdinal: { gte: ordinal }, startOrdinal: { lte: ordinal } },
    with: {
      person: { columns: { email: true, name: true } },
      position: { columns: { name: true } },
      team: { columns: { departmentId: true, name: true } },
    },
  });

  const decoded = yield* decodeActive(
    Arr.map(rows, (member) => ({
      ...termOf(member),
      departmentId: member.team.departmentId,
      personEmail: member.person.email,
      personName: member.person.name,
      positionName: member.position.name,
      teamName: member.team.name,
    }))
  );

  return Arr.sort(decoded, byTeamPersonId);
});

// ---------------------------------------------------------------- read 3: a page of one department's people (strategy matters)

/**
 * RQB v2: people of one department, a page of 50 with their active memberships. A relation filter (`fieldOfStudy`)
 * plus `limit`/`offset` plus `with` is where the `optimized` strategy (rc.5) changes the statement.
 */
export const peoplePageRqb = Effect.fnUntraced(function* peoplePageRqb(
  semester: Semester,
  departmentId: number,
  strategy?: "basic" | "optimized"
) {
  const db = yield* Rqb;
  const ordinal = semesterOrdinal(semester);

  return yield* db.query.person.findMany({
    ...(strategy === undefined ? {} : { strategy }),
    columns: { id: true, name: true },
    limit: 50,
    offset: 100,
    orderBy: { name: "asc", id: "asc" },
    where: { fieldOfStudy: { departmentId } },
    with: {
      memberships: {
        columns: { id: true, teamId: true },
        orderBy: { id: "asc" },
        where: { endOrdinal: { gte: ordinal }, startOrdinal: { lte: ordinal } },
        with: { team: { columns: { name: true } } },
      },
    },
  });
});
