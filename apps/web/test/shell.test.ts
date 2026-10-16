/**
 * Spec 0004, falsifier 6: what the control panel shows is computed from the domain's capability function
 * (`authorize`), the one the commands enforce. Three layers of evidence:
 *
 *  1. the sidebar changes when one capability of the actor changes (the executive-board flag, the role, the
 *     department), so no role list stands behind it;
 *  2. the shell view carries that sidebar, and the local test-actor switch only in a `local` deployment;
 *  3. every control a page offers is shown exactly when the command behind it would not refuse the actor
 *     (`Forbidden`): the view and the command read the same decision, and this test is the edge between them.
 *
 * The browser tests (`e2e/shell.spec.ts`) show the same per actor in the rendered DOM.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  Actor,
  DepartmentId,
  UserId,
  anonymous,
  createSocialEvent,
} from "@vektorprogrammet/domain";
import type { Actor as ActorType, StaffRole } from "@vektorprogrammet/domain";
import { Array as Arr, DateTime, Effect, Predicate } from "effect";
import { TestClock } from "effect/testing";

import type { Outcome } from "../src/lib/outcome";
import type { SectionKey } from "../src/lib/panelSections";
import {
  departmentsView,
  fieldsOfStudyView,
  saveDepartmentProgram,
  saveFieldOfStudyProgram,
  socialEventsView,
} from "../src/server/panel";
import { navigationFor, shellView } from "../src/server/shell";
import {
  fakeDepartment,
  fakeFieldOfStudy,
  form,
  makeTables,
} from "./support/memory";
import { assertSuccess } from "./support/outcomes";
import { runAs, viewAs } from "./support/run";

/** An acting staff member; department 1 unless said otherwise. */
const staff = (
  role: StaffRole,
  options: {
    readonly executiveBoard?: boolean;
    readonly departmentId?: number;
  } = {}
): ActorType =>
  Actor.cases.Staff.make({
    departmentId: DepartmentId.make(options.departmentId ?? 1),
    executiveBoard: options.executiveBoard ?? false,
    role,
    userId: UserId.make(900_100),
  });

const sectionsOf = (actor: ActorType): readonly SectionKey[] =>
  Arr.flatMap(navigationFor(actor), (group) =>
    Arr.map(group.items, (item) => item.key)
  );

/** Every section, in the sidebar's order. */
const EVERY_SECTION: readonly SectionKey[] = [
  "overview",
  "departments",
  "semesters",
  "fieldsOfStudy",
  "socialEvents",
];

/** What a team member may use: the departments and fields of study are a leader's. */
const MEMBER_SECTIONS: readonly SectionKey[] = [
  "overview",
  "semesters",
  "socialEvents",
];

describe("spec 0004, falsifier 6: the sidebar is computed from the domain's capabilities", () => {
  it("an anonymous visitor gets no sidebar at all", () => {
    assert.deepStrictEqual(navigationFor(anonymous), []);
  });

  it("each staff member gets the sections whose capabilities they hold, in the sidebar's order", () => {
    const cases: readonly (readonly [
      string,
      ActorType,
      readonly SectionKey[],
    ])[] = [
      ["a team member", staff("teamMember"), MEMBER_SECTIONS],
      [
        "a team member on the executive board",
        staff("teamMember", { executiveBoard: true }),
        MEMBER_SECTIONS,
      ],
      ["a team leader", staff("teamLeader"), EVERY_SECTION],
      [
        "a team leader on the executive board",
        staff("teamLeader", { executiveBoard: true }),
        EVERY_SECTION,
      ],
      ["an administrator", staff("admin"), EVERY_SECTION],
    ];

    for (const [label, actor, expected] of cases) {
      assert.deepStrictEqual(sectionsOf(actor), expected, label);
    }
  });

  it("changing one capability of the actor changes exactly the sections it gates", () => {
    // The executive-board flag gated only the static texts, which the CMS owns now (spec 0005): it gates no section.
    assert.deepStrictEqual(
      Arr.difference(
        sectionsOf(staff("teamLeader", { executiveBoard: true })),
        sectionsOf(staff("teamLeader"))
      ),
      []
    );

    // The role is the only difference: a leader may change departments and fields of study, a member may not.
    assert.deepStrictEqual(
      Arr.difference(
        sectionsOf(staff("teamLeader")),
        sectionsOf(staff("teamMember"))
      ),
      ["departments", "fieldsOfStudy"]
    );

    // The department is the only difference: the capabilities are the actor's own department's, so the
    // sections are the same for a leader of department 2.
    assert.deepStrictEqual(
      sectionsOf(staff("teamLeader", { departmentId: 2 })),
      sectionsOf(staff("teamLeader"))
    );
  });

  it.effect(
    "the shell view carries the sidebar, who is acting, and the test-actor switch only in a local deployment",
    () =>
      Effect.gen(function* shellViewEffect() {
        const tables = makeTables();
        const leader = staff("teamLeader");

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
          departmentId: DepartmentId.make(1),
          executiveBoard: false,
          role: "teamLeader",
        });
        assert.isTrue(local.testActors);
        assert.isFalse(preview.testActors);
        assert.deepStrictEqual([visitor.actor, visitor.navigation], [null, []]);
      })
  );
});

