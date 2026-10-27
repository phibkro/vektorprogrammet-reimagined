import { Internals } from "@alchemy.run/domain/Model";
import { Story } from "@alchemy.run/domain/Story";
import { PgClient } from "@effect/sql-pg";
import { assert, layer } from "@effect/vitest";
import { DatabaseLive } from "@vektorprogrammet/db";
import {
  migratedTestDatabase,
  TestDatabaseUrl,
} from "@vektorprogrammet/db/testing";
import {
  ReadOnlyDatabaseUrl,
  readOnlyRole,
} from "@vektorprogrammet/db/testing/read-only-role";
import type { PositionId, TeamId } from "@vektorprogrammet/domain";
import {
  AdminGrantId,
  DepartmentRepository,
  EmailAddress,
  FieldOfStudyRepository,
  MembershipId,
  PersonId,
  PersonRepository,
  PositionRepository,
  Principal,
  TeamRepository,
} from "@vektorprogrammet/domain";
import {
  Array as Arr,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  Predicate,
  Ref,
  Schema,
} from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import {
  AccountActivated,
  AccountDeactivated,
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
import {
  StaffingModel,
  StaffingStoryModel,
  staffingProjections,
} from "../src/model/model.ts";
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
import { AlreadyExists, ValidationFailed } from "../src/model/rejections.ts";
import type { PostgresPlatformOptions } from "../src/postgresPlatform.ts";
import { layer as postgresPlatform } from "../src/postgresPlatform.ts";
import { race, raceReport, raceTwo } from "./support/race.ts";

const NOW = DateTime.makeUnsafe("2026-10-27T12:00:00.000Z");
const CURRENT = { term: "HOST", year: 2026 } as const;
const NEXT_SPRING = { term: "VAR", year: 2027 } as const;
const NEXT_AUTUMN = { term: "HOST", year: 2027 } as const;
const FAR = DateTime.makeUnsafe("2099-01-01T00:00:00.000Z");

const adminPrincipal = (personId: PersonId) =>
  Principal.cases.Person.make({ adminUntil: FAR, memberships: [], personId });

const databasePlatform = (options: PostgresPlatformOptions = {}) =>
  Layer.unwrap(
    Effect.map(Effect.service(TestDatabaseUrl), (url) =>
      postgresPlatform({
        now: Effect.succeed(DateTime.toEpochMillis(NOW)),
        ...options,
      }).pipe(Layer.provideMerge(DatabaseLive({ maxConnections: 30, url })))
    )
  );

const world = StaffingModel.layer(staffingProjections).pipe(
  Layer.provideMerge(databasePlatform()),
  Layer.provideMerge(
    readOnlyRole.pipe(Layer.provideMerge(migratedTestDatabase))
  )
);

const unlockedWorld = Layer.unwrap(
  Effect.gen(function* unlockedWorld() {
    const arrivals = yield* Ref.make(0);
    const bothRead = yield* Deferred.make<null>();

    const afterRead = (aggregate: string, id: string) => {
      if (aggregate !== "AdminList" || id !== "1") {
        return Effect.void;
      }

      return Effect.gen(function* awaitBothReads() {
        const count = yield* Ref.updateAndGet(arrivals, (value) => value + 1);

        if (count === 2) {
          yield* Deferred.succeed(bothRead, null);
        }

        yield* Deferred.await(bothRead);

        return yield* Effect.void;
      });
    };

    return StaffingModel.layer(staffingProjections).pipe(
      Layer.provideMerge(
        databasePlatform({
          afterRead,
          instanceLock: "none",
          versionGuard: false,
        })
      ),
      Layer.provideMerge(migratedTestDatabase)
    );
  })
);

const readOnlyClient = Layer.unwrap(
  Effect.map(Effect.service(ReadOnlyDatabaseUrl), (url) =>
    PgClient.layer({ maxConnections: 1, prepare: false, url })
  )
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
      "command facts and projected membership rows read under the SELECT-only database role",
      () =>
        Effect.gen(function* readOnlyFacts() {
          const person = yield* fixture("readonly");

          const facts = yield* Effect.provide(
            factsOf("createMembership", {
              positionId: person.memberPositionId,
              target: String(person.personId),
              teamId: person.teamId,
            }),
            readOnlyClient
          );

          assert.deepStrictEqual(facts.resources, [
            { departmentId: person.departmentId },
            { departmentId: person.departmentId },
          ]);

          const people = yield* Person;

          const [before] = yield* Effect.provide(
            Effect.gen(function* readProjectionBefore() {
              const sql = yield* SqlClient;

              return yield* sql<{
                readonly count: number;
              }>`select count(*)::int as count from membership`;
            }),
            readOnlyClient
          );

          const membershipId = MembershipId.make(yield* nextId("membership"));

          yield* sendPerson(
            people,
            person.personId,
            new CreateMembership({
              end: NEXT_AUTUMN,
              leader: false,
              membershipId,
              positionId: person.memberPositionId,
              start: NEXT_SPRING,
              teamId: person.teamId,
            }),
            person.personId,
            facts,
            "readonly-projection"
          );

          const [after] = yield* Effect.provide(
            Effect.gen(function* readProjectionAfter() {
              const sql = yield* SqlClient;

              return yield* sql<{
                readonly count: number;
              }>`select count(*)::int as count from membership`;
            }),
            readOnlyClient
          );

          assert.strictEqual(after?.count, Number(before?.count) + 1);

          const write = yield* Effect.provide(
            Effect.gen(function* refuseProjectionWrite() {
              const sql = yield* SqlClient;

              return yield* Effect.exit(
                sql.unsafe("delete from membership where false")
              );
            }),
            readOnlyClient
          );

          assert.isTrue(Exit.isFailure(write));

          return yield* Effect.void;
        })
    );

    it.effect(
      "Story keeps one Active administrator with a valid place when deactivate wins first",
      () =>
        Effect.gen(function* adminStory() {
          const left = PersonId.make(100_001);
          const right = PersonId.make(100_002);
          const actor = PersonId.make(100_003);
          const leftGrant = AdminGrantId.make(900_001);
          const rightGrant = AdminGrantId.make(900_002);
          const ref = AdminList.ref("1");
          const runStory = Story.make(StaffingStoryModel);

          yield* runStory(
            Story.clock(DateTime.toEpochMillis(NOW)),
            Story.given(
              ref,
              new AccountInvited({ personId: left }),
              new AccountActivated({ personId: left }),
              new AccountInvited({ personId: right }),
              new AccountActivated({ personId: right }),
              new AdminPlaceGranted({
                grantedBy: null,
                id: leftGrant,
                personId: left,
                until: FAR,
              }),
              new AdminPlaceGranted({
                grantedBy: null,
                id: rightGrant,
                personId: right,
                until: FAR,
              })
            ),
            Story.provide(RequestPrincipal, adminPrincipal(actor)),
            Story.provide(CommandFacts, { resources: [] }),
            Story.when(ref, new DeactivateAccount({ personId: right })),
            Story.then(ref, new AccountDeactivated({ personId: right })),
            Story.when(ref, new DeleteAdminGrant({ id: leftGrant })),
            Story.rejected(
              new ValidationFailed({
                issues: [
                  {
                    message:
                      "Den siste administratorplassen som varer etter dette semesteret kan ikke fjernes.",
                    path: ["id"],
                  },
                ],
              })
            ),
            Story.state(ref, (state) => {
              const activeWithPlace = Arr.filter(
                state.places,
                (place) =>
                  DateTime.isGreaterThan(place.until, NOW) &&
                  Arr.some(
                    state.accounts,
                    (account) =>
                      account.personId === place.personId &&
                      account.state === "Active"
                  )
              );

              assert.strictEqual(activeWithPlace.length, 1);
              assert.strictEqual(activeWithPlace[0]?.personId, left);
            })
          );

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

          assert.deepStrictEqual(failures, []);

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

layer(unlockedWorld, { excludeTestServices: true })(
  "PostgreSQL lock negative controls",
  (it) => {
    it.effect(
      "negative control: disabling instanceLock and versionGuard makes #17 fail its serialized outcome",
      () =>
        Effect.gen(function* adminRaceWithoutLocks() {
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

          const [left, right, actor] = yield* Effect.all([
            fixture("ucl"),
            fixture("ucr"),
            fixture("uca"),
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
              "unlocked-deactivate"
            ),
            sendAdmin(
              adminList,
              new DeleteAdminGrant({ id: AdminGrantId.make(leftGrant) }),
              actor.personId,
              "unlocked-revoke"
            )
          );

          const rows = yield* sql.unsafe(
            "select count(*)::int as count from alchemy_admin_place g join alchemy_admin_account a on a.person_id = g.person_id where a.state = 'Active' and g.until > $1",
            [NOW.toJSON()]
          );

          const [row] = rows;

          if (row === undefined) {
            return yield* Effect.die(
              "active admin place query returned no row"
            );
          }

          const active = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ count: Schema.Finite })
          )(row).pipe(Effect.orDie);

          const safe = adminRaceIsSafe(deactivated, revoked, active.count);
          const details = raceReport(1, [deactivated, revoked]);
          const losers = Arr.filter([deactivated, revoked], Exit.isFailure);
          assert.strictEqual(losers.length, 1);
          assert.strictEqual(active.count, 1);
          assert.include(details, "UniqueViolation");
          assert.include(details, "alchemy_event_pkey");

          yield* Effect.logInfo(
            `#17 without aggregate locks/version guard: activePlaces=${
              active.count
            }; outcomes=${details}`
          );
          assert.isFalse(
            safe,
            `unlocked control unexpectedly produced a serialized, typed #17 outcome: ${
              details
            }`
          );

          return yield* Effect.void;
        })
    );
  }
);
