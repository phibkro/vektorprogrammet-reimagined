/**
 * The smallest world that a membership needs: a department with a field of study, a person of that department and a
 * team. Fake, same-shape values; every name carries `tag` so that tests sharing one database never collide.
 */
import {
  DepartmentRepository,
  EmailAddress,
  FieldOfStudyRepository,
  MembershipRepository,
  PersonRepository,
  PositionRepository,
  TeamRepository,
} from "@vektorprogrammet/domain";
import type {
  PersonId,
  PositionId,
  Semester,
  TeamId,
} from "@vektorprogrammet/domain";
import { Array as Arr, Effect } from "effect";

import { departmentDraft } from "./fixtures.ts";

export const semester = (term: Semester["term"], year: number): Semester => ({
  term,
  year,
});

/** The seeded position with this name (`Leder`, `Medlem`): the first migration inserts both. */
const positionNamed = Effect.fnUntraced(function* positionNamed(name: string) {
  const positions = yield* (yield* PositionRepository).list;

  return (yield* Effect.orDie(
    Effect.fromOption(Arr.findFirst(positions, (found) => found.name === name))
  )).id;
});

export const world = Effect.fnUntraced(function* world(tag: string) {
  const department = yield* (yield* DepartmentRepository).create(
    departmentDraft(`By${tag}`)
  );

  const fieldOfStudy = yield* (yield* FieldOfStudyRepository).create({
    departmentId: department.id,
    name: `Linje ${tag}`,
    shortName: tag.slice(0, 3).toUpperCase(),
  });

  const person = yield* (yield* PersonRepository).create({
    email: EmailAddress.make(`ola.${tag}@example.org`),
    fieldOfStudyId: fieldOfStudy.id,
    name: `Ola ${tag}`,
  });

  const team = yield* (yield* TeamRepository).create({
    defaultTerm: 2,
    departmentId: department.id,
    function: "recruitment",
    name: `Team ${tag}`,
  });

  return {
    department,
    fieldOfStudy,
    leaderPosition: yield* positionNamed("Leder"),
    memberPosition: yield* positionNamed("Medlem"),
    person,
    team,
  };
});

/** One membership of `personId` in `teamId` for the term `start` to `end`. */
export const insertMembership = (
  who: {
    readonly personId: PersonId;
    readonly positionId: PositionId;
    readonly teamId: TeamId;
  },
  term: { readonly start: Semester; readonly end: Semester },
  leader = false
) =>
  MembershipRepository.use((memberships) =>
    memberships.insert({ ...who, ...term, leader })
  );
