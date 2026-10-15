import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect } from "effect";
import { TestClock } from "effect/testing";
import {
  DepartmentId,
  EmailAddress,
  FieldOfStudyId,
  anonymous,
  createDepartment,
  createFieldOfStudy,
  createSemester,
  ensureCurrentSemester,
  listFieldsOfStudy,
  listSemestersNewestFirst,
  renameFieldOfStudy,
  semesterLabel,
  updateDepartment,
  type Department,
} from "../../src/index.ts";
import {
  BERGEN,
  TRONDHEIM,
  TestServices,
  admin,
  asActor,
  failureTag,
  seed,
  table,
  teamLeaderTrondheim,
  teamMemberBergen,
} from "../support/inMemory.ts";

/** 2026-10-15 12:00 in Oslo. */
const OCTOBER_15 = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-15T10:00:00Z"));

const department = (id: DepartmentId, city: string): Department => ({
  id,
  name: `Vektor ${city}`,
  shortName: city.slice(0, 4).toUpperCase(),
  email: EmailAddress.make(`${city.toLowerCase()}@example.org`),
  city,
  address: null,
  active: true,
  slackChannel: null,
  logoKey: null,
  latitude: null,
  longitude: null,
});

describe("C1 semesters", () => {
  it.effect("RULE-144: an admin creates a semester and the write is audited", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(OCTOBER_15);
      const created = yield* asActor(admin)(createSemester({ term: "HOST", year: 2026 }));
      assert.strictEqual(semesterLabel(created), "Høst 2026");
      const audit = yield* table((db) => db.audit);
      assert.deepStrictEqual(
        audit.map((entry) => [entry.action, entry.actorId, entry.entityKey]),
        [["semester.created", admin.userId, String(created.id)]],
      );
    }).pipe(Effect.provide(TestServices)),
  );

  it.effect(
    "RULE-144: creating an existing semester is refused with a message and nothing is saved",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(OCTOBER_15);
        yield* asActor(admin)(createSemester({ term: "HOST", year: 2026 }));
        const error = yield* Effect.flip(
          asActor(admin)(createSemester({ term: "HOST", year: 2026 })),
        );
        assert.strictEqual(error._tag, "AlreadyExists");
        assert.strictEqual(
          error._tag === "AlreadyExists" ? error.message : "",
          "Semesteret Høst 2026 finnes allerede",
        );
        assert.strictEqual((yield* table((db) => db.semesters)).length, 1);
        assert.strictEqual((yield* table((db) => db.audit)).length, 1);
      }).pipe(Effect.provide(TestServices)),
  );

  it.effect("RULE-144: years outside 2012..next year are refused", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(OCTOBER_15);
      const tooLate = yield* Effect.flip(
        asActor(admin)(createSemester({ term: "VAR", year: 2028 })),
      );
      const tooEarly = yield* Effect.flip(
        asActor(admin)(createSemester({ term: "VAR", year: 2011 })),
      );
      assert.strictEqual(tooLate._tag, "ValidationFailed");
      assert.strictEqual(tooEarly._tag, "ValidationFailed");
      const ok = yield* asActor(admin)(createSemester({ term: "VAR", year: 2027 }));
      assert.strictEqual(ok.year, 2027);
    }).pipe(Effect.provide(TestServices)),
  );

  it.effect("RULE-144: only an admin creates semesters", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(OCTOBER_15);
      for (const actor of [anonymous, teamLeaderTrondheim, teamMemberBergen]) {
        const exit = yield* Effect.exit(
          asActor(actor)(createSemester({ term: "HOST", year: 2026 })),
        );
        assert.strictEqual(failureTag(exit), "Forbidden");
      }
      assert.strictEqual((yield* table((db) => db.semesters)).length, 0);
    }).pipe(Effect.provide(TestServices)),
  );

  it.effect("RULE-237: the current semester row is created when missing", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(OCTOBER_15);
      const current = yield* ensureCurrentSemester;
      assert.deepStrictEqual([current.term, current.year], ["HOST", 2026]);
      const again = yield* ensureCurrentSemester;
      assert.strictEqual(again.id, current.id);
      assert.strictEqual((yield* table((db) => db.semesters)).length, 1);
    }).pipe(Effect.provide(TestServices)),
  );

  it.effect("RULE-237: 20 concurrent calls on an empty table yield exactly one row", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(OCTOBER_15);
      const results = yield* Effect.all(
        Array.from({ length: 20 }, () => ensureCurrentSemester),
        {
          concurrency: "unbounded",
        },
      );
      assert.strictEqual(new Set(results.map((s) => s.id)).size, 1);
      assert.strictEqual((yield* table((db) => db.semesters)).length, 1);
    }).pipe(Effect.provide(TestServices)),
  );

  it.effect("RULE-084: the semester list query is newest first", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(OCTOBER_15);
      for (const input of [
        { term: "VAR", year: 2026 },
        { term: "HOST", year: 2025 },
        { term: "HOST", year: 2026 },
      ]) {
        yield* asActor(admin)(createSemester(input));
      }
      const listed = yield* listSemestersNewestFirst;
      assert.deepStrictEqual(listed.map(semesterLabel), ["Høst 2026", "Vår 2026", "Høst 2025"]);
    }).pipe(Effect.provide(TestServices)),
  );
});

