import { assert, describe, it } from "@effect/vitest";
import {
  Array as Arr,
  DateTime,
  Effect,
  Option,
  Order,
  Predicate,
  pipe,
} from "effect";
import { TestClock } from "effect/testing";

import type { DepartmentId } from "../../src/index.ts";
import {
  FieldOfStudyId,
  SemesterRepository,
  createDepartment,
  createFieldOfStudy,
  currentSemester,
  ensureScheduledSemesters,
  findCurrentSemester,
  listFieldsOfStudy,
  listSemestersNewestFirst,
  renameFieldOfStudy,
  semesterLabel,
  updateDepartment,
} from "../../src/index.ts";
import { oslo } from "../support/calendar.ts";
import {
  BERGEN,
  TRONDHEIM,
  TestServices,
  admin,
  asActor,
  auditActions,
  departmentForTest,
  failureTag,
  seed,
  table,
  teamLeaderTrondheim,
  teamMemberBergen,
} from "../support/inMemory.ts";

/** 2026-10-15 12:00 in Oslo. */
const OCTOBER_15 = DateTime.toEpochMillis(
  DateTime.makeUnsafe("2026-10-15T10:00:00Z")
);

const department = (id: DepartmentId, city: string) =>
  departmentForTest(id, city, city.slice(0, 4).toUpperCase());

const storedLabels = Effect.map(listSemestersNewestFirst, (rows) =>
  Arr.map(rows, semesterLabel)
);

/** The semester job's one instant, in Oslo wall-clock time, and the two semesters it must leave behind. */
const JOB_BOUNDARIES = [
  {
    expected: ["Høst 2026", "Vår 2026"],
    now: "2026-07-31T23:59:59",
  },
  {
    expected: ["Vår 2027", "Høst 2026"],
    now: "2026-08-01T00:00:00",
  },
  {
    expected: ["Vår 2027", "Høst 2026"],
    now: "2026-12-31T23:59:59",
  },
  {
    expected: ["Høst 2027", "Vår 2027"],
    now: "2027-01-01T00:00:00",
  },
];

