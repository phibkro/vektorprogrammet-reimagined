/**
 * Spec 0006 at the server function: each test runs the program a server function runs (`saveTeamProgram`,
 * `addMemberProgram`, the views, ...) through the per-request runtime and the error table, over the domain's in-memory
 * teams repositories (`@vektorprogrammet/domain/testing`). The same commands run on real PostgreSQL in
 * `packages/db`, and the browser tests (`e2e/teams.spec.ts`) drive them over HTTP.
 *
 * The edge between page and command (ADR 0001, ADR 0007): a control is rendered exactly when the command behind it
 * would go through for the principal, for the membership's calculated state.
 */
import { assert, describe, it } from "@effect/vitest";
import { anonymous } from "@vektorprogrammet/domain";
import type { Principal } from "@vektorprogrammet/domain";
import { MEMBER_POSITION } from "@vektorprogrammet/domain/testing";
import { Array as Arr, DateTime, Effect, Option, Ref } from "effect";
import { TestClock } from "effect/testing";

import type { Outcome } from "../src/lib/outcome";
import { SAVED } from "../src/server/panel";
import {
  addMemberProgram,
  adminsView,
  cancelProgram,
  changeProgram,
  deactivateTeamProgram,
  endProgram,
  extendProgram,
  grantAdminProgram,
  peopleView,
  registerPersonProgram,
  revokeAdminProgram,
  saveTeamProgram,
  semesterOfChoice,
  teamView,
  teamsView,
} from "../src/server/teams";
import type { MemberRow } from "../src/server/teams";
import { form, makeTables } from "./support/memory";
import type { MemoryTables } from "./support/memory";
import { assertRefused, assertSuccess, isSuccess } from "./support/outcomes";
import {
  ADMIN,
  WITHOUT_TEAM,
  adminOf,
  leaderOf,
  memberOf,
} from "./support/principals";
import { runAs, viewAs } from "./support/run";
import {
  BERGEN,
  MEMBERSHIPS,
  PEOPLE,
  TRONDHEIM,
  TRONDHEIM_TEAM,
  seedWorld,
} from "./support/teamWorld";

/** 2026-10-15 12:00 in Oslo: Høst 2026, the semester the world's terms are relative to. */
const OCTOBER_15 = DateTime.toEpochMillis(
  DateTime.makeUnsafe("2026-10-15T12:00:00+02:00")
);

/** The world of `teamWorld.ts` at its date. */
const freshWorld = Effect.gen(function* freshWorld() {
  yield* TestClock.setTime(OCTOBER_15);

  const tables = makeTables();
  yield* seedWorld(tables);

  return tables;
});

/** The administrator of the world (`Ada Admin`), whose own place the admin page marks. */
const ADA = adminOf(PEOPLE.ada);

const LISE = leaderOf(TRONDHEIM, { personId: PEOPLE.lise });

/** A plain member acting for their own membership: the one who may resign. */
const MATS = memberOf(TRONDHEIM, { personId: PEOPLE.mats });

/** A member of the board team: manages teams and people, and is no leader. */
const BOARD = memberOf(TRONDHEIM, { function: "board", personId: 777 });

const teamOf = (tables: MemoryTables, principal: Principal) =>
  viewAs(tables, principal, teamView(TRONDHEIM_TEAM));

/** The first row that satisfies `predicate`; a row that is not there fails the test by name. */
const firstOf = <A>(
  rows: readonly A[],
  what: string,
  predicate: (row: A) => boolean
): A =>
  Option.match(Arr.findFirst(rows, predicate), {
    onNone: () => assert.fail(`${what} is listed`),
    onSome: (row) => row,
  });

/** The controls a membership row offers, by the name of the command. */
const controlsOf = (member: MemberRow) =>
  Arr.filter(
    [
      member.canExtend && "extend",
      member.canChange && "change",
      member.canEnd && "end",
      member.canCancel && "cancel",
    ],
    (offered) => offered !== false
  );

