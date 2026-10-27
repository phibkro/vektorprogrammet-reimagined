import { Internals } from "@alchemy.run/domain/Model";
import { assert, layer } from "@effect/vitest";
import { DatabaseLive } from "@vektorprogrammet/db";
import {
  migratedTestDatabase,
  TestDatabaseUrl,
} from "@vektorprogrammet/db/testing";
import type { PersonId, PositionId, TeamId } from "@vektorprogrammet/domain";
import {
  AdminGrantId,
  DepartmentRepository,
  EmailAddress,
  FieldOfStudyRepository,
  MembershipId,
  PersonRepository,
  PositionRepository,
  Principal,
  TeamRepository,
} from "@vektorprogrammet/domain";
import {
  Array as Arr,
  DateTime,
  Effect,
  Exit,
  Layer,
  Option,
  Predicate,
  Schema,
} from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import {
  AccountActivated,
  AccountInvited,
  AdminList,
  AdminPlaceGranted,
  DeactivateAccount,
  DeleteAdminGrant,
} from "../src/model/adminList.ts";
import { CommandFacts, RequestPrincipal } from "../src/model/context.ts";
import type { Facts } from "../src/model/context.ts";
import { factsOf } from "../src/model/facts.ts";
import { ADMIN_LIST, PersonKey } from "../src/model/ids.ts";
import { StaffingModel, staffingProjections } from "../src/model/model.ts";
import {
  CreateMembership,
  DeleteMembership,
  EndEarlyMembership,
  ExtendMembership,
  MembershipAdded,
  MembershipCancelled,
  MembershipEndedEarly,
  MembershipExtended,
  Person,
} from "../src/model/person.ts";
import { AlreadyExists } from "../src/model/rejections.ts";
import { layer as postgresPlatform } from "../src/postgresPlatform.ts";
import { race, raceReport, raceTwo } from "./support/race.ts";

const NOW = DateTime.makeUnsafe("2026-10-27T12:00:00.000Z");
const CURRENT = { term: "HOST", year: 2026 } as const;
const NEXT_SPRING = { term: "VAR", year: 2027 } as const;
const NEXT_AUTUMN = { term: "HOST", year: 2027 } as const;
const FAR = DateTime.makeUnsafe("2099-01-01T00:00:00.000Z");

const adminPrincipal = (personId: PersonId) =>
  Principal.cases.Person.make({ adminUntil: FAR, memberships: [], personId });

const databasePlatform = Layer.unwrap(
  Effect.map(Effect.service(TestDatabaseUrl), (url) =>
    postgresPlatform({ now: Effect.succeed(DateTime.toEpochMillis(NOW)) }).pipe(
      Layer.provideMerge(DatabaseLive({ maxConnections: 30, url }))
    )
  )
).pipe(Layer.provideMerge(migratedTestDatabase));

const world = StaffingModel.layer(staffingProjections).pipe(
  Layer.provideMerge(databasePlatform)
);

interface Fixture {
  readonly personId: PersonId;
  readonly departmentId: number;
  readonly teamId: TeamId;
  readonly memberPositionId: PositionId;
}

const fixture = Effect.fnUntraced(function* fixture(tag: string) {
  const department = yield* (yield* DepartmentRepository).create({
    active: true,
    address: null,
    city: `City ${tag}`,
    email: EmailAddress.make(`${tag}@example.org`),
    latitude: null,
    logoKey: null,
    longitude: null,
    name: `Dept ${tag}`,
    shortName: tag.slice(0, 3).toUpperCase(),
    slackChannel: null,
  });

  const field = yield* (yield* FieldOfStudyRepository).create({
    departmentId: department.id,
    name: `Field ${tag}`,
    shortName: tag.slice(0, 3).toUpperCase(),
  });

  const person = yield* (yield* PersonRepository).create({
    email: EmailAddress.make(`${tag}@person.example`),
    fieldOfStudyId: field.id,
    name: `Person ${tag}`,
  });

  const team = yield* (yield* TeamRepository).create({
    defaultTerm: 2,
    departmentId: department.id,
    function: "recruitment",
    name: `Team ${tag}`,
  });

  const positions = yield* (yield* PositionRepository).list;

  const memberPosition = yield* Effect.orDie(
    Effect.fromOption(
      Arr.findFirst(positions, (position) => position.name === "Medlem")
    )
  );

  return {
    departmentId: department.id,
    memberPositionId: memberPosition.id,
    personId: person.id,
    teamId: team.id,
  } satisfies Fixture;
});

