/**
 * C1/C2 repositories: departments, semesters (RULE-144, RULE-237), fields of study and the read-only admission periods.
 * Rows decode through the domain schemas; infrastructure failures are defects.
 */
import {
  AdmissionPeriod,
  AdmissionPeriodId,
  AdmissionPeriodRepository,
  Conflict,
  Department,
  DepartmentRepository,
  FieldOfStudy,
  FieldOfStudyRepository,
  NotFound,
  SemesterRepository,
  StoredAdmissionPeriod,
  StoredSemester,
} from "@vektorprogrammet/domain";
import type {
  AdmissionPeriodDraft,
  DepartmentDraft,
  DepartmentId,
  FieldOfStudyDraft,
  FieldOfStudyId,
  Semester,
} from "@vektorprogrammet/domain";
import { and, desc, eq, gt, lt, notExists, sql } from "drizzle-orm";
import { DateTime, Effect, Layer, Schema } from "effect";

import {
  classifySqlFailure,
  isConstraintViolation,
} from "../classifySqlFailure.ts";
import {
  Drizzle,
  decodeFirstOption,
  decodeWith,
  single,
} from "../internal/drizzle.ts";
import {
  admissionPeriod,
  application,
  department,
  fieldOfStudy,
  semester,
} from "../schema.ts";

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

/** An admission period as stored: the instants are `Date`s from the driver (the table's check keeps start before end). */
const PeriodRow = Schema.Struct({
  ...StoredAdmissionPeriod.fields,
  end: Schema.DateTimeUtcFromDate,
  start: Schema.DateTimeUtcFromDate,
});

const PeriodDates = Schema.Struct({
  ...AdmissionPeriod.fields,
  end: Schema.DateTimeUtcFromDate,
  start: Schema.DateTimeUtcFromDate,
});

const periodColumns = {
  departmentId: admissionPeriod.departmentId,
  end: admissionPeriod.endsAt,
  id: admissionPeriod.id,
  semester: { term: semester.term, year: semester.year },
  semesterId: admissionPeriod.semesterId,
  start: admissionPeriod.startsAt,
};

const PERIOD_CHANGED =
  "Opptaket ble endret av en annen, eller kan ikke endres lenger.";

/** C2 admission periods (spec 0009): each row joined to its semester; a write is one conditional statement (CW1). */
export const AdmissionPeriodRepositoryLive = Layer.effect(
  AdmissionPeriodRepository,
  Effect.gen(function* AdmissionPeriodRepositoryLive() {
    const db = yield* Drizzle;
    const decodeAll = decodeWith(Schema.Array(PeriodDates));
    const decodeStoredAll = decodeWith(Schema.Array(PeriodRow));
    const decodeStored = decodeWith(PeriodRow);
    const decodeCreated = decodeWith(Schema.Struct({ id: AdmissionPeriodId }));

    const select = () =>
      db
        .select(periodColumns)
        .from(admissionPeriod)
        .innerJoin(semester, eq(admissionPeriod.semesterId, semester.id));

    const findById = Effect.fn("AdmissionPeriodRepository.findById")(
      function* findById(id: AdmissionPeriodId) {
        const rows = yield* select()
          .where(eq(admissionPeriod.id, id))
          .pipe(Effect.orDie);

        const [row] = rows;

        return row === undefined
          ? yield* new NotFound({ entity: "AdmissionPeriod", key: String(id) })
          : yield* decodeStored(row);
      }
    );

    const create = Effect.fn("AdmissionPeriodRepository.create")(
      function* create(draft: AdmissionPeriodDraft) {
        const rows = yield* db
          .insert(admissionPeriod)
          .values({
            departmentId: draft.departmentId,
            endsAt: DateTime.toDateUtc(draft.end),
            semesterId: draft.semesterId,
            startsAt: DateTime.toDateUtc(draft.start),
          })
          .returning({ id: admissionPeriod.id })
          .pipe(
            Effect.catch((error) =>
              classifySqlFailure(error, String(draft.departmentId))
            )
          );

        const { id } = yield* decodeCreated(yield* single(rows));

        return yield* findById(id).pipe(
          Effect.catchTag("NotFound", (missing) => Effect.die(missing))
        );
      }
    );

    /** The statement's own answer is "no row": either the period is not there, or it is past what the write may change. */
    const noRowBecause = (id: AdmissionPeriodId) =>
      Effect.gen(function* explainNoRow() {
        const rows = yield* db
          .select({ id: admissionPeriod.id })
          .from(admissionPeriod)
          .where(eq(admissionPeriod.id, id))
          .pipe(Effect.orDie);

        return yield* rows.length === 0
          ? new NotFound({ entity: "AdmissionPeriod", key: String(id) })
          : new Conflict({
              entity: "AdmissionPeriod",
              key: String(id),
              message: PERIOD_CHANGED,
            });
      });

    const extend = Effect.fn("AdmissionPeriodRepository.extend")(
      function* extend(
        id: AdmissionPeriodId,
        end: DateTime.Utc,
        now: DateTime.Utc
      ) {
        const rows = yield* db
          .update(admissionPeriod)
          .set({ endsAt: DateTime.toDateUtc(end) })
          .where(
            and(
              eq(admissionPeriod.id, id),
              gt(admissionPeriod.endsAt, DateTime.toDateUtc(now)),
              lt(admissionPeriod.endsAt, DateTime.toDateUtc(end))
            )
          )
          .returning({ id: admissionPeriod.id })
          .pipe(Effect.orDie);

        return rows.length === 0
          ? yield* noRowBecause(id)
          : yield* findById(id);
      }
    );

    const remove = Effect.fn("AdmissionPeriodRepository.remove")(
      function* remove(id: AdmissionPeriodId, now: DateTime.Utc) {
        const rows = yield* db
          .delete(admissionPeriod)
          .where(
            and(
              eq(admissionPeriod.id, id),
              gt(admissionPeriod.startsAt, DateTime.toDateUtc(now)),
              notExists(
                db
                  .select({ one: sql`1` })
                  .from(application)
                  .where(eq(application.periodId, admissionPeriod.id))
              )
            )
          )
          .returning({ id: admissionPeriod.id })
          .pipe(
            // An application that committed after the check: the foreign key refuses the delete (the period is in use).
            Effect.catch((error) =>
              isConstraintViolation(error)
                ? Effect.fail(
                    new Conflict({
                      entity: "AdmissionPeriod",
                      key: String(id),
                      message: PERIOD_CHANGED,
                    })
                  )
                : Effect.die(error)
            )
          );

        if (rows.length === 0) {
          return yield* noRowBecause(id);
        }

        return yield* Effect.void;
      }
    );

    return AdmissionPeriodRepository.of({
      create,
      extend,
      findById,
      list: select().pipe(
        Effect.orDie,
        Effect.flatMap(decodeAll),
        Effect.withSpan("AdmissionPeriodRepository.list")
      ),
      listStored: select()
        .orderBy(desc(admissionPeriod.startsAt))
        .pipe(
          Effect.orDie,
          Effect.flatMap(decodeStoredAll),
          Effect.withSpan("AdmissionPeriodRepository.listStored")
        ),
      remove,
    });
  })
);