describe("spec 0006: the Team page", () => {
  it("a semester choice posts as TERM-YEAR and reads back as the semester; anything else passes through for the domain to refuse", () => {
    assert.deepStrictEqual(semesterOfChoice("HOST-2026"), {
      term: "HOST",
      year: 2026,
    });
    assert.deepStrictEqual(semesterOfChoice("VAR-2027"), {
      term: "VAR",
      year: 2027,
    });
    assert.strictEqual(semesterOfChoice("Høst 2026"), "Høst 2026");
    assert.strictEqual(semesterOfChoice(""), "");
  });

  it.effect(
    "journey: an admin creates a team and registers a person; the leader adds them, extends, changes and ends memberships",
    () =>
      Effect.gen(function* journeyEffect() {
        const tables = yield* freshWorld;

        const created = assertSuccess(
          yield* runAs(
            tables,
            ADMIN,
            saveTeamProgram(
              form({
                defaultTerm: "1",
                departmentId: String(TRONDHEIM),
                function: "economy",
                name: "Økonomi",
              })
            )
          )
        );

        assert.strictEqual(created.value, SAVED);

        const economy = firstOf(
          assertSuccess(yield* viewAs(tables, LISE, teamsView)).teams,
          "the new team",
          (team) => team.name === "Økonomi"
        );

        assertSuccess(
          yield* runAs(
            tables,
            ADMIN,
            registerPersonProgram(
              form({
                email: "Ny.Person@Example.org",
                fieldOfStudyId: "10",
                name: "Ny Person",
              })
            )
          )
        );

        const person = firstOf(
          assertSuccess(yield* viewAs(tables, LISE, peopleView)).people,
          "the new person",
          (listed) => listed.name === "Ny Person"
        );

        // The leader adds the person with no end chosen: the team's default term (one semester) decides it.
        assertSuccess(
          yield* runAs(
            tables,
            LISE,
            addMemberProgram(
              form({
                personId: String(person.id),
                positionId: String(MEMBER_POSITION),
                start: "HOST-2026",
                teamId: String(economy.id),
              })
            )
          )
        );

        const added = assertSuccess(
          yield* viewAs(tables, LISE, teamView(economy.id))
        );

        assert.deepStrictEqual(
          Arr.map(added.members, (member) => [
            member.personName,
            member.start.label,
            member.end.label,
            member.state,
          ]),
          [["Ny Person", "Høst 2026", "Høst 2026", "Active"]]
        );

        // Extend it by one semester: the page offers the semesters after the end, and nothing continues on its own.
        const membership = firstOf(
          added.members,
          "the new membership",
          () => true
        );

        assert.deepStrictEqual(membership.extendChoices[0], {
          label: "Vår 2027",
          value: "VAR-2027",
        });
        assertSuccess(
          yield* runAs(
            tables,
            LISE,
            extendProgram(form({ end: "VAR-2027", id: String(membership.id) }))
          )
        );

        // Change the position from next semester: the old membership ends, a new one starts, and both are listed.
        assertSuccess(
          yield* runAs(
            tables,
            LISE,
            changeProgram(
              form({
                from: "VAR-2027",
                id: String(membership.id),
                leader: "on",
                positionId: String(MEMBER_POSITION),
              })
            )
          )
        );

        const changed = assertSuccess(
          yield* viewAs(tables, LISE, teamView(economy.id))
        );

        assert.deepStrictEqual(
          Arr.map(changed.members, (member) => [
            member.personName,
            member.start.label,
            member.end.label,
            member.state,
            member.leader,
          ]),
          [
            ["Ny Person", "Høst 2026", "Høst 2026", "Active", false],
            ["Ny Person", "Vår 2027", "Vår 2027", "Planned", true],
          ]
        );

        // End a third early: the page's own first choice is accepted, and the membership is Ended afterwards.
        const mats = firstOf(
          assertSuccess(yield* teamOf(tables, LISE)).members,
          "Mats Medlem",
          (member) => member.id === MEMBERSHIPS.mats
        );

        assertSuccess(
          yield* runAs(
            tables,
            LISE,
            endProgram(
              form({
                id: String(mats.id),
                semester: mats.endChoices[0]?.value ?? "",
              })
            )
          )
        );

        const ended = firstOf(
          assertSuccess(yield* teamOf(tables, LISE)).members,
          "Mats Medlem",
          (member) => member.id === MEMBERSHIPS.mats
        );

        assert.strictEqual(ended.state, "Ended");
      })
  );

  it.effect(
    "a leader of another department, a person with no team and a visitor are refused the page (403)",
    () =>
      Effect.gen(function* refusedEffect() {
        const tables = yield* freshWorld;

        for (const principal of [leaderOf(BERGEN), WITHOUT_TEAM, anonymous]) {
          assertRefused(yield* teamOf(tables, principal), "Forbidden");
        }
      })
  );

  it.effect(
    "the page lists the memberships of every state, with the calculated state and the controls that state offers",
    () =>
      Effect.gen(function* statesEffect() {
        const tables = yield* freshWorld;
        const page = assertSuccess(yield* teamOf(tables, ADMIN));

        // History reads oldest first: the ended membership, then the active ones, then the one that has not begun.
        assert.deepStrictEqual(
          Arr.map(page.members, (member) => [member.personName, member.state]),
          [
            ["Eva Ekstern", "Ended"],
            ["Lise Leder", "Active"],
            ["Mats Medlem", "Active"],
            ["Nora Neste", "Planned"],
          ]
        );
        assert.deepStrictEqual(Arr.map(page.members, controlsOf), [
          [],
          ["extend", "change", "end"],
          ["extend", "change", "end"],
          ["cancel"],
        ]);
      })
  );

  it.effect(
    "a one-semester active membership offers no change or end form with an empty semester list",
    () =>
      Effect.gen(function* noEmptyChoices() {
        const tables = yield* freshWorld;
        yield* Ref.update(tables.teams.memberships, (rows) =>
          Arr.map(rows, (row) =>
            row.id === MEMBERSHIPS.lise ? { ...row, start: row.end } : row
          )
        );

        const page = assertSuccess(yield* teamOf(tables, ADMIN));

        const member = firstOf(
          page.members,
          "Lise Leder",
          (row) => row.id === MEMBERSHIPS.lise
        );

        assert.deepStrictEqual(member.changeChoices, []);
        assert.deepStrictEqual(member.endChoices, []);
        assert.isFalse(member.canChange);
        assert.isFalse(member.canEnd);
        assert.isTrue(member.canExtend);
      })
  );
});