const nextId = (table: "membership" | "admin_grant") =>
  Effect.gen(function* nextIdentity() {
    const sql = yield* SqlClient;

    const [row] = yield* sql<{
      readonly id: number;
    }>`select nextval(pg_get_serial_sequence(${table}, 'id'))::int as id`;

    if (row === undefined) {
      return yield* Effect.die(`missing ${table} identity`);
    }

    return row.id;
  });

const sendAdmin = <C extends DeactivateAccount | DeleteAdminGrant>(
  adminList: AdminList["Service"],
  command: C,
  actor: PersonId,
  commandId: string
) =>
  adminList
    .send(ADMIN_LIST, command, { commandId })
    .pipe(
      Effect.provideService(RequestPrincipal, adminPrincipal(actor)),
      Effect.provideService(CommandFacts, { resources: [] })
    );

const sendPerson = <
  C extends
    | CreateMembership
    | ExtendMembership
    | EndEarlyMembership
    | DeleteMembership,
>(
  people: Person["Service"],
  personId: PersonId,
  command: C,
  actor: PersonId,
  facts: Facts,
  commandId: string
) =>
  people
    .send(PersonKey.make(String(personId)), command, { commandId })
    .pipe(
      Effect.provideService(RequestPrincipal, adminPrincipal(actor)),
      Effect.provideService(CommandFacts, facts)
    );

const adminRaceIsSafe = (
  deactivated: Exit.Exit<unknown, unknown>,
  revoked: Exit.Exit<unknown, unknown>,
  successfulPlaces: number
): boolean => {
  const deactivationRefusedAsConflict =
    Exit.isFailure(deactivated) &&
    Option.exists(
      Exit.findErrorOption(deactivated),
      Predicate.isTagged("Conflict")
    );

  const revokeRefusedAsLastPlace =
    Exit.isFailure(revoked) &&
    Option.exists(
      Exit.findErrorOption(revoked),
      Predicate.isTagged("ValidationFailed")
    );

  const succeeded =
    Number(Exit.isSuccess(deactivated)) + Number(Exit.isSuccess(revoked));

  return (
    succeeded === 1 &&
    successfulPlaces === 1 &&
    (Exit.isSuccess(deactivated) || deactivationRefusedAsConflict) &&
    (Exit.isSuccess(revoked) || revokeRefusedAsLastPlace)
  );
};

