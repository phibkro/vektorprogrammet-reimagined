/**
 * The smallest world that a membership needs: a department with a field of study, a person of that department and a
 * team. Fake, same-shape values; every name carries `tag` so that tests sharing one database never collide.
 */
import {
  AggregateLocks,
  DepartmentRepository,
  EmailAddress,
  FieldOfStudyRepository,
  MembershipRepository,
  PersonRepository,
  PositionRepository,
  TeamRepository,
} from "@vektorprogrammet/domain";
import type {
  Locked,
  PersonId,
  PositionId,
  Semester,
  TeamId,
} from "@vektorprogrammet/domain";
import { Array as Arr, Effect } from "effect";

import { transactional } from "../../src/index.ts";
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

/** The person's lock, as a command takes it first. It needs a transaction (`transactional`). */
export const lockPerson = (personId: PersonId) =>
  AggregateLocks.use((locks) => locks.lock("Person", personId));

/** Runs a write of the person's rows in a transaction of its own, as a fixture writes outside a command. */
export const asPerson = <A, E, R>(
  personId: PersonId,
  write: (locked: Locked) => Effect.Effect<A, E, R>
) => transactional(Effect.flatMap(lockPerson(personId), write));

/** One membership of `personId` in `teamId` for the term `start` to `end`. It needs a transaction. */
export const insertMembership = (
  who: {
    readonly personId: PersonId;
    readonly positionId: PositionId;
    readonly teamId: TeamId;
  },
  term: { readonly start: Semester; readonly end: Semester },
  leader = false
) =>
  Effect.flatMap(lockPerson(who.personId), (locked) =>
    MembershipRepository.use((memberships) =>
      memberships.insert(locked, {
        ...term,
        leader,
        positionId: who.positionId,
        teamId: who.teamId,
      })
    )
  );

/** `insertMembership` in a transaction of its own, for a fixture that writes outside a command. */
export const placeMembership = (...args: Parameters<typeof insertMembership>) =>
  transactional(insertMembership(...args));
