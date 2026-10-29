/**
 * The handlers of `TeamsRpc` (spec 0006) over the in-memory repositories: who may run each command, what it refuses
 * and what it leaves behind. The conditional updates and the constraints are `packages/db`'s tests
 * (`test/teams.postgres.test.ts`); here the repositories keep the same contracts as fakes.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  Array as Arr,
  DateTime,
  Effect,
  Option,
  Predicate,
  String as Str,
} from "effect";
import { TestClock } from "effect/testing";

import {
  AdminGrantRepository,
  AggregateLocks,
  AuditPrincipal,
  Commands,
  FieldOfStudyId,
  MembershipRepository,
  PersonId,
  Principal,
  TeamId,
  Teams,
  TeamsEndpoints,
  anonymous,
  lockAdminList,
} from "../../src/index.ts";
import type {
  DepartmentId,
  DomainError,
  MembershipId,
  PersonPrincipal,
  PositionId,
  Semester,
} from "../../src/index.ts";
import { host, oslo, vaar } from "../support/calendar.ts";
import {
  BERGEN,
  LATE,
  TRONDHEIM,
  TestServices,
  admin,
  asPrincipal,
  auditActions,
  departmentForTest,
  failureTag,
  newPerson,
  seed,
  table,
  teamLeaderTrondheim,
  teamMemberBergen,
} from "../support/inMemory.ts";
import {
  LEADER_POSITION,
  MEMBER_POSITION,
  teamRows,
  withActiveAccount,
} from "../support/teamsInMemory.ts";

const TRONDHEIM_FIELD = FieldOfStudyId.make(1);

const BERGEN_FIELD = FieldOfStudyId.make(2);

const ADMIN_UNTIL = "2099-12-31T23:59:59Z";

/** A principal of a person with one membership; the team id is beside the point of the grant table. */
const inTeam = (
  personId: PersonId,
  departmentId: DepartmentId,
  options: {
    readonly leader: boolean;
    readonly function: "board" | "recruitment";
  }
): PersonPrincipal =>
  Principal.cases.Person.make({
    memberships: [
      {
        departmentId,
        function: options.function,
        leader: options.leader,
        teamId: TeamId.make(1),
      },
    ],
    personId,
  });

const boardMemberTrondheim = inTeam(PersonId.make(104), TRONDHEIM, {
  function: "board",
  leader: false,
});

const memberTrondheim = inTeam(PersonId.make(105), TRONDHEIM, {
  function: "recruitment",
  leader: false,
});

const leaderBergen = inTeam(PersonId.make(106), BERGEN, {
  function: "recruitment",
  leader: true,
});

const adminOf = (personId: PersonId) =>
  Principal.cases.Person.make({ adminUntil: LATE, memberships: [], personId });

const issuePaths = (error: DomainError): readonly string[] =>
  Predicate.isTagged(error, "ValidationFailed")
    ? Arr.map(error.issues, (issue) => Arr.join(issue.path, "."))
    : [];

const newTeam = (
  departmentId: DepartmentId,
  name: string,
  defaultTerm: 1 | 2 = 2
) =>
  asPrincipal(admin)(
    TeamsEndpoints.createTeam({
      defaultTerm,
      departmentId,
      function: "recruitment",
      groupEmail: null,
      name,
    })
  );

/** What a leader sends to put a person on a team; `options` change the position, the leader flag or the end. */
interface JoinOptions {
  readonly end?: Semester;
  readonly leader?: boolean;
  readonly positionId?: PositionId;
}

const joinWith = (
  teamId: TeamId,
  personId: PersonId,
  start: Semester,
  options: JoinOptions = {}
) => ({
  leader: false,
  personId,
  positionId: MEMBER_POSITION,
  start,
  teamId,
  ...options,
});

const addAs = (
  principal: Principal,
  teamId: TeamId,
  personId: PersonId,
  start: Semester,
  options: JoinOptions = {}
) =>
  asPrincipal(principal)(
    TeamsEndpoints.createMembership(joinWith(teamId, personId, start, options))
  );

const createTeamAs = (
  name: string,
  principal: Principal,
  departmentId: DepartmentId
) =>
  Effect.exit(
    asPrincipal(principal)(
      TeamsEndpoints.createTeam({
        defaultTerm: 1,
        departmentId,
        function: "it",
        groupEmail: null,
        name: `${name} team`,
      })
    )
  );