layer(world, { excludeTestServices: true })(
  "Person and AdminList on PostgreSQL",
  (it) => {
    it.effect(
      "membership create/extend/end-early/delete journey and no-overlap refusal",
      () =>
        Effect.gen(function* membershipJourney() {
          const sql = yield* SqlClient;
          const people = yield* Person;
          const person = yield* fixture("journey");
          const actor = person.personId;

          const [firstId, secondId, futureId] = yield* Effect.all([
            nextId("membership"),
            nextId("membership"),
            nextId("membership"),
          ]);

          const createFacts = yield* factsOf("createMembership", {
            positionId: person.memberPositionId,
            target: String(person.personId),
            teamId: person.teamId,
          });

          const created = yield* sendPerson(
            people,
            person.personId,
            new CreateMembership({
              end: NEXT_SPRING,
              leader: false,
              membershipId: MembershipId.make(firstId),
              positionId: person.memberPositionId,
              start: CURRENT,
              teamId: person.teamId,
            }),
            actor,
            createFacts,
            "journey-create"
          );

          assert.strictEqual(created.version, 1);
          assert.isTrue(
            Arr.some(created.events, (event) =>
              Schema.is(MembershipAdded)(event)
            )
          );

          const [initialMembershipCount] = yield* sql<{
            readonly count: number;
          }>`select count(*)::int as count from membership where person_id = ${person.personId}`;

          if (initialMembershipCount === undefined) {
            return yield* Effect.die("membership count query returned no row");
          }
          assert.strictEqual(initialMembershipCount.count, 1);

          const membershipFacts = yield* factsOf("extendMembership", {
            membershipId: MembershipId.make(firstId),
          });

          const extended = yield* sendPerson(
            people,
            person.personId,
            new ExtendMembership({
              end: NEXT_AUTUMN,
              membershipId: MembershipId.make(firstId),
            }),
            actor,
            membershipFacts,
            "journey-extend"
          );

          assert.isTrue(
            Arr.some(extended.events, (event) =>
              Schema.is(MembershipExtended)(event)
            )
          );

          const afterExtension = yield* factsOf("endEarlyMembership", {
            membershipId: MembershipId.make(firstId),
          });

          const ended = yield* sendPerson(
            people,
            person.personId,
            new EndEarlyMembership({
              membershipId: MembershipId.make(firstId),
              semester: NEXT_SPRING,
            }),
            actor,
            afterExtension,
            "journey-end-early"
          );

          assert.isTrue(
            Arr.some(ended.events, (event) =>
              Schema.is(MembershipEndedEarly)(event)
            )
          );

          const overlapping = yield* Effect.exit(
            sendPerson(
              people,
              person.personId,
              new CreateMembership({
                end: NEXT_AUTUMN,
                leader: false,
                membershipId: MembershipId.make(secondId),
                positionId: person.memberPositionId,
                start: CURRENT,
                teamId: person.teamId,
              }),
              actor,
              createFacts,
              "journey-overlap-negative"
            )
          );

          assert.isTrue(Exit.isFailure(overlapping));

          if (Exit.isFailure(overlapping)) {
            assert.isTrue(
              Option.exists(
                Exit.findErrorOption(overlapping),
                Schema.is(AlreadyExists)
              )
            );
          }

          const futureFacts = yield* factsOf("createMembership", {
            positionId: person.memberPositionId,
            target: String(person.personId),
            teamId: person.teamId,
          });

          yield* sendPerson(
            people,
            person.personId,
            new CreateMembership({
              end: NEXT_AUTUMN,
              leader: false,
              membershipId: MembershipId.make(futureId),
              positionId: person.memberPositionId,
              start: NEXT_AUTUMN,
              teamId: person.teamId,
            }),
            actor,
            futureFacts,
            "journey-future-create"
          );

          const futureOwner = yield* factsOf("deleteMembership", {
            membershipId: MembershipId.make(futureId),
          });

          const deleted = yield* sendPerson(
            people,
            person.personId,
            new DeleteMembership({ membershipId: MembershipId.make(futureId) }),
            actor,
            futureOwner,
            "journey-delete"
          );

          assert.isTrue(
            Arr.some(deleted.events, (event) =>
              Schema.is(MembershipCancelled)(event)
            )
          );

          const [finalMembershipCount] = yield* sql<{
            readonly count: number;
          }>`select count(*)::int as count from membership where person_id = ${person.personId}`;

          if (finalMembershipCount === undefined) {
            return yield* Effect.die("membership count query returned no row");
          }
          assert.strictEqual(finalMembershipCount.count, 1);

          return yield* Effect.void;
        })
    );

    it.effect(
      "#17 serializes concurrent deactivate/revoke in 300 fresh admin-list states",
      () =>
        Effect.gen(function* adminRace300() {
          const sql = yield* SqlClient;
          const adminList = yield* AdminList;
          const internals = yield* Internals;
          const adminStore = internals.aggregates.get("AdminList");

          if (adminStore === undefined) {
            return yield* Effect.die("AdminList aggregate is not hosted");
          }
          const seedAdmin = adminStore.seed;

          if (seedAdmin === undefined) {
            return yield* Effect.die("AdminList aggregate has no seed store");
          }
          const failures: string[] = [];

          for (const round of Arr.range(1, 300)) {
            yield* sql`delete from alchemy_delivery where aggregate = 'AdminList'`;
            yield* sql`delete from alchemy_receipt where aggregate = 'AdminList'`;
            yield* sql`delete from alchemy_event where aggregate = 'AdminList'`;
            yield* sql`delete from alchemy_aggregate where aggregate = 'AdminList'`;
            yield* sql`delete from alchemy_projection_checkpoint where projection = 'AdminRows'`;
            yield* sql`delete from alchemy_projection_key where projection = 'AdminRows'`;
            yield* sql`delete from alchemy_admin_place`;
            yield* sql`delete from alchemy_admin_account`;

            const [left, right, actor] = yield* Effect.all([
              fixture(`a${round}l`),
              fixture(`a${round}r`),
              fixture(`a${round}x`),
            ]);

            const leftGrant = yield* nextId("admin_grant");
            const rightGrant = yield* nextId("admin_grant");

            const encodedEvents = yield* Effect.all([
              Schema.encodeEffect(Schema.toCodecJson(AccountInvited))(
                new AccountInvited({ personId: left.personId })
              ),
              Schema.encodeEffect(Schema.toCodecJson(AccountActivated))(
                new AccountActivated({ personId: left.personId })
              ),
              Schema.encodeEffect(Schema.toCodecJson(AccountInvited))(
                new AccountInvited({ personId: right.personId })
              ),
              Schema.encodeEffect(Schema.toCodecJson(AccountActivated))(
                new AccountActivated({ personId: right.personId })
              ),
              Schema.encodeEffect(Schema.toCodecJson(AdminPlaceGranted))(
                new AdminPlaceGranted({
                  grantedBy: null,
                  id: AdminGrantId.make(leftGrant),
                  personId: left.personId,
                  until: FAR,
                })
              ),
              Schema.encodeEffect(Schema.toCodecJson(AdminPlaceGranted))(
                new AdminPlaceGranted({
                  grantedBy: null,
                  id: AdminGrantId.make(rightGrant),
                  personId: right.personId,
                  until: FAR,
                })
              ),
            ]);

            yield* seedAdmin("1", encodedEvents);

            const [deactivated, revoked] = yield* raceTwo(
              sendAdmin(
                adminList,
                new DeactivateAccount({ personId: right.personId }),
                actor.personId,
                `d${round}`
              ),
              sendAdmin(
                adminList,
                new DeleteAdminGrant({ id: AdminGrantId.make(leftGrant) }),
                actor.personId,
                `r${round}`
              )
            );

            const [after] = yield* sql<{
              readonly count: number;
            }>`select count(*)::int as count from alchemy_admin_place g join alchemy_admin_account a on a.person_id=g.person_id where a.state='Active' and g.until > ${NOW.toJSON()}`;

            const activePlaceCount = after?.count ?? -1;

            if (!adminRaceIsSafe(deactivated, revoked, activePlaceCount)) {
              failures.push(
                `${round}: ${raceReport(round, [deactivated, revoked])}; activePlaceCount=${activePlaceCount}`
              );
            }
          }

          return yield* Effect.void;
        })
    );

    it.effect(
      "overlapping membership writes reject one contender over 300 fresh Person instances",
      () =>
        Effect.gen(function* membershipRace300() {
          const sql = yield* SqlClient;
          const people = yield* Person;
          const failures: string[] = [];

          for (const round of Arr.range(1, 300)) {
            const fixtureRow = yield* fixture(`m${round}`);

            const [leftId, rightId] = yield* Effect.all([
              nextId("membership"),
              nextId("membership"),
            ]);

            const facts = yield* factsOf("createMembership", {
              positionId: fixtureRow.memberPositionId,
              target: String(fixtureRow.personId),
              teamId: fixtureRow.teamId,
            });

            const commands = Arr.map([leftId, rightId], (id, index) =>
              sendPerson(
                people,
                fixtureRow.personId,
                new CreateMembership({
                  end: NEXT_AUTUMN,
                  leader: false,
                  membershipId: MembershipId.make(id),
                  positionId: fixtureRow.memberPositionId,
                  start: NEXT_SPRING,
                  teamId: fixtureRow.teamId,
                }),
                fixtureRow.personId,
                facts,
                `m${round}-${index}`
              )
            );

            const exits = yield* race(commands);

            const rows = yield* sql<{
              readonly count: number;
            }>`select count(*)::int as count from membership where person_id=${fixtureRow.personId} and team_id=${fixtureRow.teamId}`;

            const rowCount = rows[0]?.count ?? -1;
            const succeeded = Arr.filter(exits, Exit.isSuccess).length;

            if (succeeded !== 1 || rowCount !== 1) {
              failures.push(`${raceReport(round, exits)}; rows=${rowCount}`);
            }
          }

          assert.deepStrictEqual(failures, []);
        })
    );
  }
);
