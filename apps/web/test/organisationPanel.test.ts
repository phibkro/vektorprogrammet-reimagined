/**
 * Spec 0001, journey steps 1 to 3 at the server function: each test runs the program a server function
 * runs (`saveDepartmentProgram`, `saveFieldOfStudyProgram`, the views) through the
 * per-request runtime and the error table, over in-memory repositories. The browser tests
 * (`apps/web/e2e`) drive the same functions over HTTP against real PostgreSQL. Spec 0003: semesters
 * are written only by the scheduled job; the semester views are reads.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  DepartmentId,
  FieldOfStudyId,
  SemesterId,
  anonymous,
} from "@vektorprogrammet/domain";
import type {
  Actor,
  AuditLog,
  CurrentActor,
  DepartmentRepository,
  FieldOfStudyRepository,
  InTransaction,
  SemesterRepository,
} from "@vektorprogrammet/domain";
import { Array as Arr, DateTime, Effect } from "effect";
import { TestClock } from "effect/testing";

import { TEST_ACTORS } from "../src/server/actor";
import type { RequestError } from "../src/server/errors";
import {
  SAVED,
  departmentsView,
  fieldsOfStudyView,
  saveDepartmentProgram,
  saveFieldOfStudyProgram,
  semestersView,
} from "../src/server/panel";
import { runCommandOutcome, runOutcome } from "../src/server/runtime";
import {
  fakeDepartment,
  fakeFieldOfStudy,
  fakeKey,
  form,
  makeTables,
  memoryLayer,
} from "./support/memory";
import type { MemoryTables } from "./support/memory";
import {
  assertRefused,
  assertSuccess,
  assertValidationFailure,
} from "./support/outcomes";

const { signal } = new AbortController();

/** 2026-10-15 12:00 in Oslo: Høst 2026, and next year is 2027. */
const OCTOBER_15 = DateTime.toEpochMillis(
  DateTime.makeUnsafe("2026-10-15T12:00:00+02:00")
);

type ViewServices =
  | CurrentActor
  | DepartmentRepository
  | SemesterRepository
  | FieldOfStudyRepository
  | AuditLog;

/** Runs a command as `actor` exactly as a server function does: in a transaction, through the error table. */
const runAs = <
  A,
  E extends RequestError,
  R extends ViewServices | InTransaction,
>(
  tables: MemoryTables,
  actor: Actor,
  command: Effect.Effect<A, E, R>
) =>
  Effect.promise(
    async () =>
      await runCommandOutcome(
        memoryLayer(tables, actor),
        Effect.void,
        () => command,
        signal
      )
  );

/** Runs a view (a loader's program) as `actor` through the error table. */
const viewAs = <A, E extends RequestError, R extends ViewServices>(
  tables: MemoryTables,
  actor: Actor,
  view: Effect.Effect<A, E, R>
) =>
  Effect.promise(
    async () => await runOutcome(memoryLayer(tables, actor), view, signal)
  );

/** What the form posts for a department: the same fields the edit dialog renders. */
const departmentFields = (
  overrides: Readonly<Record<string, string>> = {}
) => ({
  active: "on",
  address: "",
  city: "Bergen",
  email: "bergen@example.org",
  latitude: "",
  logoKey: "",
  longitude: "",
  name: "Vektor Bergen",
  shortName: "BERGEN",
  slackChannel: "",
  ...overrides,
});

const auditActions = (tables: MemoryTables) =>
  Arr.map(tables.audit, (entry) => entry.action);