describe("C2 semesters by schedule (spec 0003)", () => {
  it.effect(
    "RULE-237: on an empty table one job run leaves exactly the current and the next semester; a second run changes nothing",
    () =>
      Effect.gen(function* effectProgram() {
        yield* TestClock.setTime(OCTOBER_15);

        const first = yield* ensureScheduledSemesters;

        assert.deepStrictEqual(yield* storedLabels, ["Vår 2027", "Høst 2026"]);
        assert.strictEqual(semesterLabel(first.current), "Høst 2026");
        assert.strictEqual(semesterLabel(first.next), "Vår 2027");

        const rows = yield* table((db) => db.semesters);
        const second = yield* ensureScheduledSemesters;

        assert.deepStrictEqual(second, first);
        assert.deepStrictEqual(yield* table((db) => db.semesters), rows);
      }).pipe(Effect.provide(TestServices))
  );

  it.effect.each(JOB_BOUNDARIES)(
    "RULE-237, RULE-033: at $now Europe/Oslo the job ensures $expected",
    ({ now, expected }) =>
      Effect.gen(function* effectProgram() {
        yield* TestClock.setTime(DateTime.toEpochMillis(oslo(now)));
        yield* ensureScheduledSemesters;

        assert.deepStrictEqual(yield* storedLabels, expected);
      }).pipe(Effect.provide(TestServices))
  );

  it.effect(
    "RULE-237: concurrent job runs on an empty table yield exactly two rows, and every run sees the same two",
    () =>
      Effect.gen(function* effectProgram() {
        yield* TestClock.setTime(OCTOBER_15);

        const runs = yield* Effect.all(
          Array.from({ length: 20 }, () => ensureScheduledSemesters),
          { concurrency: "unbounded" }
        );

        assert.strictEqual(
          new Set(
            pipe(
              runs,
              Arr.flatMap((run) => [run.current.id, run.next.id])
            )
          ).size,
          2
        );
        assert.deepStrictEqual(yield* storedLabels, ["Vår 2027", "Høst 2026"]);
      }).pipe(Effect.provide(TestServices))
  );

  it.effect("RULE-237: the job leaves older semesters as they are", () =>
    Effect.gen(function* effectProgram() {
      yield* TestClock.setTime(OCTOBER_15);

      const semesters = yield* SemesterRepository;
      yield* semesters.ensure({ term: "HOST", year: 2025 });
      yield* ensureScheduledSemesters;

      assert.deepStrictEqual(yield* storedLabels, [
        "Vår 2027",
        "Høst 2026",
        "Høst 2025",
      ]);
    }).pipe(Effect.provide(TestServices))
  );

  it.effect(
    "RULE-237: reads never write: the current semester is answered without a row, and a missing row stays missing",
    () =>
      Effect.gen(function* effectProgram() {
        yield* TestClock.setTime(OCTOBER_15);

        assert.deepStrictEqual(yield* currentSemester, {
          term: "HOST",
          year: 2026,
        });
        assert.isTrue(Option.isNone((yield* findCurrentSemester).stored));
        assert.strictEqual((yield* table((db) => db.semesters)).length, 0);

        yield* ensureScheduledSemesters;

        const found = yield* findCurrentSemester;

        assert.deepStrictEqual(
          Option.map(found.stored, semesterLabel),
          Option.some("Høst 2026")
        );
        assert.strictEqual((yield* table((db) => db.semesters)).length, 2);
      }).pipe(Effect.provide(TestServices))
  );

  it.effect("RULE-084: the semester list query is newest first", () =>
    Effect.gen(function* effectProgram() {
      const semesters = yield* SemesterRepository;

      for (const input of [
        { term: "VAR", year: 2026 },
        { term: "HOST", year: 2025 },
        { term: "HOST", year: 2026 },
      ] as const) {
        yield* semesters.ensure(input);
      }

      assert.deepStrictEqual(yield* storedLabels, [
        "Høst 2026",
        "Vår 2026",
        "Høst 2025",
      ]);
    }).pipe(Effect.provide(TestServices))
  );
});

describe("C1 fields of study", () => {
  it.effect(
    "RULE-139: a team leader creates fields of study in their own department",
    () =>
      Effect.gen(function* effectProgram() {
        const created = yield* asActor(teamLeaderTrondheim)(
          createFieldOfStudy({
            name: "Matematikk og fysikk",
            shortName: "MTFYMA",
          })
        );

        assert.strictEqual(created.departmentId, TRONDHEIM);

        const listed = yield* asActor(teamLeaderTrondheim)(
          listFieldsOfStudy(TRONDHEIM)
        );

        assert.deepStrictEqual(
          pipe(
            listed,
            Arr.map((f) => f.shortName)
          ),
          ["MTFYMA"]
        );
      }).pipe(Effect.provide(TestServices))
  );

  it.effect(
    "RULE-139: a team leader cannot open, edit or create another department's fields of study",
    () =>
      Effect.gen(function* effectProgram() {
        const bergenField = {
          departmentId: BERGEN,
          id: FieldOfStudyId.make(40),
          name: "Informatikk",
          shortName: "INF",
        };

        yield* seed.fieldOfStudy(bergenField);

        const rename = yield* Effect.exit(
          asActor(teamLeaderTrondheim)(
            renameFieldOfStudy(bergenField.id, {
              name: "Endret",
              shortName: "X",
            })
          )
        );

        const list = yield* Effect.exit(
          asActor(teamLeaderTrondheim)(listFieldsOfStudy(BERGEN))
        );

        const create = yield* Effect.exit(
          asActor(teamLeaderTrondheim)(
            createFieldOfStudy({
              departmentId: BERGEN,
              name: "Ny",
              shortName: "NY",
            })
          )
        );

        assert.deepStrictEqual(
          [failureTag(rename), failureTag(list), failureTag(create)],
          ["Forbidden", "Forbidden", "Forbidden"]
        );
        const rows = yield* table((db) => db.fieldsOfStudy);
        assert.deepStrictEqual(rows, [bergenField]);
        assert.strictEqual((yield* table((db) => db.audit)).length, 0);
      }).pipe(Effect.provide(TestServices))
  );

  it.effect(
    "RULE-139: a team leader renames their own department's field of study (audited)",
    () =>
      Effect.gen(function* effectProgram() {
        yield* seed.fieldOfStudy({
          departmentId: TRONDHEIM,
          id: FieldOfStudyId.make(7),
          name: "Gammel",
          shortName: "G",
        });

        const renamed = yield* asActor(teamLeaderTrondheim)(
          renameFieldOfStudy(FieldOfStudyId.make(7), {
            name: " Ny linje ",
            shortName: "NL",
          })
        );

        assert.strictEqual(renamed.name, "Ny linje");
        assert.deepStrictEqual(yield* auditActions, ["fieldOfStudy.updated"]);
      }).pipe(Effect.provide(TestServices))
  );

  it.effect(
    "RULE-139: a team member (not leader) is refused even in their own department",
    () =>
      Effect.gen(function* effectProgram() {
        const exit = yield* Effect.exit(
          asActor(teamMemberBergen)(
            createFieldOfStudy({ name: "Fysikk", shortName: "FYS" })
          )
        );

        assert.strictEqual(failureTag(exit), "Forbidden");
      }).pipe(Effect.provide(TestServices))
  );
});

