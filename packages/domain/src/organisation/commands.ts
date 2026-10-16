/**
 * C1/C2 commands and queries. Staff writes require `InTransaction` (the caller
 * wraps them; see `src/README.md`), authorize first, then validate, write, and
 * record one audit entry. The semester job and the semester reads are not staff
 * writes (spec 0003): the job runs from the Worker's `scheduled` handler, reads write nothing.
 */
import { DateTime, Effect } from "effect";

import { recordAudit } from "../audit/auditLog.ts";
import {
  Capability,
  requireCapability,
  requireStaff,
} from "../shared/capabilities.ts";
import type { DepartmentId, FieldOfStudyId } from "../shared/ids.ts";
import { InTransaction } from "../shared/transaction.ts";
import { decodeInput } from "../shared/validation.ts";
import { DepartmentInput } from "./department.ts";
import { FieldOfStudyInput, FieldOfStudyRename } from "./fieldOfStudy.ts";
import { nextSemester, semesterForDate, sortNewestFirst } from "./semester.ts";
import {
  DepartmentRepository,
  FieldOfStudyRepository,
  SemesterRepository,
} from "./services.ts";

const decodeDepartmentInput = decodeInput(DepartmentInput);

const decodeFieldOfStudyInput = decodeInput(FieldOfStudyInput);

const decodeFieldOfStudyRename = decodeInput(FieldOfStudyRename);

/**
 * RULE-033: which semester it is, by the Oslo calendar and the `Clock`. A pure answer: it needs no
 * row and writes nothing, so every read asks it, never the database.
 */
export const currentSemester = Effect.map(DateTime.now, semesterForDate);

/**
 * RULE-237 (spec 0003): the current semester (one Clock read) and its stored row, `None` until the
 * scheduled job has written it. A read: it never inserts, and a caller shows the missing row as a
 * visible state.
 */
export const findCurrentSemester = Effect.gen(function* findCurrentSemester() {
  const semesters = yield* SemesterRepository;
  const semester = yield* currentSemester;

  return { semester, stored: yield* semesters.find(semester) };
}).pipe(Effect.withSpan("findCurrentSemester"));

/**
 * RULE-237 (spec 0003), the scheduled job: the current semester and the one after it (RULE-050)
 * exist as rows. Nobody creates semesters and no page view does. Idempotent and safe under concurrent
 * runs: one `INSERT … ON CONFLICT … RETURNING` per semester on the unique (term, year) constraint.
 * Not a staff write: no actor, no `InTransaction`, no audit entry.
 */
export const ensureScheduledSemesters = Effect.gen(
  function* ensureScheduledSemesters() {
    const semesters = yield* SemesterRepository;
    const current = yield* currentSemester;

    return {
      current: yield* semesters.ensure(current),
      next: yield* semesters.ensure(nextSemester(current)),
    };
  }
).pipe(Effect.withSpan("ensureScheduledSemesters"));

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
