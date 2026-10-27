/**
 * What the control panel shows is computed from the one grant table (`authorize` and `canAnywhere`), the one the
 * commands enforce (spec 0004, falsifier 6; spec 0006 replaces the role with facts about a person). Three layers of
 * evidence:
 *
 *  1. the sidebar changes when one fact about the principal changes (a leader flag, a team's function, the
 *     department, an admin place), so no role list stands behind it;
 *  2. the shell view carries that sidebar, and the local test-actor switch only in a `local` deployment;
 *  3. every control a page offers is shown exactly when the command behind it would not refuse the principal
 *     (`Forbidden`): the view and the command read the same decision, and this test is the edge between them.
 *
 * The browser tests (`e2e/shell.spec.ts`) show the same per person in the rendered DOM.
 */
import { assert, describe, it } from "@effect/vitest";
import { anonymous } from "@vektorprogrammet/domain";
import type { Principal } from "@vektorprogrammet/domain";
import { Array as Arr, DateTime, Effect } from "effect";
import { TestClock } from "effect/testing";

import type { Outcome } from "../src/lib/outcome";
import type { SectionKey } from "../src/lib/panelSections";
import {
  departmentsView,
  fieldsOfStudyView,
  saveDepartmentProgram,
  saveFieldOfStudyProgram,
  saveSocialEventProgram,
  socialEventsView,
} from "../src/server/panel";
import { navigationFor, shellView } from "../src/server/shell";
import {
  fakeDepartment,
  fakeFieldOfStudy,
  form,
  makeTables,
} from "./support/memory";
import { assertSuccess, isForbidden } from "./support/outcomes";
import { ADMIN, WITHOUT_TEAM, leaderOf, memberOf } from "./support/principals";
import { runAs, viewAs } from "./support/run";
import { sectionsOf } from "./support/sidebar";
import { PEOPLE, TRONDHEIM, seedWorld } from "./support/teamWorld";

/** Every section, in the sidebar's order. */
const EVERY_SECTION: readonly SectionKey[] = [
  "overview",
  "departments",
  "semesters",
  "fieldsOfStudy",
  "teams",
  "people",
  "admins",
  "integrations",
  "socialEvents",
];

/** What a team member may use: the overview, the semesters, the teams and the events of their department. */
const MEMBER_SECTIONS: readonly SectionKey[] = [
  "overview",
  "semesters",
  "teams",
  "socialEvents",
];

/** A board member also manages the department's people and teams, but is no leader of its fields of study. */
const BOARD_SECTIONS: readonly SectionKey[] = [
  "overview",
  "semesters",
  "teams",
  "people",
  "socialEvents",
];

/** A leader also changes the department and its fields of study, and manages its people and teams. */
const LEADER_SECTIONS: readonly SectionKey[] = [
  "overview",
  "departments",
  "semesters",
  "fieldsOfStudy",
  "teams",
  "people",
  "socialEvents",
];

const BOARD_MEMBER = memberOf(1, { function: "board" });

describe("spec 0006: the sidebar is computed from the grant table", () => {
  it("a visitor who is not signed in, and a person with no team, get no sidebar at all", () => {
    assert.deepStrictEqual(navigationFor(anonymous), []);
    assert.deepStrictEqual(navigationFor(WITHOUT_TEAM), []);
  });

  it("each person gets the sections whose commands they hold, in the sidebar's order", () => {
    const cases: readonly (readonly [
      string,
      Principal,
      readonly SectionKey[],
    ])[] = [
      ["a team member", memberOf(1), MEMBER_SECTIONS],
      [
        "a member of a recruitment team",
        memberOf(1, { function: "recruitment" }),
        MEMBER_SECTIONS,
      ],
      ["a member of the board", BOARD_MEMBER, BOARD_SECTIONS],
      ["a team leader", leaderOf(1), LEADER_SECTIONS],
      ["a board leader", leaderOf(1, { function: "board" }), LEADER_SECTIONS],
      ["an administrator", ADMIN, EVERY_SECTION],
    ];

    for (const [label, principal, expected] of cases) {
      assert.deepStrictEqual(sectionsOf(principal), expected, label);
    }
  });

  it("changing one fact about the person changes exactly the sections it gates", () => {
    // The leader flag is the only difference: a leader may change departments and fields of study, and manage people.
    assert.deepStrictEqual(
      Arr.difference(sectionsOf(leaderOf(1)), sectionsOf(memberOf(1))),
      ["departments", "fieldsOfStudy", "people"]
    );

    // The team's function is the only difference: the board manages people, a recruitment team's plain member does not.
    assert.deepStrictEqual(
      Arr.difference(sectionsOf(BOARD_MEMBER), sectionsOf(memberOf(1))),
      ["people"]
    );

    // The admin place is the only difference: the admin list and Integrations are for administrators.
    assert.deepStrictEqual(
      Arr.difference(sectionsOf(ADMIN), sectionsOf(leaderOf(1))),
      ["admins", "integrations"]
    );

    // The department is the only difference: the facts are the person's own department's, so the sections are the
    // same for a leader of department 2.
    assert.deepStrictEqual(sectionsOf(leaderOf(2)), sectionsOf(leaderOf(1)));
  });

  it.effect(
    "the shell view carries the sidebar, who is acting, and the test-actor switch only in a local deployment",
    () =>
      Effect.gen(function* shellViewEffect() {
        const tables = makeTables();
        yield* seedWorld(tables);

        const leader = leaderOf(TRONDHEIM, { personId: PEOPLE.lise });

        const local = assertSuccess(
          yield* viewAs(tables, leader, shellView("local"))
        );

        const preview = assertSuccess(
          yield* viewAs(tables, leader, shellView("preview"))
        );

        const visitor = assertSuccess(
          yield* viewAs(tables, anonymous, shellView("local"))
        );

        assert.deepStrictEqual(local.navigation, navigationFor(leader));
        assert.deepStrictEqual(local.actor, {
          admin: false,
          leader: true,
          member: true,
          name: "Lise Leder",
        });
        assert.deepStrictEqual(local.testActors, [
          "Ada Admin",
          "Bjorn Bergen",
          "Eva Ekstern",
          "Lise Leder",
          "Mats Medlem",
          "Nora Neste",
        ]);
        assert.isNull(preview.testActors);
        assert.deepStrictEqual([visitor.actor, visitor.navigation], [null, []]);
      })
  );
});