/** What each membership command is sent with, from the very control that offers it (or an arbitrary choice when none). */
const COMMANDS = [
  [
    "extend",
    (row: MemberRow) => row.canExtend,
    (row: MemberRow) =>
      extendProgram(
        form({
          end: row.extendChoices[0]?.value ?? "HOST-2030",
          id: String(row.id),
        })
      ),
  ],
  [
    "change",
    (row: MemberRow) => row.canChange,
    (row: MemberRow) =>
      changeProgram(
        form({
          from: row.changeChoices[0]?.value ?? "HOST-2030",
          id: String(row.id),
          positionId: String(MEMBER_POSITION),
        })
      ),
  ],
  [
    "end",
    (row: MemberRow) => row.canEnd,
    (row: MemberRow) =>
      endProgram(
        form({
          id: String(row.id),
          semester: row.endChoices[0]?.value ?? "HOST-2030",
        })
      ),
  ],
  [
    "cancel",
    (row: MemberRow) => row.canCancel,
    (row: MemberRow) => cancelProgram(form({ id: String(row.id) })),
  ],
] as const;

/** What the team-level controls are sent with: each is valid for the world, so only the grant can refuse it. */
const TEAM_COMMANDS = [
  [
    "add a member",
    (page: { readonly canAdd: boolean }) => page.canAdd,
    addMemberProgram(
      form({
        personId: String(PEOPLE.eva),
        positionId: String(MEMBER_POSITION),
        start: "HOST-2026",
        teamId: String(TRONDHEIM_TEAM),
      })
    ),
  ],
  [
    "edit the team",
    (page: { readonly canEdit: boolean }) => page.canEdit,
    saveTeamProgram(
      form({
        defaultTerm: "2",
        function: "recruitment",
        id: String(TRONDHEIM_TEAM),
        name: "Rekruttering",
      })
    ),
  ],
  [
    "deactivate the team",
    (page: { readonly canDeactivate: boolean }) => page.canDeactivate,
    deactivateTeamProgram(form({ id: String(TRONDHEIM_TEAM) })),
  ],
] as const;

const VIEWERS: readonly (readonly [string, Principal])[] = [
  ["an administrator", ADMIN],
  ["the team's leader", LISE],
  ["a member of the board", BOARD],
  ["a plain member, who may resign their own place", MATS],
];

const assertShownIffAccepted = (
  label: string,
  shown: boolean,
  attempt: Outcome<unknown>
) => {
  assert.strictEqual(shown, isSuccess(attempt), label);
};