const editTeamAs = (principal: Principal, id: TeamId) =>
  Effect.exit(
    asPrincipal(principal)(
      TeamsEndpoints.updateTeam({
        defaultTerm: 1,
        function: "economy",
        groupEmail: null,
        id,
        name: "Økonomi",
      })
    )
  );

const grantAs = (
  principal: Principal,
  personId: PersonId,
  until: string = ADMIN_UNTIL
) =>
  Effect.exit(
    asPrincipal(principal)(TeamsEndpoints.createAdminGrant({ personId, until }))
  );

const revokeAs = (principal: Principal, id: number) =>
  Effect.exit(asPrincipal(principal)(TeamsEndpoints.deleteAdminGrant({ id })));

/** Two departments with a field of study each, a team in Trondheim, and a person in each department. */
const world = Effect.gen(function* world() {
  yield* TestClock.setTime(
    DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-15T10:00:00Z"))
  );
  yield* seed.department(departmentForTest(TRONDHEIM, "Trondheim"));
  yield* seed.department(departmentForTest(BERGEN, "Bergen"));
  yield* seed.fieldOfStudy({
    departmentId: TRONDHEIM,
    id: TRONDHEIM_FIELD,
    name: "Informatikk",
    shortName: "INF",
  });
  yield* seed.fieldOfStudy({
    departmentId: BERGEN,
    id: BERGEN_FIELD,
    name: "Fysikk",
    shortName: "FYS",
  });

  return {
    kari: yield* newPerson("Kari", TRONDHEIM_FIELD),
    ola: yield* newPerson("Ola", TRONDHEIM_FIELD),
    per: yield* newPerson("Per", BERGEN_FIELD),
    team: yield* newTeam(TRONDHEIM, "Rekruttering"),
  };
});

/** The world, and Ola on the team from Høst 2026 for the default term unless `options` say otherwise. */
const withMembership = (options: JoinOptions = {}) =>
  Effect.gen(function* scenario() {
    const found = yield* world;

    const membership = yield* addAs(
      teamLeaderTrondheim,
      found.team.id,
      found.ola.id,
      host(2026),
      options
    );

    return { ...found, membership };
  });

/** One active and one planned membership of the same person. */
const withPlannedMembership = Effect.gen(function* withPlannedMembership() {
  const found = yield* withMembership();

  const planned = yield* addAs(
    teamLeaderTrondheim,
    found.team.id,
    found.ola.id,
    host(2028)
  );

  return { ...found, planned };
});

const assertNoMemberships = Effect.gen(function* assertNoMemberships() {
  assert.deepStrictEqual(yield* teamRows((tables) => tables.memberships), []);
});

const memberOf = (id: MembershipId) =>
  MembershipRepository.use((memberships) => memberships.findById(id));

const endAsAdmin = (id: MembershipId, semester: Semester) =>
  Effect.exit(
    asPrincipal(admin)(TeamsEndpoints.endEarlyMembership({ id, semester }))
  );

const cancelAsLeader = (id: MembershipId) =>
  Effect.exit(
    asPrincipal(teamLeaderTrondheim)(TeamsEndpoints.deleteMembership({ id }))
  );