describe("C1 departments through the panel", () => {
  it.effect(
    "an admin creates a department; it is listed by name with every field the edit form posts back",
    () =>
      Effect.gen(function* createDepartmentEffect() {
        const tables = makeTables();

        const outcome = yield* runAs(
          tables,
          TEST_ACTORS.admin,
          saveDepartmentProgram(
            form(
              departmentFields({
                address: "Torggata 1",
                latitude: "60.39",
                logoKey: fakeKey(1),
                longitude: "5,32",
                slackChannel: "#bergen",
              })
            )
          )
        );

        assert.strictEqual(assertSuccess(outcome).value, SAVED);
        assert.deepStrictEqual(auditActions(tables), ["department.created"]);

        const listed = assertSuccess(
          yield* viewAs(tables, TEST_ACTORS.admin, departmentsView)
        );

        assert.deepStrictEqual(listed.departments, [
          {
            active: true,
            address: "Torggata 1",
            canEdit: true,
            city: "Bergen",
            email: "bergen@example.org",
            id: DepartmentId.make(1),
            latitude: 60.39,
            logoKey: fakeKey(1),
            longitude: 5.32,
            name: "Vektor Bergen",
            shortName: "BERGEN",
            slackChannel: "#bergen",
          },
        ]);
        assert.isTrue(listed.canCreate);
      })
  );

  it.effect(
    "departments are listed A to Å by name, inactive ones included",
    () =>
      Effect.gen(function* listedByNameEffect() {
        const tables = makeTables({
          departments: [
            fakeDepartment(1, "Trondheim"),
            fakeDepartment(2, "Ås", { active: false, name: "Vektor Ås" }),
            fakeDepartment(3, "Bergen"),
          ],
        });

        const listed = assertSuccess(
          yield* viewAs(tables, anonymous, departmentsView)
        );

        assert.deepStrictEqual(
          Arr.map(listed.departments, (row) => [row.name, row.active]),
          [
            ["Vektor Bergen", true],
            ["Vektor Trondheim", true],
            ["Vektor Ås", false],
          ]
        );
      })
  );

  it.effect("a repeated city is refused with a 409 and nothing is saved", () =>
    Effect.gen(function* repeatedCityEffect() {
      const tables = makeTables();

      assertSuccess(
        yield* runAs(
          tables,
          TEST_ACTORS.admin,
          saveDepartmentProgram(form(departmentFields()))
        )
      );

      const refused = assertRefused(
        yield* runAs(
          tables,
          TEST_ACTORS.admin,
          saveDepartmentProgram(
            form(departmentFields({ name: "En annen avdeling" }))
          )
        ),
        "AlreadyExists"
      );

      assert.strictEqual(refused.status, 409);
      assert.strictEqual(tables.departments.length, 1);
      assert.deepStrictEqual(auditActions(tables), ["department.created"]);
      assert.strictEqual(tables.commits, 1);
    })
  );

  it.effect(
    "an edit keeps the coordinates and the logo the form posts back, and changes what the admin typed",
    () =>
      Effect.gen(function* editKeepsEffect() {
        const tables = makeTables({
          departments: [
            fakeDepartment(1, "Bergen", {
              latitude: 60.39,
              logoKey: fakeKey(1),
              longitude: 5.32,
            }),
          ],
        });

        assertSuccess(
          yield* runAs(
            tables,
            TEST_ACTORS.admin,
            saveDepartmentProgram(
              form(
                departmentFields({
                  id: "1",
                  latitude: "60.39",
                  logoKey: fakeKey(1),
                  longitude: "5.32",
                  name: "Vektor Bergen (nytt navn)",
                })
              )
            )
          )
        );

        assert.deepStrictEqual(
          Arr.map(tables.departments, (row) => [
            row.name,
            row.latitude,
            row.longitude,
            row.logoKey,
          ]),
          [["Vektor Bergen (nytt navn)", 60.39, 5.32, fakeKey(1)]]
        );
        assert.deepStrictEqual(auditActions(tables), ["department.updated"]);
      })
  );

  it.effect(
    "only an admin creates a department; a team leader edits only their own (403 elsewhere)",
    () =>
      Effect.gen(function* departmentAuthorityEffect() {
        const tables = makeTables({
          departments: [
            fakeDepartment(1, "Trondheim"),
            fakeDepartment(2, "Bergen"),
          ],
        });

        for (const actor of [TEST_ACTORS.teamLeader, anonymous]) {
          assertRefused(
            yield* runAs(
              tables,
              actor,
              saveDepartmentProgram(form(departmentFields({ city: "Oslo" })))
            ),
            "Forbidden"
          );
        }

        const otherDepartment = assertRefused(
          yield* runAs(
            tables,
            TEST_ACTORS.teamLeader,
            saveDepartmentProgram(
              form(departmentFields({ id: "2", name: "Kapret" }))
            )
          ),
          "Forbidden"
        );

        assert.strictEqual(otherDepartment.status, 403);
        assert.strictEqual(tables.departments.length, 2);
        assert.strictEqual(tables.departments[1]?.name, "Vektor Bergen");

        assertSuccess(
          yield* runAs(
            tables,
            TEST_ACTORS.teamLeader,
            saveDepartmentProgram(
              form(
                departmentFields({
                  city: "Trondheim",
                  id: "1",
                  name: "Vektor NTNU",
                })
              )
            )
          )
        );
        assert.strictEqual(tables.departments[0]?.name, "Vektor NTNU");
      })
  );

  it.effect(
    "an invalid e-mail address is refused under its own field (400)",
    () =>
      Effect.gen(function* invalidEmailEffect() {
        const tables = makeTables();

        const failure = assertValidationFailure(
          yield* runAs(
            tables,
            TEST_ACTORS.admin,
            saveDepartmentProgram(
              form(departmentFields({ email: "ikke-en-adresse" }))
            )
          )
        );

        assert.deepStrictEqual(
          Arr.map(failure.issues, (issue) => issue.path),
          [["email"]]
        );
        assert.strictEqual(tables.departments.length, 0);
      })
  );
});

