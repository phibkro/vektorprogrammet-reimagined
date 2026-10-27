/**
 * C1/C2 command handlers (ADR 0006) and the pure semester reads. Every handler is built with
 * `OrganisationDomain.handle`, so the grant table is asked before a command runs. Staff writes require
 * `InTransaction` (the in-process client call is wrapped by the caller; see `src/README.md`), write, and record one
 * audit entry. The semester job and the semester reads are not staff writes (spec 0003): the job runs from the
 * Worker's `scheduled` handler as `System("semesters")`, and reads write nothing.
 */
import { DateTime, Effect } from "effect";

import { recordAudit } from "../audit/auditLog.ts";
import * as Commands from "../kernel/commands.ts";
import { departmentResource } from "../kernel/domain.ts";
import type { DepartmentId } from "../shared/ids.ts";
import { InTransaction } from "../shared/transaction.ts";
import {
  OrganisationDomain,
  OrganisationRpc,
  createDepartment,
  createFieldOfStudy,
  ensureSemesters,
  updateDepartment,
  updateFieldOfStudy,
} from "./declaration.ts";
import { nextSemester, semesterForDate, sortNewestFirst } from "./semester.ts";
import {
  DepartmentRepository,
  FieldOfStudyRepository,
  SemesterRepository,
} from "./services.ts";

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

/** RULE-084: semesters newest first. */
export const listSemestersNewestFirst = Effect.gen(
  function* listSemestersNewestFirst() {
    const semesters = yield* SemesterRepository;

    return sortNewestFirst(yield* semesters.list);
  }
).pipe(Effect.withSpan("listSemestersNewestFirst"));

export const OrganisationHandlers = OrganisationRpc.toLayer({
  createDepartment: OrganisationDomain.handle(createDepartment, {
    resource: () => Effect.succeed({}),
    run: (draft, principal) =>
      Effect.gen(function* run() {
        yield* InTransaction;
        const departments = yield* DepartmentRepository;
        const created = yield* departments.create(draft);
        yield* recordAudit(
          principal,
          "department.created",
          "Department",
          created.id
        );

        return created;
      }),
  }),
  createFieldOfStudy: OrganisationDomain.handle(createFieldOfStudy, {
    resource: departmentResource,
    run: (draft, principal) =>
      Effect.gen(function* run() {
        yield* InTransaction;
        const fieldsOfStudy = yield* FieldOfStudyRepository;
        const created = yield* fieldsOfStudy.create(draft);
        yield* recordAudit(
          principal,
          "fieldOfStudy.created",
          "FieldOfStudy",
          created.id
        );

        return created;
      }),
  }),
  /**
   * RULE-237 (spec 0003), the scheduled job: the current semester and the one after it (RULE-050) exist as rows.
   * Nobody creates semesters and no page view does. Idempotent and safe under concurrent runs: one
   * `INSERT … ON CONFLICT … RETURNING` per semester on the unique (term, year) constraint. Not a staff write:
   * the principal is `System("semesters")` and no audit entry is written.
   */
  ensureSemesters: OrganisationDomain.handle(ensureSemesters, {
    resource: () => Effect.succeed({}),
    run: () =>
      Effect.gen(function* run() {
        const semesters = yield* SemesterRepository;
        const current = yield* currentSemester;

        return {
          current: yield* semesters.ensure(current),
          next: yield* semesters.ensure(nextSemester(current)),
        };
      }),
  }),
  updateDepartment: OrganisationDomain.handle(updateDepartment, {
    resource: ({ id }) => Effect.succeed({ departmentId: id }),
    run: ({ id, ...draft }, principal) =>
      Effect.gen(function* run() {
        yield* InTransaction;
        const departments = yield* DepartmentRepository;
        const updated = yield* departments.update(id, draft);
        yield* recordAudit(
          principal,
          "department.updated",
          "Department",
          updated.id
        );

        return updated;
      }),
  }),
  updateFieldOfStudy: OrganisationDomain.handle(updateFieldOfStudy, {
    resource: ({ id }) =>
      Effect.gen(function* resource() {
        const fieldsOfStudy = yield* FieldOfStudyRepository;
        const { departmentId } = yield* fieldsOfStudy.findById(id);

        return { departmentId };
      }),
    run: ({ id, ...names }, principal) =>
      Effect.gen(function* run() {
        yield* InTransaction;
        const fieldsOfStudy = yield* FieldOfStudyRepository;
        const renamed = yield* fieldsOfStudy.rename(id, names);
        yield* recordAudit(
          principal,
          "fieldOfStudy.updated",
          "FieldOfStudy",
          renamed.id
        );

        return renamed;
      }),
  }),
});

/** The organisation's commands behind the in-process client; see `Commands.inProcess`. */
export const withOrganisation = Commands.inProcess(
  OrganisationRpc,
  OrganisationHandlers
);

/** The server functions' entries: untrusted input in, the command's own result out (`Commands.endpoint`). */
export const OrganisationEndpoints = {
  createDepartment: Commands.endpoint(createDepartment, (payload) =>
    withOrganisation((client) => client.createDepartment(payload))
  ),
  createFieldOfStudy: Commands.endpoint(createFieldOfStudy, (payload) =>
    withOrganisation((client) => client.createFieldOfStudy(payload))
  ),
  updateDepartment: Commands.endpoint(updateDepartment, (payload) =>
    withOrganisation((client) => client.updateDepartment(payload))
  ),
  updateFieldOfStudy: Commands.endpoint(updateFieldOfStudy, (payload) =>
    withOrganisation((client) => client.updateFieldOfStudy(payload))
  ),
};

/** The semester job (spec 0003, R1): the Worker's `scheduled` handler runs it as `System("semesters")`. */
export const semesterJob = withOrganisation((client) =>
  client.ensureSemesters()
);

/**
 * RULE-139: list a department's fields of study. The page that lists them is the page that adds and renames them,
 * so the grant is the one of `createFieldOfStudy`.
 */
export const listFieldsOfStudy = Effect.fn("listFieldsOfStudy")(
  function* listFieldsOfStudy(departmentId: DepartmentId) {
    yield* OrganisationDomain.requireGrant("createFieldOfStudy", {
      departmentId,
    });
    const fieldsOfStudy = yield* FieldOfStudyRepository;

    return yield* fieldsOfStudy.listByDepartment(departmentId);
  }
);
