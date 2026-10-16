/**
 * C1/C2 commands and queries. Staff writes require `InTransaction` (the caller
 * wraps them; see `src/README.md`), authorize first, then validate, write, and
 * record one audit entry.
 */
import { DateTime, Effect, Schema } from "effect";

import { recordAudit } from "../audit/auditLog.ts";
import {
  Capability,
  requireCapability,
  requireStaff,
} from "../shared/capabilities.ts";
import { AlreadyExists, validationFailed } from "../shared/errors.ts";
import type { DepartmentId, FieldOfStudyId } from "../shared/ids.ts";
import { InTransaction } from "../shared/transaction.ts";
import { decodeInput } from "../shared/validation.ts";
import { DepartmentInput } from "./department.ts";
import { FieldOfStudyInput, FieldOfStudyRename } from "./fieldOfStudy.ts";
import {
  FIRST_SELECTABLE_YEAR,
  Term,
  selectableYears,
  semesterForDate,
  semesterLabel,
  sortNewestFirst,
} from "./semester.ts";
import {
  DepartmentRepository,
  FieldOfStudyRepository,
  SemesterRepository,
} from "./services.ts";

export const SemesterInput = Schema.Struct({ term: Term, year: Schema.Int });

export type SemesterInput = typeof SemesterInput.Type;

const decodeSemesterInput = decodeInput(SemesterInput);

const decodeDepartmentInput = decodeInput(DepartmentInput);

const decodeFieldOfStudyInput = decodeInput(FieldOfStudyInput);

const decodeFieldOfStudyRename = decodeInput(FieldOfStudyRename);

/** RULE-144: admin creates a semester; a duplicate is refused and nothing is saved. */
export const createSemester = Effect.fn("createSemester")(
  function* createSemester(input: unknown) {
    yield* InTransaction;
    const actor = yield* requireCapability(Capability.ManageSemesters());
    const semester = yield* decodeSemesterInput(input);
    const years = selectableYears(yield* DateTime.now);

    if (!years.includes(semester.year)) {
      return yield* validationFailed(
        ["year"],
        `Velg et år mellom ${FIRST_SELECTABLE_YEAR} og ${years[0]}.`
      );
    }

    const semesters = yield* SemesterRepository;

    const created = yield* semesters.create(semester).pipe(
      Effect.mapError(
        () =>
          new AlreadyExists({
            entity: "Semester",
            key: `${semester.term} ${semester.year}`,
            message: `Semesteret ${semesterLabel(semester)} finnes allerede`,
          })
      )
    );

    yield* recordAudit(actor, "semester.created", "Semester", created.id);

    return created;
  }
);

/**
 * RULE-237: the current semester (RULE-033, by `Clock` in Europe/Oslo), created
 * when missing. Not a staff write and a single atomic statement, so it needs no
 * `InTransaction` and records no audit entry; public pages call it directly.
 */
export const ensureCurrentSemester = Effect.gen(
  function* ensureCurrentSemester() {
    const semesters = yield* SemesterRepository;

    return yield* semesters.ensure(semesterForDate(yield* DateTime.now));
  }
).pipe(Effect.withSpan("ensureCurrentSemester"));

/** RULE-084: semesters newest first. */
export const listSemestersNewestFirst = Effect.gen(
  function* listSemestersNewestFirst() {
    const semesters = yield* SemesterRepository;

    return sortNewestFirst(yield* semesters.list);
  }
).pipe(Effect.withSpan("listSemestersNewestFirst"));

export const createDepartment = Effect.fn("createDepartment")(
  function* createDepartment(input: unknown) {
    yield* InTransaction;
    const actor = yield* requireCapability(Capability.CreateDepartment());
    const draft = yield* decodeDepartmentInput(input);
    const departments = yield* DepartmentRepository;
    const created = yield* departments.create(draft);
    yield* recordAudit(actor, "department.created", "Department", created.id);

    return created;
  }
);

/** Admin, or a team leader of this department, updates it. */
export const updateDepartment = Effect.fn("updateDepartment")(
  function* updateDepartment(id: DepartmentId, input: unknown) {
    yield* InTransaction;

    const actor = yield* requireCapability(
      Capability.UpdateDepartment({ departmentId: id })
    );

    const draft = yield* decodeDepartmentInput(input);
    const departments = yield* DepartmentRepository;
    const updated = yield* departments.update(id, draft);
    yield* recordAudit(actor, "department.updated", "Department", updated.id);

    return updated;
  }
);

/**
 * RULE-139: a field of study is created in the actor's own department unless
 * an admin names another; a team leader naming another department is refused.
 */
export const createFieldOfStudy = Effect.fn("createFieldOfStudy")(
  function* createFieldOfStudy(input: unknown) {
    yield* InTransaction;
    const own = yield* requireStaff;
    const decoded = yield* decodeFieldOfStudyInput(input);
    const departmentId = decoded.departmentId ?? own.departmentId;

    const actor = yield* requireCapability(
      Capability.ManageFieldsOfStudy({ departmentId })
    );

    const fieldsOfStudy = yield* FieldOfStudyRepository;

    const created = yield* fieldsOfStudy.create({
      departmentId,
      name: decoded.name,
      shortName: decoded.shortName,
    });

    yield* recordAudit(
      actor,
      "fieldOfStudy.created",
      "FieldOfStudy",
      created.id
    );

    return created;
  }
);

/** RULE-139: only within the field of study's own department. */
export const renameFieldOfStudy = Effect.fn("renameFieldOfStudy")(
  function* renameFieldOfStudy(id: FieldOfStudyId, input: unknown) {
    yield* InTransaction;
    const fieldsOfStudy = yield* FieldOfStudyRepository;
    const existing = yield* fieldsOfStudy.findById(id);

    const actor = yield* requireCapability(
      Capability.ManageFieldsOfStudy({ departmentId: existing.departmentId })
    );

    const names = yield* decodeFieldOfStudyRename(input);
    const renamed = yield* fieldsOfStudy.rename(id, names);
    yield* recordAudit(
      actor,
      "fieldOfStudy.updated",
      "FieldOfStudy",
      renamed.id
    );

    return renamed;
  }
);

/** RULE-139: list a department's fields of study (same capability as editing them). */
export const listFieldsOfStudy = Effect.fn("listFieldsOfStudy")(
  function* listFieldsOfStudy(departmentId: DepartmentId) {
    yield* requireCapability(Capability.ManageFieldsOfStudy({ departmentId }));
    const fieldsOfStudy = yield* FieldOfStudyRepository;

    return yield* fieldsOfStudy.listByDepartment(departmentId);
  }
);