/** Whether the command refused the actor (403): the one thing a hidden control must agree with. */
const isForbidden = (outcome: Outcome<unknown>): boolean =>
  Predicate.isTagged(outcome, "Failure") &&
  Predicate.isTagged(outcome.error, "Forbidden");

/** The acting staff and visitors the controls are compared for: every role, the board flag, both departments. */
const ACTORS: readonly (readonly [string, ActorType])[] = [
  ["an anonymous visitor", anonymous],
  ["an administrator on the board", staff("admin", { executiveBoard: true })],
  ["an administrator", staff("admin")],
  ["a team leader of department 1", staff("teamLeader")],
  ["a team leader of department 2", staff("teamLeader", { departmentId: 2 })],
  ["a team leader on the board", staff("teamLeader", { executiveBoard: true })],
  ["a team member", staff("teamMember")],
  ["a team member on the board", staff("teamMember", { executiveBoard: true })],
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

/** The control is shown exactly when the command does not refuse the actor. */
const assertAgrees = (
  label: string,
  shown: boolean,
  attempt: Outcome<unknown>
) => {
  assert.strictEqual(shown, !isForbidden(attempt), label);
};

describe("spec 0004, falsifier 6: every control is shown exactly when its command would not refuse the actor", () => {
  it.effect("departments: the create button and each row's edit form", () =>
    Effect.gen(function* departmentControlsEffect() {
      for (const [who, actor] of ACTORS) {
        const view = assertSuccess(
          yield* viewAs(SEEDED(), actor, departmentsView)
        );

        assertAgrees(
          `${who}: create`,
          view.canCreate,
          yield* runAs(
            SEEDED(),
            actor,
            saveDepartmentProgram(departmentForm("", "Oslo"))
          )
        );

        for (const row of view.departments) {
          assertAgrees(
            `${who}: edit ${row.name}`,
            row.canEdit,
            yield* runAs(
              SEEDED(),
              actor,
              saveDepartmentProgram(departmentForm(String(row.id), row.city))
            )
          );
        }
      }
    })
  );

  it.effect(
    "fields of study: the page's list and create form are for the actor's own department",
    () =>
      Effect.gen(function* fieldOfStudyControlsEffect() {
        for (const [who, actor] of ACTORS) {
          const view = assertSuccess(
            yield* viewAs(SEEDED(), actor, fieldsOfStudyView)
          );

          assertAgrees(
            who,
            view.canManage,
            yield* runAs(
              SEEDED(),
              actor,
              saveFieldOfStudyProgram(form({ name: "Kjemi", shortName: "KJ" }))
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

        for (const [who, actor] of ACTORS) {
          const view = assertSuccess(
            yield* viewAs(SEEDED(), actor, socialEventsView)
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
                actor,
                createSocialEvent({
                  departmentId: department,
                  description: "",
                  endsAt: "2026-10-20T11:00:00Z",
                  link: null,
                  semesterId: 1,
                  startsAt: "2026-10-20T10:00:00Z",
                  title: "Sosialt",
                })
              )
            );
          }
        }
      })
  );
});
