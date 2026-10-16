/**
 * C1/C2 repositories: departments, semesters (RULE-144, RULE-237) and fields of study.
 * Rows decode through the domain schemas; infrastructure failures are defects.
 */
import {
  Department,
  DepartmentRepository,
  FieldOfStudy,
  FieldOfStudyRepository,
  NotFound,
  SemesterRepository,
  StoredSemester,
} from "@vektorprogrammet/domain";
import type {
  DepartmentDraft,
  DepartmentId,
  FieldOfStudyDraft,
  FieldOfStudyId,
  Semester,
} from "@vektorprogrammet/domain";
import { and, eq, sql } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";

import { classifySqlFailure } from "../classifySqlFailure.ts";
import {
  Drizzle,
  decodeFirstOption,
  decodeWith,
  single,
} from "../internal/drizzle.ts";
import { department, fieldOfStudy, semester } from "../schema.ts";

export const DepartmentRepositoryLive = Layer.effect(
  DepartmentRepository,
  Effect.gen(function* DepartmentRepositoryLive() {
    const db = yield* Drizzle;
    const decode = decodeWith(Department);
    const decodeAll = decodeWith(Schema.Array(Department));

    const departmentById = (id: DepartmentId, rows: readonly unknown[]) => {
      const [row] = rows;

      return row === undefined
        ? Effect.fail(new NotFound({ entity: "Department", key: String(id) }))
        : decode(row);
    };

    const findById = Effect.fn("DepartmentRepository.findById")(
      function* findById(id: DepartmentId) {
        const rows = yield* db
          .select()
          .from(department)
          .where(eq(department.id, id))
          .pipe(Effect.orDie);

        return yield* departmentById(id, rows);
      }
    );

    const create = Effect.fn("DepartmentRepository.create")(function* create(
      draft: DepartmentDraft
    ) {
      const rows = yield* db
        .insert(department)
        .values(draft)
        .returning()
        .pipe(Effect.catch((error) => classifySqlFailure(error, draft.city)));

      return yield* decode(yield* single(rows));
    });

    const update = Effect.fn("DepartmentRepository.update")(function* update(
      id: DepartmentId,
      draft: DepartmentDraft
    ) {
      const rows = yield* db
        .update(department)
        .set(draft)
        .where(eq(department.id, id))
        .returning()
        .pipe(Effect.catch((error) => classifySqlFailure(error, draft.city)));

      return yield* departmentById(id, rows);
    });

    return DepartmentRepository.of({
      create,
      findById,
      list: db
        .select()
        .from(department)
        .pipe(
          Effect.orDie,
          Effect.flatMap(decodeAll),
          Effect.withSpan("DepartmentRepository.list")
        ),
      update,
    });
  })
);

const semesterColumns = {
  id: semester.id,
  term: semester.term,
  year: semester.year,
};

export const SemesterRepositoryLive = Layer.effect(
  SemesterRepository,
  Effect.gen(function* SemesterRepositoryLive() {
    const db = yield* Drizzle;
    const decode = decodeWith(StoredSemester);
    const decodeAll = decodeWith(Schema.Array(StoredSemester));
    const decodeOptional = decodeFirstOption(decode);

    const find = Effect.fn("SemesterRepository.find")(function* find(
      wanted: Semester
    ) {
      const rows = yield* db
        .select(semesterColumns)
        .from(semester)
        .where(
          and(eq(semester.term, wanted.term), eq(semester.year, wanted.year))
        )
        .pipe(Effect.orDie);

      return yield* decodeOptional(rows);
    });

    /**
     * RULE-237: one statement. `DO UPDATE` (a no-op write of the same term)
     * makes `RETURNING` yield the existing row too, so every concurrent caller
     * gets the single row without a second query. Only the scheduled job calls it (spec 0003).
     */
    const ensure = Effect.fn("SemesterRepository.ensure")(function* ensure(
      wanted: Semester
    ) {
      const rows = yield* db
        .insert(semester)
        .values({ term: wanted.term, year: wanted.year })
        .onConflictDoUpdate({
          set: { term: sql`excluded.term` },
          target: [semester.term, semester.year],
        })
        .returning(semesterColumns)
        .pipe(Effect.orDie);

      return yield* decode(yield* single(rows));
    });

    return SemesterRepository.of({
      ensure,
      find,
      list: db
        .select(semesterColumns)
        .from(semester)
        .pipe(
          Effect.orDie,
          Effect.flatMap(decodeAll),
          Effect.withSpan("SemesterRepository.list")
        ),
    });
  })
);

const fieldOfStudyColumns = {
  departmentId: fieldOfStudy.departmentId,
  id: fieldOfStudy.id,
  name: fieldOfStudy.name,
  shortName: fieldOfStudy.shortName,
};

export const FieldOfStudyRepositoryLive = Layer.effect(
  FieldOfStudyRepository,
  Effect.gen(function* FieldOfStudyRepositoryLive() {
    const db = yield* Drizzle;
    const decode = decodeWith(FieldOfStudy);
    const decodeAll = decodeWith(Schema.Array(FieldOfStudy));

    const fieldOfStudyById = (id: FieldOfStudyId, rows: readonly unknown[]) => {
      const [row] = rows;

      return row === undefined
        ? Effect.fail(new NotFound({ entity: "FieldOfStudy", key: String(id) }))
        : decode(row);
    };

    const listByDepartment = Effect.fn(
      "FieldOfStudyRepository.listByDepartment"
    )(function* listByDepartment(departmentId: DepartmentId) {
      const rows = yield* db
        .select(fieldOfStudyColumns)
        .from(fieldOfStudy)
        .where(eq(fieldOfStudy.departmentId, departmentId))
        .pipe(Effect.orDie);

      return yield* decodeAll(rows);
    });

    const findById = Effect.fn("FieldOfStudyRepository.findById")(
      function* findById(id: FieldOfStudyId) {
        const rows = yield* db
          .select(fieldOfStudyColumns)
          .from(fieldOfStudy)
          .where(eq(fieldOfStudy.id, id))
          .pipe(Effect.orDie);

        return yield* fieldOfStudyById(id, rows);
      }
    );

    const create = Effect.fn("FieldOfStudyRepository.create")(function* create(
      draft: FieldOfStudyDraft
    ) {
      const rows = yield* db
        .insert(fieldOfStudy)
        .values(draft)
        .returning(fieldOfStudyColumns)
        .pipe(Effect.orDie);

      return yield* decode(yield* single(rows));
    });

    const rename = Effect.fn("FieldOfStudyRepository.rename")(function* rename(
      id: FieldOfStudyId,
      names: { readonly name: string; readonly shortName: string }
    ) {
      const rows = yield* db
        .update(fieldOfStudy)
        .set({ name: names.name, shortName: names.shortName })
        .where(eq(fieldOfStudy.id, id))
        .returning(fieldOfStudyColumns)
        .pipe(Effect.orDie);

      return yield* fieldOfStudyById(id, rows);
    });

    return FieldOfStudyRepository.of({
      create,
      findById,
      listByDepartment,
      rename,
    });
  })
);