describe("spec 0006: every control on the Team page is shown exactly when its command would go through", () => {
  it.effect(
    "membership controls: for each person, each membership and each command, on a fresh world",
    () =>
      Effect.gen(function* membershipControlsEffect() {
        for (const [who, principal] of VIEWERS) {
          const page = assertSuccess(
            yield* teamOf(yield* freshWorld, principal)
          );

          for (const row of page.members) {
            for (const [name, shown, program] of COMMANDS) {
              assertShownIffAccepted(
                `${who}: ${name} ${row.personName} (${row.state})`,
                shown(row),
                yield* runAs(yield* freshWorld, principal, program(row))
              );
            }
          }
        }
      })
  );

  it.effect(
    "a plain member is offered the end control on their own row alone",
    () =>
      Effect.gen(function* ownRowEffect() {
        const page = assertSuccess(yield* teamOf(yield* freshWorld, MATS));

        assert.deepStrictEqual(
          Arr.map(
            Arr.filter(page.members, (member) => member.canEnd),
            (member) => member.id
          ),
          [MEMBERSHIPS.mats]
        );
        assert.isFalse(
          Arr.some(
            page.members,
            (member) => member.canExtend || member.canChange || member.canCancel
          )
        );
      })
  );

  it.effect("team controls: add a member, edit the team, deactivate it", () =>
    Effect.gen(function* teamControlsEffect() {
      for (const [who, principal] of VIEWERS) {
        for (const [name, shown, program] of TEAM_COMMANDS) {
          const page = assertSuccess(
            yield* teamOf(yield* freshWorld, principal)
          );

          assertShownIffAccepted(
            `${who}: ${name}`,
            shown({
              canAdd: page.canAdd,
              canDeactivate: page.canDeactivate,
              canEdit: page.canEdit,
            }),
            yield* runAs(yield* freshWorld, principal, program)
          );
        }
      }
    })
  );
});

describe("spec 0006: the People and Admin pages", () => {
  it.effect(
    "people are listed for the departments the principal manages; registering one follows the grant",
    () =>
      Effect.gen(function* peopleEffect() {
        const tables = yield* freshWorld;

        const names = (principal: Principal) =>
          Effect.map(viewAs(tables, principal, peopleView), (outcome) =>
            Arr.map(assertSuccess(outcome).people, (person) => person.name)
          );

        assert.deepStrictEqual(yield* names(ADMIN), [
          "Ada Admin",
          "Bjorn Bergen",
          "Eva Ekstern",
          "Lise Leder",
          "Mats Medlem",
          "Nora Neste",
        ]);
        assert.deepStrictEqual(yield* names(leaderOf(BERGEN)), [
          "Bjorn Bergen",
        ]);
        assert.deepStrictEqual(yield* names(MATS), []);

        assert.isTrue(
          assertSuccess(yield* viewAs(tables, LISE, peopleView)).canRegister
        );
        assert.isFalse(
          assertSuccess(yield* viewAs(tables, MATS, peopleView)).canRegister
        );
      })
  );

  it.effect(
    "the admin list is the administrators' alone; a place is not offered for revoking on oneself, and the commands refuse it",
    () =>
      Effect.gen(function* adminsEffect() {
        const tables = yield* freshWorld;
        const view = assertSuccess(yield* viewAs(tables, ADA, adminsView));

        assert.deepStrictEqual(
          Arr.map(view.grants, (grant) => [
            grant.personName,
            grant.valid,
            grant.own,
          ]),
          [["Ada Admin", true, true]]
        );

        for (const principal of [LISE, MATS, WITHOUT_TEAM, anonymous]) {
          assertRefused(
            yield* viewAs(tables, principal, adminsView),
            "Forbidden"
          );
        }

        // Giving a place to somebody else is possible; the page then lists it.
        assertSuccess(
          yield* runAs(
            tables,
            ADA,
            grantAdminProgram(
              form({
                personId: String(PEOPLE.nora),
                until: "2099-12-31T12:00",
              })
            )
          )
        );

        const after = assertSuccess(yield* viewAs(tables, ADA, adminsView));
        assert.deepStrictEqual(
          Arr.map(after.grants, (grant) => grant.personName),
          ["Ada Admin", "Nora Neste"]
        );

        // The second administrator may not revoke their own place, and the page does not offer it (`own`).
        const nora = adminOf(PEOPLE.nora);

        const place = firstOf(
          after.grants,
          "Nora's place",
          (grant) => !grant.own
        );

        assert.isTrue(
          Arr.some(
            assertSuccess(yield* viewAs(tables, nora, adminsView)).grants,
            (grant) => grant.own && grant.personName === "Nora Neste"
          )
        );
        assertRefused(
          yield* runAs(
            tables,
            nora,
            revokeAdminProgram(form({ id: String(place.id) }))
          ),
          "Forbidden"
        );
      })
  );
});