describe("teams: who creates and edits a team (RULE-157, RULE-321, RULE-233)", () => {
  it.effect(
    "RULE-179: team group addresses are normalized, validated and unique",
    () =>
      Effect.gen(function* teamGroups() {
        yield* world;

        const created = yield* asPrincipal(admin)(
          TeamsEndpoints.createTeam({
            defaultTerm: 1,
            departmentId: TRONDHEIM,
            function: "it",
            groupEmail: "  TEAM@VEKTORPROGRAMMET.NO  ",
            name: "IT",
          })
        );

        assert.strictEqual(created.groupEmail, "team@vektorprogrammet.no");

        const edited = yield* asPrincipal(admin)(
          TeamsEndpoints.updateTeam({
            defaultTerm: 1,
            function: "it",
            groupEmail: "new@vektorprogrammet.no",
            id: created.id,
            name: "IT",
          })
        );

        assert.strictEqual(edited.groupEmail, "new@vektorprogrammet.no");

        const duplicate = yield* Effect.flip(
          asPrincipal(admin)(
            TeamsEndpoints.createTeam({
              defaultTerm: 1,
              departmentId: BERGEN,
              function: "it",
              groupEmail: "new@vektorprogrammet.no",
              name: "Other",
            })
          )
        );

        assert.strictEqual(duplicate._tag, "Conflict");

        const invalid = yield* Effect.flip(
          asPrincipal(admin)(
            TeamsEndpoints.updateTeam({
              defaultTerm: 1,
              function: "it",
              groupEmail: "team@example.org",
              id: created.id,
              name: "IT",
            })
          )
        );

        assert.deepStrictEqual(issuePaths(invalid), ["groupEmail"]);
        const rows = yield* teamRows((tables) => tables.teams);
        assert.strictEqual(
          Arr.findFirst(rows, (team) => team.id === created.id).pipe(
            Option.getOrThrow
          ).groupEmail,
          "new@vektorprogrammet.no"
        );
      }).pipe(Effect.provide(TestServices))
  );
  it.effect(
    "RULE-157: a team name is unique within a department; the same name in another department is fine",
    () =>
      Effect.gen(function* effectProgram() {
        yield* world;
        const again = yield* Effect.flip(newTeam(TRONDHEIM, "Rekruttering"));
        const bergen = yield* newTeam(BERGEN, "Rekruttering");

        assert.strictEqual(again._tag, "AlreadyExists");
        assert.strictEqual(bergen.departmentId, BERGEN);
      }).pipe(Effect.provide(TestServices))
  );

  it.effect(
    "RULE-321: a leader and a board member create and edit teams in their own department; a member, another department's leader and a visitor do not",
    () =>
      Effect.gen(function* effectProgram() {
        const { team } = yield* world;
        const bergenTeam = yield* newTeam(BERGEN, "Rekruttering Bergen");

        const outcomes = yield* Effect.all([
          createTeamAs("Ledernes", teamLeaderTrondheim, TRONDHEIM),
          createTeamAs("Styrets", boardMemberTrondheim, TRONDHEIM),
          createTeamAs("Adminens", admin, BERGEN),
          createTeamAs("Bergens", teamLeaderTrondheim, BERGEN),
          createTeamAs("Medlemmets", memberTrondheim, TRONDHEIM),
          createTeamAs("Gjestens", anonymous, TRONDHEIM),
          editTeamAs(teamLeaderTrondheim, team.id),
          editTeamAs(teamLeaderTrondheim, bergenTeam.id),
          editTeamAs(teamMemberBergen, bergenTeam.id),
        ]);

        assert.deepStrictEqual(Arr.map(outcomes, failureTag), [
          "success",
          "success",
          "success",
          "Forbidden",
          "Forbidden",
          "Forbidden",
          "success",
          "Forbidden",
          "Forbidden",
        ]);
      }).pipe(Effect.provide(TestServices))
  );

  it.effect(
    "RULE-233: a team is deactivated and never deleted; a deactivated team takes no new members",
    () =>
      Effect.gen(function* effectProgram() {
        const { ola, team } = yield* world;

        const deactivated = yield* asPrincipal(teamLeaderTrondheim)(
          TeamsEndpoints.deactivateTeam({ id: team.id })
        );

        const refused = yield* Effect.flip(
          addAs(teamLeaderTrondheim, team.id, ola.id, host(2026))
        );

        assert.isFalse(deactivated.active);
        assert.deepStrictEqual(issuePaths(refused), ["teamId"]);
        assert.isFalse(
          Arr.some(Teams.TeamsDomain.commands, (rpc) =>
            Option.exists(
              Commands.infoOf(rpc),
              (info) => info.resource === "Team" && info.method === "delete"
            )
          ),
          "no command deletes a team"
        );
        assert.deepStrictEqual(yield* auditActions, [
          "person.registered",
          "person.registered",
          "person.registered",
          "team.created",
          "team.deactivated",
        ]);
      }).pipe(Effect.provide(TestServices))
  );
});