/** The visitors and people the controls are compared for: nobody, every kind of membership, both departments. */
const ACTORS: readonly (readonly [string, Principal])[] = [
  ["an anonymous visitor", anonymous],
  ["an administrator", ADMIN],
  ["a team leader of department 1", leaderOf(1)],
  ["a team leader of department 2", leaderOf(2)],
  ["a board member of department 1", BOARD_MEMBER],
  ["a team member of department 1", memberOf(1)],
  ["a person without a team", WITHOUT_TEAM],
];

const SEEDED = () =>
  makeTables({
    departments: [fakeDepartment(1, "Trondheim"), fakeDepartment(2, "Bergen")],
    fieldsOfStudy: [fakeFieldOfStudy(10, 1), fakeFieldOfStudy(20, 2)],
  });

/** What the form posts for a department, as the department form does. */
const departmentForm = (id: string, city: string) =>
  form({
    active: "on",
    address: "",
    city,
    email: "post@example.org",
    id,
    latitude: "",
    logoKey: "",
    longitude: "",
    name: "Vektor",
    shortName: "VEK",
    slackChannel: "",
  });

/** What the form posts for an event in `departmentId`. */
const eventForm = (departmentId: number) =>
  form({
    departmentId: String(departmentId),
    description: "",
    endsAt: "2026-10-20T13:00",
    link: "",
    semesterId: "1",
    startsAt: "2026-10-20T12:00",
    title: "Sosialt",
  });

/** The control is shown exactly when the command does not refuse the principal. */
const assertAgrees = (
  label: string,
  shown: boolean,
  attempt: Outcome<unknown>
) => {
  assert.strictEqual(shown, !isForbidden(attempt), label);
};

describe("spec 0004, falsifier 6: every control is shown exactly when its command would not refuse the principal", () => {
  it.effect("departments: the create button and each row's edit form", () =>
    Effect.gen(function* departmentControlsEffect() {
      for (const [who, principal] of ACTORS) {
        const view = assertSuccess(
          yield* viewAs(SEEDED(), principal, departmentsView)
        );

        assertAgrees(
          `${who}: create`,
          view.canCreate,
          yield* runAs(
            SEEDED(),
            principal,
            saveDepartmentProgram(departmentForm("", "Oslo"))
          )
        );

        for (const row of view.departments) {
          assertAgrees(
            `${who}: edit ${row.name}`,
            row.canEdit,
            yield* runAs(
              SEEDED(),
              principal,
              saveDepartmentProgram(departmentForm(String(row.id), row.city))
            )
          );
        }
      }
    })
  );

  it.effect(
    "fields of study: the page's list and create form are for the department the principal leads",
    () =>
      Effect.gen(function* fieldOfStudyControlsEffect() {
        for (const [who, principal] of ACTORS) {
          const view = assertSuccess(
            yield* viewAs(SEEDED(), principal, fieldsOfStudyView)
          );

          assertAgrees(
            who,
            view.canManage,
            yield* runAs(
              SEEDED(),
              principal,
              saveFieldOfStudyProgram(
                form({
                  departmentId: String(view.department?.id ?? 1),
                  name: "Kjemi",
                  shortName: "KJ",
                })
              )
            )
          );
        }
      })
  );

  it.effect(
    "events: the departments the form offers are exactly those the command accepts",
    () =>
      Effect.gen(function* eventControlsEffect() {
        yield* TestClock.setTime(
          DateTime.toEpochMillis(
            DateTime.makeUnsafe("2026-10-15T12:00:00+02:00")
          )
        );

        for (const [who, principal] of ACTORS) {
          const view = assertSuccess(
            yield* viewAs(SEEDED(), principal, socialEventsView)
          );

          assert.strictEqual(
            view.canCreate,
            view.departments.length > 0,
            `${who}: the button is there when a department is offered`
          );

          for (const department of [1, 2]) {
            assertAgrees(
              `${who}: an event in department ${department}`,
              Arr.some(
                view.departments,
                (offered) => offered.id === department
              ),
              yield* runAs(
                SEEDED(),
                principal,
                saveSocialEventProgram(eventForm(department))
              )
            );
          }
        }
      })
  );
});