describe("C1 fields of study", () => {
  it.effect("RULE-139: a team leader creates fields of study in their own department", () =>
    Effect.gen(function* () {
      const created = yield* asActor(teamLeaderTrondheim)(
        createFieldOfStudy({ name: "Matematikk og fysikk", shortName: "MTFYMA" }),
      );
      assert.strictEqual(created.departmentId, TRONDHEIM);
      const listed = yield* asActor(teamLeaderTrondheim)(listFieldsOfStudy(TRONDHEIM));
      assert.deepStrictEqual(
        listed.map((f) => f.shortName),
        ["MTFYMA"],
      );
    }).pipe(Effect.provide(TestServices)),
  );

  it.effect(
    "RULE-139: a team leader cannot open, edit or create another department's fields of study",
    () =>
      Effect.gen(function* () {
        const bergenField = {
          id: FieldOfStudyId.make(40),
          departmentId: BERGEN,
          name: "Informatikk",
          shortName: "INF",
        };
        yield* seed.fieldOfStudy(bergenField);
        const rename = yield* Effect.exit(
          asActor(teamLeaderTrondheim)(
            renameFieldOfStudy(bergenField.id, { name: "Endret", shortName: "X" }),
          ),
        );
        const list = yield* Effect.exit(asActor(teamLeaderTrondheim)(listFieldsOfStudy(BERGEN)));
        const create = yield* Effect.exit(
          asActor(teamLeaderTrondheim)(
            createFieldOfStudy({ departmentId: BERGEN, name: "Ny", shortName: "NY" }),
          ),
        );
        assert.deepStrictEqual(
          [failureTag(rename), failureTag(list), failureTag(create)],
          ["Forbidden", "Forbidden", "Forbidden"],
        );
        const rows = yield* table((db) => db.fieldsOfStudy);
        assert.deepStrictEqual(rows, [bergenField]);
        assert.strictEqual((yield* table((db) => db.audit)).length, 0);
      }).pipe(Effect.provide(TestServices)),
  );

  it.effect("RULE-139: a team leader renames their own department's field of study (audited)", () =>
    Effect.gen(function* () {
      yield* seed.fieldOfStudy({
        id: FieldOfStudyId.make(7),
        departmentId: TRONDHEIM,
        name: "Gammel",
        shortName: "G",
      });
      const renamed = yield* asActor(teamLeaderTrondheim)(
        renameFieldOfStudy(FieldOfStudyId.make(7), { name: " Ny linje ", shortName: "NL" }),
      );
      assert.strictEqual(renamed.name, "Ny linje");
      const audit = yield* table((db) => db.audit);
      assert.deepStrictEqual(
        audit.map((e) => e.action),
        ["fieldOfStudy.updated"],
      );
    }).pipe(Effect.provide(TestServices)),
  );

  it.effect("RULE-139: a team member (not leader) is refused even in their own department", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        asActor(teamMemberBergen)(createFieldOfStudy({ name: "Fysikk", shortName: "FYS" })),
      );
      assert.strictEqual(failureTag(exit), "Forbidden");
    }).pipe(Effect.provide(TestServices)),
  );
});

describe("C1 departments", () => {
  const input = {
    name: "Vektor Tromsø",
    shortName: "UiT",
    email: "tromso@example.org",
    city: "Tromsø",
    address: null,
    active: true,
    slackChannel: null,
    logoKey: null,
    latitude: null,
    longitude: null,
  };

  it.effect("an admin creates a department; a duplicate city is AlreadyExists", () =>
    Effect.gen(function* () {
      const created = yield* asActor(admin)(createDepartment(input));
      assert.strictEqual(created.city, "Tromsø");
      const duplicate = yield* Effect.flip(
        asActor(admin)(createDepartment({ ...input, name: "Andre" })),
      );
      assert.strictEqual(duplicate._tag, "AlreadyExists");
      const leader = yield* Effect.exit(
        asActor(teamLeaderTrondheim)(createDepartment({ ...input, city: "Bodø" })),
      );
      assert.strictEqual(failureTag(leader), "Forbidden");
    }).pipe(Effect.provide(TestServices)),
  );

  it.effect("a team leader updates only their own department", () =>
    Effect.gen(function* () {
      yield* seed.department(department(TRONDHEIM, "Trondheim"));
      yield* seed.department(department(BERGEN, "Bergen"));
      const own = yield* asActor(teamLeaderTrondheim)(
        updateDepartment(TRONDHEIM, { ...input, city: "Trondheim", name: "Vektor NTNU" }),
      );
      assert.strictEqual(own.name, "Vektor NTNU");
      const other = yield* Effect.exit(
        asActor(teamLeaderTrondheim)(updateDepartment(BERGEN, { ...input, city: "Bergen" })),
      );
      assert.strictEqual(failureTag(other), "Forbidden");
    }).pipe(Effect.provide(TestServices)),
  );

  it.effect("department input is validated (e-mail format, required fields)", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        asActor(admin)(createDepartment({ ...input, email: "tromso@", name: "  " })),
      );
      assert.strictEqual(error._tag, "ValidationFailed");
      if (error._tag === "ValidationFailed") {
        assert.deepStrictEqual(error.issues.map((i) => i.path.join(".")).sort(), ["email", "name"]);
      }
    }).pipe(Effect.provide(TestServices)),
  );
});