it.effect(
  "RULE-179: a new company address is normalized and another domain is refused",
  () =>
    Effect.gen(function* personCompanyAddress() {
      yield* world;

      const invalid = yield* Effect.flip(
        asPrincipal(admin)(
          TeamsEndpoints.createPerson({
            companyEmail: "wrong@example.org",
            email: "bad-fixture@example.org",
            fieldOfStudyId: TRONDHEIM_FIELD,
            name: "Invalid Address",
          })
        )
      );

      assert.deepStrictEqual(issuePaths(invalid), ["companyEmail"]);

      const valid = yield* asPrincipal(admin)(
        TeamsEndpoints.createPerson({
          companyEmail: "  NY@VEKTORPROGRAMMET.NO  ",
          email: "valid-fixture@example.org",
          fieldOfStudyId: TRONDHEIM_FIELD,
          name: "Valid Address",
        })
      );

      assert.strictEqual(valid.companyEmail, "ny@vektorprogrammet.no");
    }).pipe(Effect.provide(TestServices))
);

describe("teams: adding members (RULE-164, RULE-206, RULE-284, ADR 0002)", () => {
  it.effect(
    "RULE-248: only the first membership queues the welcome and setup messages, even after cancellation",
    () =>
      Effect.gen(function* welcomeOnce() {
        const { ola, team } = yield* world;

        const first = yield* addAs(
          teamLeaderTrondheim,
          team.id,
          ola.id,
          host(2027)
        );

        const messages = yield* table((db) => db.outbox);
        assert.deepStrictEqual(
          Arr.map(messages, (message) => message._tag),
          ["Email", "Email"]
        );

        const emails = Arr.flatMap(messages, (message) =>
          Predicate.isTagged(message, "Email") ? [message] : []
        );

        assert.deepStrictEqual(
          Arr.map(emails, (message) => message.subject),
          [
            "Velkommen til Rekruttering",
            "Fullfør oppsettet med din Vektor-epost",
          ]
        );
        assert.deepStrictEqual(
          Arr.map(emails, (message) => message.to),
          [ola.email, ola.email]
        );
        assert.include(
          emails[1]?.text ?? "",
          "Systemet har ikke opprettet en Vektor-konto ennå"
        );
        assert.strictEqual(
          (yield* teamRows((tables) => tables.welcomes)).size,
          1
        );
        assert.strictEqual(
          failureTag(yield* cancelAsLeader(first.id)),
          "success"
        );
        yield* addAs(teamLeaderTrondheim, team.id, ola.id, host(2027));
        assert.strictEqual((yield* table((db) => db.outbox)).length, 2);
      }).pipe(Effect.provide(TestServices))
  );
  it.effect(
    "RULE-164: a person joins a team of their own department only",
    () =>
      Effect.gen(function* effectProgram() {
        const { per, team } = yield* world;

        const refused = yield* Effect.flip(
          addAs(admin, team.id, per.id, host(2026))
        );

        assert.deepStrictEqual(issuePaths(refused), ["personId"]);
        yield* assertNoMemberships;
      }).pipe(Effect.provide(TestServices))
  );

  it.effect(
    "RULE-206, RULE-284: a leader, a board member of the department and an admin add members; a plain member, another department's leader and a visitor are refused",
    () =>
      Effect.gen(function* effectProgram() {
        const { ola, team } = yield* world;
        const allowed = [admin, boardMemberTrondheim, teamLeaderTrondheim];

        const refused = [
          memberTrondheim,
          teamMemberBergen,
          leaderBergen,
          anonymous,
        ];

        const added = yield* Effect.forEach(allowed, (principal, index) =>
          addAs(principal, team.id, ola.id, {
            term: "HOST",
            year: 2030 + index * 2,
          })
        );

        const exits = yield* Effect.forEach(refused, (principal) =>
          Effect.exit(addAs(principal, team.id, ola.id, host(2040)))
        );

        assert.strictEqual(added.length, 3);
        assert.deepStrictEqual(
          Arr.map(exits, failureTag),
          Arr.map(refused, () => "Forbidden")
        );
      }).pipe(Effect.provide(TestServices))
  );

  it.effect(
    "ADR 0002: the end defaults to start + the team's default term − 1, and another end can be chosen",
    () =>
      Effect.gen(function* effectProgram() {
        const { kari, ola, team } = yield* world;
        const single = yield* newTeam(TRONDHEIM, "Enkeltsemester", 1);

        const byDefault = yield* addAs(
          teamLeaderTrondheim,
          team.id,
          ola.id,
          host(2026)
        );

        const oneSemester = yield* addAs(
          teamLeaderTrondheim,
          single.id,
          ola.id,
          host(2026)
        );

        const chosen = yield* addAs(
          teamLeaderTrondheim,
          team.id,
          kari.id,
          host(2026),
          {
            end: host(2027),
          }
        );

        assert.deepStrictEqual(byDefault.end, vaar(2027));
        assert.deepStrictEqual(oneSemester.end, host(2026));
        assert.deepStrictEqual(chosen.end, host(2027));
      }).pipe(Effect.provide(TestServices))
  );

  it.effect(
    "ADR 0002: an end before the start, and a start in the past, are refused",
    () =>
      Effect.gen(function* effectProgram() {
        const { ola, team } = yield* world;

        const backwards = yield* Effect.flip(
          addAs(teamLeaderTrondheim, team.id, ola.id, host(2026), {
            end: vaar(2026),
          })
        );

        const past = yield* Effect.flip(
          addAs(teamLeaderTrondheim, team.id, ola.id, vaar(2026))
        );

        assert.deepStrictEqual(issuePaths(backwards), ["end"]);
        assert.deepStrictEqual(issuePaths(past), ["start"]);
        yield* assertNoMemberships;
      }).pipe(Effect.provide(TestServices))
  );

  it.effect(
    "a person's memberships in one team never overlap, whether by adding or by extending",
    () =>
      Effect.gen(function* effectProgram() {
        const { ola, team } = yield* world;

        const first = yield* addAs(
          teamLeaderTrondheim,
          team.id,
          ola.id,
          host(2026)
        );

        const overlap = yield* Effect.flip(
          addAs(teamLeaderTrondheim, team.id, ola.id, vaar(2027))
        );

        yield* addAs(teamLeaderTrondheim, team.id, ola.id, host(2027));

        const extended = yield* Effect.flip(
          asPrincipal(teamLeaderTrondheim)(
            TeamsEndpoints.extendMembership({ end: host(2027), id: first.id })
          )
        );

        assert.strictEqual(overlap._tag, "AlreadyExists");
        assert.strictEqual(extended._tag, "AlreadyExists");
        assert.strictEqual((yield* teamRows((t) => t.memberships)).length, 2);
      }).pipe(Effect.provide(TestServices))
  );
});