describe("C2 semesters through the panel (spec 0003)", () => {
  it.effect(
    "RULE-084, RULE-033: the list is newest first, marks the current semester, and is read as stored",
    () =>
      Effect.gen(function* listedNewestFirstEffect() {
        yield* TestClock.setTime(OCTOBER_15);

        const tables = makeTables({
          semesters: [
            { id: SemesterId.make(1), term: "HOST", year: 2026 },
            { id: SemesterId.make(2), term: "VAR", year: 2027 },
          ],
        });

        const listed = assertSuccess(
          yield* viewAs(tables, TEST_ACTORS.admin, semestersView)
        );

        assert.deepStrictEqual(
          Arr.map(listed.semesters, (semester) => [
            semester.label,
            semester.current,
          ]),
          [
            ["Vår 2027", false],
            ["Høst 2026", true],
          ]
        );
        assert.deepStrictEqual(listed.current, {
          label: "Høst 2026",
          stored: true,
        });
      })
  );

  it.effect(
    "RULE-237: with no semester rows the page names the current semester as not created, and the read inserts nothing",
    () =>
      Effect.gen(function* missingRowEffect() {
        yield* TestClock.setTime(OCTOBER_15);
        const tables = makeTables();

        const listed = assertSuccess(
          yield* viewAs(tables, TEST_ACTORS.admin, semestersView)
        );

        assert.deepStrictEqual(listed.semesters, []);
        assert.deepStrictEqual(listed.current, {
          label: "Høst 2026",
          stored: false,
        });
        assert.deepStrictEqual(tables.semesters, []);
        assert.strictEqual(tables.commits, 0);
      })
  );
});