describe("C1 departments", () => {
  const input = {
    active: true,
    address: null,
    city: "Tromsø",
    email: "tromso@example.org",
    latitude: null,
    logoKey: null,
    longitude: null,
    name: "Vektor Tromsø",
    shortName: "UiT",
    slackChannel: null,
  };

  it.effect(
    "an admin creates a department; a duplicate city is AlreadyExists",
    () =>
      Effect.gen(function* effectProgram() {
        const created = yield* asActor(admin)(createDepartment(input));
        assert.strictEqual(created.city, "Tromsø");

        const duplicate = yield* Effect.flip(
          asActor(admin)(createDepartment({ ...input, name: "Andre" }))
        );

        assert.strictEqual(duplicate._tag, "AlreadyExists");

        const leader = yield* Effect.exit(
          asActor(teamLeaderTrondheim)(
            createDepartment({ ...input, city: "Bodø" })
          )
        );

        assert.strictEqual(failureTag(leader), "Forbidden");
      }).pipe(Effect.provide(TestServices))
  );

  it.effect("a team leader updates only their own department", () =>
    Effect.gen(function* effectProgram() {
      yield* seed.department(department(TRONDHEIM, "Trondheim"));
      yield* seed.department(department(BERGEN, "Bergen"));

      const own = yield* asActor(teamLeaderTrondheim)(
        updateDepartment(TRONDHEIM, {
          ...input,
          city: "Trondheim",
          name: "Vektor NTNU",
        })
      );

      assert.strictEqual(own.name, "Vektor NTNU");

      const other = yield* Effect.exit(
        asActor(teamLeaderTrondheim)(
          updateDepartment(BERGEN, { ...input, city: "Bergen" })
        )
      );

      assert.strictEqual(failureTag(other), "Forbidden");
    }).pipe(Effect.provide(TestServices))
  );

  it.effect(
    "department input is validated (e-mail format, required fields)",
    () =>
      Effect.gen(function* effectProgram() {
        const error = yield* Effect.flip(
          asActor(admin)(
            createDepartment({ ...input, email: "tromso@", name: "  " })
          )
        );

        assert.strictEqual(error._tag, "ValidationFailed");

        if (Predicate.isTagged(error, "ValidationFailed")) {
          const fields = pipe(
            error.issues,
            Arr.map((i) => Arr.join(i.path, "."))
          );

          assert.deepStrictEqual(Arr.sort(fields, Order.String), [
            "email",
            "name",
          ]);
        }
      }).pipe(Effect.provide(TestServices))
  );
});
