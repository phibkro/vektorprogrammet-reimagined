/**
 * The local seed (spec 0006): the people that `vp dev` and the browser tests can act as. The local test actor is a
 * seeded person chosen by name (the `vp-test-actor` cookie); there is no sign-in before spec 0007. It runs after the
 * organisation data is in (the importer's fixture for the browser tests, or whatever the local database holds), uses
 * the first department that has a field of study (and makes one if the database has none), and is safe to run again:
 * every row is found by its natural key before it is created.
 *
 * - Ada Admin holds an admin place, and no membership.
 * - Lise Leder leads the recruitment team of the department; Mats Medlem is a member of it.
 * - Sofie Styre is a member of the department's board team.
 * - Nora Nybegynner is registered and belongs to no team: she sees no section of the control panel.
 * - Eva Ekstern belonged to the recruitment team until last semester: an ended membership gives no access.
 *
 * Every name and address is fake (`example.org`). The terms follow the current semester, so the memberships are
 * active whenever the seed runs.
 */
import {
  AccountRepository,
  AdminGrantRepository,
  DepartmentRepository,
  EmailAddress,
  FieldOfStudyRepository,
  MembershipRepository,
  PersonRepository,
  PositionRepository,
  PrincipalDirectory,
  TeamRepository,
  advanceSemester,
  currentSemester,
  defaultEnd,
} from "@vektorprogrammet/domain";
import type {
  Department,
  FieldOfStudy,
  Person,
  Semester,
  Team,
  TeamFunction,
} from "@vektorprogrammet/domain";
import { hashSync as bcryptHash } from "bcryptjs";
import { Array as Arr, DateTime, Effect, Option, Order, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { LOCAL_FAKE_PASSWORD, LOCAL_PEOPLE } from "../../src/localPeople.ts";
import { activateAccount } from "./accountsWorld.ts";
import { asPerson } from "./teamsWorld.ts";

const byId = Order.mapInput(
  Order.Number,
  (row: { readonly id: number }) => row.id
);

const emailOf = (name: string) =>
  EmailAddress.make(`${name.toLowerCase().replaceAll(" ", ".")}@example.org`);

/** The first department with a field of study; the seed makes both when the database has none. */
const placeOfSeed = Effect.gen(function* placeOfSeed() {
  const departments = yield* DepartmentRepository;
  const fieldsOfStudy = yield* FieldOfStudyRepository;

  for (const department of Arr.sort(yield* departments.list, byId)) {
    const [field] = yield* fieldsOfStudy.listByDepartment(department.id);

    if (field !== undefined) {
      return { department, field };
    }
  }

  const department: Department = yield* departments.create({
    active: true,
    address: null,
    city: "Lokalby",
    email: EmailAddress.make("lokalby@example.org"),
    latitude: null,
    logoKey: null,
    longitude: null,
    name: "Vektorprogrammet Lokalby",
    shortName: "LOK",
    slackChannel: null,
  });

  const field: FieldOfStudy = yield* fieldsOfStudy.create({
    departmentId: department.id,
    name: "Informatikk",
    shortName: "INF",
  });

  return { department, field };
});

const teamNamed = Effect.fnUntraced(function* teamNamed(
  department: Department,
  name: string,
  teamFunction: TeamFunction
): Effect.fn.Return<Team, never, TeamRepository> {
  const teams = yield* TeamRepository;

  const existing = Arr.findFirst(
    yield* teams.list(department.id),
    (team) => team.name === name
  );

  return Option.isSome(existing)
    ? existing.value
    : yield* Effect.orDie(
        teams.create({
          defaultTerm: 2,
          departmentId: department.id,
          function: teamFunction,
          name,
        })
      );
});

const personNamed = Effect.fnUntraced(function* personNamed(
  name: string,
  field: FieldOfStudy
): Effect.fn.Return<Person, never, PersonRepository | PrincipalDirectory> {
  const people = yield* PersonRepository;
  const directory = yield* PrincipalDirectory;

  const known = yield* directory.byName(name, {
    current: yield* currentSemester,
    now: yield* DateTime.now,
  });

  return Option.isSome(known)
    ? yield* Effect.orDie(people.findById(known.value.personId))
    : yield* Effect.orDie(
        people.create({
          email: emailOf(name),
          fieldOfStudyId: field.id,
          name,
        })
      );
});

/** Puts `person` on `team` for the term; a term that is already there (a second run) is left as it is. */
const join = Effect.fnUntraced(function* join(
  person: Person,
  team: Team,
  positionName: "Leder" | "Medlem",
  term: { readonly start: Semester; readonly end: Semester }
) {
  const positions = yield* (yield* PositionRepository).list;

  const position = yield* Effect.orDie(
    Effect.fromOption(
      Arr.findFirst(positions, (found) => found.name === positionName)
    )
  );

  yield* asPerson(person.id, (locked) =>
    MembershipRepository.use((memberships) =>
      memberships.insert(locked, {
        ...term,
        leader: positionName === "Leder",
        positionId: position.id,
        teamId: team.id,
      })
    )
  ).pipe(Effect.catchTag("AlreadyExists", () => Effect.void));
});

/** EX-0018: seed fake Better Auth credentials outside any domain command transaction. */
const seedFakeAccounts = Effect.fnUntraced(function* seedFakeAccounts(
  people: readonly Person[]
) {
  const sql = yield* SqlClient;
  const accounts = yield* AccountRepository;
  const instant = yield* DateTime.now;
  const now = DateTime.toDateUtc(instant);

  const passwordHash = yield* Effect.try(() =>
    bcryptHash(LOCAL_FAKE_PASSWORD, 12)
  ).pipe(Effect.orDie);

  const decodeUser = Schema.decodeUnknownEffect(
    Schema.Struct({ id: Schema.NonEmptyString })
  );

  for (const person of people) {
    const id = `fake-${person.id}`;

    yield* asPerson(person.id, (locked) =>
      Effect.gen(function* seedAccount() {
        if (Option.isNone(yield* accounts.findLocked(locked))) {
          yield* Effect.orDie(activateAccount(locked));
        }

        yield* accounts.verifyEmail(locked).pipe(Effect.orDie);
      })
    );
    yield* sql`insert into auth_user (id, person_id, name, email, email_verified, created_at, updated_at)
      values (${id}, ${person.id}, ${person.name}, ${person.email}, true, ${now}, ${now}) on conflict do nothing`.pipe(
      Effect.orDie
    );

    const rows =
      yield* sql`select id from auth_user where person_id = ${person.id}`.pipe(
        Effect.orDie
      );

    const user = yield* decodeUser(rows[0]).pipe(Effect.orDie);
    yield* sql`insert into auth_account (id, account_id, provider_id, user_id, password, credential_version, created_at, updated_at)
      values (${`credential-${person.id}`}, ${user.id}, 'credential', ${user.id}, ${passwordHash}, 0, ${now}, ${now})
      on conflict do nothing`.pipe(Effect.orDie);
  }
});

/** The seed. It needs the repositories that `DatabaseLive` provides. */
export const seedLocal = Effect.gen(function* seedLocal() {
  const { department, field } = yield* placeOfSeed;
  const current = yield* currentSemester;
  const thisTerm = { end: defaultEnd(current, 2), start: current };

  const recruitment = yield* teamNamed(
    department,
    "Rekruttering",
    "recruitment"
  );

  const board = yield* teamNamed(department, "Styret", "board");
  const ada = yield* personNamed("Ada Admin", field);
  const lise = yield* personNamed("Lise Leder", field);
  const mats = yield* personNamed("Mats Medlem", field);
  const sofie = yield* personNamed("Sofie Styre", field);
  const eva = yield* personNamed("Eva Ekstern", field);
  const nora = yield* personNamed("Nora Nybegynner", field);
  yield* seedFakeAccounts([ada, lise, nora]);

  const grants = yield* AdminGrantRepository;

  if (!Arr.some(yield* grants.list, (grant) => grant.personId === ada.id)) {
    yield* asPerson(ada.id, (locked) =>
      grants.create(locked, {
        grantedBy: null,
        until: DateTime.makeUnsafe("2099-12-31T23:59:59Z"),
      })
    );
  }

  yield* join(lise, recruitment, "Leder", thisTerm);
  yield* join(mats, recruitment, "Medlem", thisTerm);
  yield* join(sofie, board, "Medlem", thisTerm);

  yield* join(eva, recruitment, "Medlem", {
    end: advanceSemester(current, -1),
    start: advanceSemester(current, -2),
  });

  return { department: department.city, people: LOCAL_PEOPLE.length };
});