describe("C1 fields of study through the panel", () => {
  const DEPARTMENT_A = 1;

  const DEPARTMENT_B = 2;

  const twoDepartments = () =>
    makeTables({
      departments: [
        fakeDepartment(DEPARTMENT_A, "Trondheim"),
        fakeDepartment(DEPARTMENT_B, "Bergen"),
      ],
      fieldsOfStudy: [
        fakeFieldOfStudy(10, DEPARTMENT_A, "Informatikk"),
        fakeFieldOfStudy(20, DEPARTMENT_B, "Fysikk"),
      ],
    });

  it.effect(
    "RULE-139: a team leader lists, creates and renames fields of study in their own department",
    () =>
      Effect.gen(function* ownDepartmentEffect() {
        const tables = twoDepartments();

        assertSuccess(
          yield* runAs(
            tables,
            TEST_ACTORS.teamLeader,
            saveFieldOfStudyProgram(
              form({
                departmentId: String(DEPARTMENT_A),
                name: "Matematikk",
                shortName: "MA",
              })
            )
          )
        );
        assertSuccess(
          yield* runAs(
            tables,
            TEST_ACTORS.teamLeader,
            saveFieldOfStudyProgram(
              form({ id: "10", name: "Informatikk og data", shortName: "ID" })
            )
          )
        );

        const view = assertSuccess(
          yield* viewAs(tables, TEST_ACTORS.teamLeader, fieldsOfStudyView)
        );

        assert.deepStrictEqual(view.department, {
          id: DepartmentId.make(DEPARTMENT_A),
          name: "Vektor Trondheim",
        });
        assert.deepStrictEqual(
          Arr.map(view.fieldsOfStudy, (field) => field.name),
          ["Informatikk og data", "Matematikk"]
        );
        assert.deepStrictEqual(auditActions(tables), [
          "fieldOfStudy.created",
          "fieldOfStudy.updated",
        ]);
        assert.isTrue(
          Arr.every(
            Arr.filter(
              tables.fieldsOfStudy,
              (field) => field.name === "Matematikk"
            ),
            (field) => field.departmentId === DEPARTMENT_A
          )
        );
      })
  );

  it.effect(
    "RULE-139: a team leader from department A is refused (403) on department B's field of study, at the server function",
    () =>
      Effect.gen(function* otherDepartmentEffect() {
        const tables = twoDepartments();
        const before = [...tables.fieldsOfStudy];

        const rename = assertRefused(
          yield* runAs(
            tables,
            TEST_ACTORS.teamLeader,
            saveFieldOfStudyProgram(
              form({ id: "20", name: "Kapret", shortName: "KA" })
            )
          ),
          "Forbidden"
        );

        const create = assertRefused(
          yield* runAs(
            tables,
            TEST_ACTORS.teamLeader,
            saveFieldOfStudyProgram(
              form({
                departmentId: String(DEPARTMENT_B),
                name: "Snikopprettet",
                shortName: "SN",
              })
            )
          ),
          "Forbidden"
        );

        assert.deepStrictEqual(
          [rename.status, create.status, rename.message],
          [403, 403, "Du har ikke tilgang til dette."]
        );
        assert.deepStrictEqual(tables.fieldsOfStudy, before);
        assert.deepStrictEqual(tables.audit, []);
        assert.strictEqual(tables.commits, 0);
      })
  );

  it.effect(
    "RULE-139: the page shows the actor's own department only, by name; an anonymous visitor sees none",
    () =>
      Effect.gen(function* ownOnlyEffect() {
        const tables = twoDepartments();

        const asLeader = assertSuccess(
          yield* viewAs(tables, TEST_ACTORS.teamLeader, fieldsOfStudyView)
        );

        const asAnonymous = assertSuccess(
          yield* viewAs(tables, anonymous, fieldsOfStudyView)
        );

        assert.deepStrictEqual(
          Arr.map(asLeader.fieldsOfStudy, (field) => field.id),
          [FieldOfStudyId.make(10)]
        );
        assert.deepStrictEqual(asAnonymous, {
          canManage: false,
          department: null,
          fieldsOfStudy: [],
        });
      })
  );

  it.effect(
    "RULE-139: a team member who does not lead the department is refused too (403)",
    () =>
      Effect.gen(function* teamMemberEffect() {
        const tables = twoDepartments();

        assertRefused(
          yield* runAs(
            tables,
            { ...TEST_ACTORS.teamLeader, role: "teamMember" },
            saveFieldOfStudyProgram(form({ name: "Kjemi", shortName: "KJ" }))
          ),
          "Forbidden"
        );
        assert.strictEqual(tables.fieldsOfStudy.length, 2);
      })
  );
});