describe("teams: extending, ending, changing and cancelling (RULE-234, RULE-251, RULE-252, RULE-298)", () => {
  it.effect(
    "RULE-234, RULE-251, RULE-252: extendMembership moves the end of an Active membership to a later semester and nothing else; an ended membership is never revived",
    () =>
      Effect.gen(function* effectProgram() {
        const { membership } = yield* withMembership();

        const extend = (end: Semester) =>
          Effect.exit(
            asPrincipal(teamLeaderTrondheim)(
              TeamsEndpoints.extendMembership({ end, id: membership.id })
            )
          );

        const same = yield* extend(vaar(2027));
        const earlier = yield* extend(host(2026));
        const later = yield* extend(host(2027));

        yield* TestClock.setTime(
          DateTime.toEpochMillis(oslo("2028-01-10T12:00:00"))
        );
        const revived = yield* extend(host(2029));

        assert.deepStrictEqual(
          Arr.map([same, earlier, later, revived], failureTag),
          ["Conflict", "Conflict", "success", "Conflict"]
        );
        assert.deepStrictEqual(
          (yield* memberOf(membership.id)).end,
          host(2027)
        );
      }).pipe(Effect.provide(TestServices))
  );

  it.effect(
    "RULE-298: endEarlyMembership by a leader, a board member, an admin or the member themself ends the membership before the semester; another member cannot",
    () =>
      Effect.gen(function* effectProgram() {
        const { membership, ola } = yield* withMembership({ end: host(2027) });

        const own = inTeam(ola.id, TRONDHEIM, {
          function: "recruitment",
          leader: false,
        });

        const end = (principal: Principal) =>
          Effect.exit(
            asPrincipal(principal)(
              TeamsEndpoints.endEarlyMembership({
                id: membership.id,
                semester: host(2027),
              })
            )
          );

        const refused = yield* end(memberTrondheim);
        const resigned = yield* end(own);

        assert.strictEqual(failureTag(refused), "Forbidden");
        assert.strictEqual(failureTag(resigned), "success");
        assert.deepStrictEqual(
          (yield* memberOf(membership.id)).end,
          vaar(2027)
        );
      }).pipe(Effect.provide(TestServices))
  );

  it.effect(
    "endEarlyMembership is refused for a membership that has not started, from the past, and from a semester after the term",
    () =>
      Effect.gen(function* effectProgram() {
        const { membership, planned } = yield* withPlannedMembership;

        const notStarted = yield* endAsAdmin(planned.id, host(2028));
        const past = yield* endAsAdmin(membership.id, vaar(2026));
        const beyond = yield* endAsAdmin(membership.id, host(2029));

        assert.deepStrictEqual(
          Arr.map([notStarted, past, beyond], failureTag),
          ["Conflict", "Conflict", "Conflict"]
        );
      }).pipe(Effect.provide(TestServices))
  );

  it.effect(
    "changeMembership: from a semester the old membership ends before it and a new one starts, so history shows both",
    () =>
      Effect.gen(function* effectProgram() {
        const { membership, ola } = yield* withMembership({ end: host(2027) });

        const changed = yield* asPrincipal(teamLeaderTrondheim)(
          TeamsEndpoints.changeMembership({
            from: vaar(2027),
            id: membership.id,
            leader: true,
            positionId: LEADER_POSITION,
          })
        );

        const history = yield* MembershipRepository.use((memberships) =>
          memberships.listByPerson(ola.id)
        );

        assert.deepStrictEqual(changed.ended.end, host(2026));
        assert.deepStrictEqual(changed.started.start, vaar(2027));
        assert.deepStrictEqual(changed.started.end, host(2027));
        assert.isTrue(changed.started.leader);
        assert.deepStrictEqual(
          Arr.map(history, (row) => [
            row.positionName,
            row.start.year,
            row.start.term,
          ]),
          [
            ["Leder", 2027, "VAR"],
            ["Medlem", 2026, "HOST"],
          ]
        );
      }).pipe(Effect.provide(TestServices))
  );

  it.effect(
    "changeMembership: a move to a team in another department needs the grant there too; an admin has it",
    () =>
      Effect.gen(function* effectProgram() {
        const { membership } = yield* withMembership({ end: host(2027) });
        const bergen = yield* newTeam(BERGEN, "Rekruttering Bergen");

        const move = (principal: Principal) =>
          Effect.exit(
            asPrincipal(principal)(
              TeamsEndpoints.changeMembership({
                from: vaar(2027),
                id: membership.id,
                teamId: bergen.id,
              })
            )
          );

        const refused = yield* move(teamLeaderTrondheim);
        const allowed = yield* move(admin);

        assert.strictEqual(failureTag(refused), "Forbidden");
        assert.strictEqual(failureTag(allowed), "success");
      }).pipe(Effect.provide(TestServices))
  );

  it.effect(
    "deleteMembership removes a membership that has not started, and refuses one that has",
    () =>
      Effect.gen(function* effectProgram() {
        const { membership, planned } = yield* withPlannedMembership;

        const removed = yield* cancelAsLeader(planned.id);
        const started = yield* cancelAsLeader(membership.id);

        assert.strictEqual(failureTag(removed), "success");
        assert.strictEqual(failureTag(started), "Conflict");
        assert.strictEqual((yield* teamRows((t) => t.memberships)).length, 1);
      }).pipe(Effect.provide(TestServices))
  );
});

