/**
 * C1/C2 repositories: departments, semesters (RULE-144, RULE-237) and fields of study.
 * Rows decode through the domain schemas; infrastructure failures are defects.
 */
import {
  AlreadyExists,
  Department,
  DepartmentRepository,
  FieldOfStudy,
  FieldOfStudyRepository,
  NotFound,
  SemesterRepository,
  StoredSemester,
  semesterLabel,
  type DepartmentDraft,
  type DepartmentId,
  type FieldOfStudyDraft,
  type FieldOfStudyId,
  type Semester,
} from "@vektorprogrammet/domain";
import { and, eq, sql } from "drizzle-orm";
import { Effect, Layer, Option, Schema } from "effect";
import { classifySqlFailure } from "../classifySqlFailure.ts";
import { Drizzle, decodeWith, single } from "../internal/drizzle.ts";
import { department, fieldOfStudy, semester } from "../schema.ts";

export const DepartmentRepositoryLive = Layer.effect(
  DepartmentRepository,
  Effect.gen(function* () {
    const db = yield* Drizzle;
    const decode = decodeWith(Department);
    const decodeAll = decodeWith(Schema.Array(Department));

    const findById = Effect.fn("DepartmentRepository.findById")(function* (id: DepartmentId) {
      const rows = yield* db
        .select()
        .from(department)
        .where(eq(department.id, id))
        .pipe(Effect.orDie);
      const row = rows[0];
      if (row === undefined) return yield* new NotFound({ entity: "Department", key: String(id) });
      return yield* decode(row);
    });

    const create = Effect.fn("DepartmentRepository.create")(function* (draft: DepartmentDraft) {
      const rows = yield* db
        .insert(department)
        .values(draft)
        .returning()
        .pipe(Effect.catch((failure) => classifySqlFailure(failure, draft.city)));
      return yield* decode(yield* single(rows));
    });

    const update = Effect.fn("DepartmentRepository.update")(function* (
      id: DepartmentId,
      draft: DepartmentDraft,
    ) {
      const rows = yield* db
        .update(department)
        .set(draft)
        .where(eq(department.id, id))
        .returning()
        .pipe(Effect.catch((failure) => classifySqlFailure(failure, draft.city)));
      const row = rows[0];
      if (row === undefined) return yield* new NotFound({ entity: "Department", key: String(id) });
      return yield* decode(row);
    });

    return DepartmentRepository.of({
      list: db
        .select()
        .from(department)
        .pipe(
          Effect.orDie,
          Effect.flatMap(decodeAll),
          Effect.withSpan("DepartmentRepository.list"),
        ),
      findById,
      create,
      update,
    });
  }),
);

const semesterColumns = { id: semester.id, term: semester.term, year: semester.year };

export const SemesterRepositoryLive = Layer.effect(
  SemesterRepository,
  Effect.gen(function* () {
    const db = yield* Drizzle;
    const decode = decodeWith(StoredSemester);
    const decodeAll = decodeWith(Schema.Array(StoredSemester));

    const find = Effect.fn("SemesterRepository.find")(function* (wanted: Semester) {
      const rows = yield* db
        .select(semesterColumns)
        .from(semester)
        .where(and(eq(semester.term, wanted.term), eq(semester.year, wanted.year)))
        .pipe(Effect.orDie);
      const row = rows[0];
      return row === undefined ? Option.none() : Option.some(yield* decode(row));
    });

    /** RULE-144: one statement; the database, not a prior read, decides "already exists". */
    const create = Effect.fn("SemesterRepository.create")(function* (wanted: Semester) {
      const rows = yield* db
        .insert(semester)
        .values({ term: wanted.term, year: wanted.year })
        .onConflictDoNothing({ target: [semester.term, semester.year] })
        .returning(semesterColumns)
        .pipe(Effect.orDie);
      const row = rows[0];
      if (row === undefined) {
        return yield* new AlreadyExists({
          entity: "Semester",
          key: `${wanted.term} ${wanted.year}`,
          message: `Semesteret ${semesterLabel(wanted)} finnes allerede`,
        });
      }
      return yield* decode(row);
    });

    /**
     * RULE-237: one statement. `DO UPDATE` (a no-op write of the same term)
     * makes `RETURNING` yield the existing row too, so every concurrent caller
     * gets the single row without a second query.
     */
    const ensure = Effect.fn("SemesterRepository.ensure")(function* (wanted: Semester) {
      const rows = yield* db
        .insert(semester)
        .values({ term: wanted.term, year: wanted.year })
        .onConflictDoUpdate({
          target: [semester.term, semester.year],
          set: { term: sql`excluded.term` },
        })
        .returning(semesterColumns)
        .pipe(Effect.orDie);
      return yield* decode(yield* single(rows));
    });

    return SemesterRepository.of({
      list: db
        .select(semesterColumns)
        .from(semester)
        .pipe(Effect.orDie, Effect.flatMap(decodeAll), Effect.withSpan("SemesterRepository.list")),
      find,
      create,
      ensure,
    });
  }),
);

const fieldOfStudyColumns = {
  id: fieldOfStudy.id,
  departmentId: fieldOfStudy.departmentId,
  name: fieldOfStudy.name,
  shortName: fieldOfStudy.shortName,
};

export const FieldOfStudyRepositoryLive = Layer.effect(
  FieldOfStudyRepository,
  Effect.gen(function* () {
    const db = yield* Drizzle;
    const decode = decodeWith(FieldOfStudy);
    const decodeAll = decodeWith(Schema.Array(FieldOfStudy));

    const listByDepartment = Effect.fn("FieldOfStudyRepository.listByDepartment")(function* (
      departmentId: DepartmentId,
    ) {
      const rows = yield* db
        .select(fieldOfStudyColumns)
        .from(fieldOfStudy)
        .where(eq(fieldOfStudy.departmentId, departmentId))
        .pipe(Effect.orDie);
      return yield* decodeAll(rows);
    });

    const findById = Effect.fn("FieldOfStudyRepository.findById")(function* (id: FieldOfStudyId) {
      const rows = yield* db
        .select(fieldOfStudyColumns)
        .from(fieldOfStudy)
        .where(eq(fieldOfStudy.id, id))
        .pipe(Effect.orDie);
      const row = rows[0];
      if (row === undefined)
        return yield* new NotFound({ entity: "FieldOfStudy", key: String(id) });
      return yield* decode(row);
    });

    const create = Effect.fn("FieldOfStudyRepository.create")(function* (draft: FieldOfStudyDraft) {
      const rows = yield* db
        .insert(fieldOfStudy)
        .values(draft)
        .returning(fieldOfStudyColumns)
        .pipe(Effect.orDie);
      return yield* decode(yield* single(rows));
    });

    const rename = Effect.fn("FieldOfStudyRepository.rename")(function* (
      id: FieldOfStudyId,
      names: { readonly name: string; readonly shortName: string },
    ) {
      const rows = yield* db
        .update(fieldOfStudy)
        .set({ name: names.name, shortName: names.shortName })
        .where(eq(fieldOfStudy.id, id))
        .returning(fieldOfStudyColumns)
        .pipe(Effect.orDie);
      const row = rows[0];
      if (row === undefined)
        return yield* new NotFound({ entity: "FieldOfStudy", key: String(id) });
      return yield* decode(row);
    });

    return FieldOfStudyRepository.of({ listByDepartment, findById, create, rename });
  }),
);
