/**
 * The smallest world that a membership needs: a department with a field of study, a person of that department and a
 * team. Fake, same-shape values; every name carries `tag` so that tests sharing one database never collide.
 */
import {
  AdminGrantRepository,
  AggregateLocks,
  DepartmentRepository,
  EmailAddress,
  FieldOfStudyRepository,
  MembershipRepository,
  PersonRepository,
  PositionRepository,
  TeamRepository,
  lockAdminList,
} from "@vektorprogrammet/domain";
import type {
  AdminGrantDraft,
  AdminGrantId,
  FieldOfStudyId,
  Locked,
  PersonId,
  PositionId,
  Semester,
  TeamId,
} from "@vektorprogrammet/domain";
import { Array as Arr, Effect, String as Str } from "effect";
import type { DateTime } from "effect";

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
    shortName: Str.toUpperCase(Str.slice(0, 3)(tag)),
  });

  const person = yield* transactional(
    (yield* PersonRepository).create({
      email: EmailAddress.make(`ola.${tag}@example.org`),
      fieldOfStudyId: fieldOfStudy.id,
      name: `Ola ${tag}`,
    })
  );

  const team = yield* transactional(
    (yield* TeamRepository).create({
      defaultTerm: 2,
      departmentId: department.id,
      function: "recruitment",
      groupEmail: null,
      name: `Team ${tag}`,
    })
  );

  return {
    department,
    fieldOfStudy,
    leaderPosition: yield* positionNamed("Leder"),
    memberPosition: yield* positionNamed("Medlem"),
    person,
    team,
  };
});

/** Two people of one field of study, the first created having the lower id. */
export const twoPeople = Effect.fnUntraced(function* twoPeople(
  fieldOfStudyId: FieldOfStudyId,
  tag: string
) {
  const people = yield* PersonRepository;

  const first = yield* transactional(
    people.create({
      email: EmailAddress.make(`${tag}.a@example.org`),
      fieldOfStudyId,
      name: `A ${tag}`,
    })
  );

  const second = yield* transactional(
    people.create({
      email: EmailAddress.make(`${tag}.b@example.org`),
      fieldOfStudyId,
      name: `B ${tag}`,
    })
  );

  return [first, second] as const;
});

/** The person's lock, as a command takes it first. It needs a transaction (`transactional`). */
export const lockPerson = (personId: PersonId) =>
  AggregateLocks.use((locks) => locks.lock("Person", personId));

/** Runs a write of the person's rows in a transaction of its own, as a fixture writes outside a command. */
export const asPerson = <A, E, R>(
  personId: PersonId,
  write: (locked: Locked<"Person">) => Effect.Effect<A, E, R>
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

/**
 * A place on the admin list for the person, in a transaction of its own: the list's lock first, then the person's, as
 * `createAdminGrant` takes them.
 */
export const grantPlace = (
  personId: PersonId,
  draft: Omit<AdminGrantDraft, "personId">
) =>
  transactional(
    Effect.gen(function* grantOnList() {
      const adminList = yield* lockAdminList;
      const locked = yield* lockPerson(personId);

      return yield* AdminGrantRepository.use((grants) =>
        grants.create(adminList, locked, draft)
      );
    })
  );

/**
 * `AdminGrantRepository.revoke` as `deleteAdminGrant` calls it, in a transaction of its own: the list's lock first, then
 * the holder's.
 */
export const revokePlace = (
  holderId: PersonId,
  id: AdminGrantId,
  validAfter: DateTime.Utc
) =>
  transactional(
    Effect.gen(function* revokeFromList() {
      const adminList = yield* lockAdminList;
      const holder = yield* lockPerson(holderId);

      return yield* AdminGrantRepository.use((grants) =>
        grants.revoke(adminList, holder, id, validAfter)
      );
    })
  );