/**
 * A place on the list that is put there directly, as a fixture does: through the locks of the list and of the person,
 * like every write, and with an Active account for the person, which a place needs to count.
 */
const placeFor = Effect.fnUntraced(function* placeFor(
  personId: PersonId,
  grantedBy: PersonId | null,
  until: DateTime.Utc
) {
  const adminList = yield* lockAdminList;

  const locked = yield* AggregateLocks.use((locks) =>
    locks.lock("Person", personId)
  );

  yield* withActiveAccount(personId);

  return yield* AdminGrantRepository.use((grants) =>
    grants.create(adminList, locked, { grantedBy, until })
  );
});

/** Ada holds the first place (given outside the system), Ola a second one that Ada gave. */
const admins = Effect.gen(function* admins() {
  const { kari, ola } = yield* world;
  const ada = yield* newPerson("Ada", TRONDHEIM_FIELD);
  const first = yield* placeFor(ada.id, null, LATE);
  yield* withActiveAccount(ola.id);

  const second = yield* asPrincipal(adminOf(ada.id))(
    TeamsEndpoints.createAdminGrant({ personId: ola.id, until: ADMIN_UNTIL })
  );

  return { ada, first, kari, ola, second };
});

describe("falsifier 6: the admin list (RULE-113, RULE-308)", () => {
  it.effect(
    "falsifier 6: only an admin grants a place, never to oneself, and the place must end in the future",
    () =>
      Effect.gen(function* effectProgram() {
        const { ada, kari } = yield* admins;

        const outcomes = yield* Effect.all([
          grantAs(adminOf(ada.id), ada.id),
          grantAs(adminOf(ada.id), kari.id, "2026-01-01T00:00:00Z"),
          grantAs(teamLeaderTrondheim, kari.id),
          grantAs(anonymous, kari.id),
          grantAs(adminOf(ada.id), kari.id),
        ]);

        assert.deepStrictEqual(Arr.map(outcomes, failureTag), [
          "Forbidden",
          "ValidationFailed",
          "Forbidden",
          "Forbidden",
          "success",
        ]);
      }).pipe(Effect.provide(TestServices))
  );

  it.effect(
    "falsifier 6: nobody revokes their own place, and the last place that ends after the current semester cannot be revoked",
    () =>
      Effect.gen(function* effectProgram() {
        const { ada, first, kari, ola, second } = yield* admins;

        // Kari held a place that has already ended: it is not a valid one and must not count.
        const expired = yield* placeFor(
          kari.id,
          ada.id,
          DateTime.makeUnsafe("2026-08-31T00:00:00Z")
        );

        const ownPlace = yield* revokeAs(adminOf(ada.id), first.id);
        const notAdmin = yield* revokeAs(teamLeaderTrondheim, second.id);
        const olas = yield* revokeAs(adminOf(ada.id), second.id);
        const lastOne = yield* revokeAs(adminOf(ola.id), first.id);
        const expiredOne = yield* revokeAs(adminOf(ola.id), expired.id);

        assert.deepStrictEqual(
          Arr.map([ownPlace, notAdmin, olas, lastOne, expiredOne], failureTag),
          ["Forbidden", "Forbidden", "success", "ValidationFailed", "success"]
        );
        assert.deepStrictEqual(
          Arr.map(
            yield* AdminGrantRepository.use((grants) => grants.list),
            (grant) => grant.id
          ),
          [first.id]
        );
      }).pipe(Effect.provide(TestServices))
  );

  it.effect(
    "every grant and revocation is audited with the admin who made it",
    () =>
      Effect.gen(function* effectProgram() {
        const { ada, second } = yield* admins;

        yield* asPrincipal(adminOf(ada.id))(
          TeamsEndpoints.deleteAdminGrant({ id: second.id })
        );

        const entries = Arr.filter(yield* table((db) => db.audit), (entry) =>
          Str.startsWith("adminGrant")(entry.action)
        );

        assert.deepStrictEqual(
          Arr.map(entries, (entry) => [entry.action, entry.principal]),
          [
            [
              "adminGrant.granted",
              AuditPrincipal.cases.Person.make({ personId: ada.id }),
            ],
            [
              "adminGrant.revoked",
              AuditPrincipal.cases.Person.make({ personId: ada.id }),
            ],
          ]
        );
      }).pipe(Effect.provide(TestServices))
  );

  it.effect(
    "spec 0006b R2: every command that changes a place locks the admin list first and the person second, in that order",
    () =>
      Effect.gen(function* effectProgram() {
        const { ada, ola, second } = yield* admins;

        yield* asPrincipal(adminOf(ada.id))(
          TeamsEndpoints.deleteAdminGrant({ id: second.id })
        );

        assert.deepStrictEqual(yield* teamRows((tables) => tables.locks), [
          // The fixture: Ada's own place, then the place that Ada gives Ola, then Ada's revocation of it.
          "AdminList:1",
          `Person:${ada.id}`,
          "AdminList:1",
          `Person:${ola.id}`,
          "AdminList:1",
          `Person:${ola.id}`,
        ]);
      }).pipe(Effect.provide(TestServices))
  );
});
