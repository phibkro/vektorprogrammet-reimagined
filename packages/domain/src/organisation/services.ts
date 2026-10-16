/**
 * Organisation repositories. `packages/db` implements them as Layers; every
 * method requires nothing and fails only with the listed domain errors
 * (infrastructure failures are defects).
 */
import { Context } from "effect";
import type { Effect, Option } from "effect";

import type { AlreadyExists, NotFound } from "../shared/errors.ts";
import type { DepartmentId, FieldOfStudyId } from "../shared/ids.ts";
import type { Department, DepartmentDraft } from "./department.ts";
import type { FieldOfStudy, FieldOfStudyDraft } from "./fieldOfStudy.ts";
import type { Semester, StoredSemester } from "./semester.ts";

export class DepartmentRepository extends Context.Service<
  DepartmentRepository,
  {
    readonly list: Effect.Effect<readonly Department[]>;
    readonly findById: (
      id: DepartmentId
    ) => Effect.Effect<Department, NotFound>;
    /** Fails with `AlreadyExists` on the unique city constraint. */
    readonly create: (
      draft: DepartmentDraft
    ) => Effect.Effect<Department, AlreadyExists>;
    readonly update: (
      id: DepartmentId,
      draft: DepartmentDraft
    ) => Effect.Effect<Department, NotFound | AlreadyExists>;
  }
>()("@vektorprogrammet/domain/organisation/DepartmentRepository") {}

export class SemesterRepository extends Context.Service<
  SemesterRepository,
  {
    /** Unordered; callers order with `sortNewestFirst` (RULE-084). */
    readonly list: Effect.Effect<readonly StoredSemester[]>;
    readonly find: (
      semester: Semester
    ) => Effect.Effect<Option.Option<StoredSemester>>;
    /**
     * RULE-144: `INSERT … ON CONFLICT (term, year) DO NOTHING RETURNING`; no
     * returned row fails with `AlreadyExists` and nothing is saved.
     */
    readonly create: (
      semester: Semester
    ) => Effect.Effect<StoredSemester, AlreadyExists>;
    /**
     * RULE-237: atomic find-or-create on the unique (term, year) constraint, one statement:
     * `INSERT … ON CONFLICT (term, year) DO UPDATE SET term = EXCLUDED.term RETURNING *`
     * (spec 0001, R1). Concurrent calls all get the single row.
     */
    readonly ensure: (semester: Semester) => Effect.Effect<StoredSemester>;
  }
>()("@vektorprogrammet/domain/organisation/SemesterRepository") {}

export class FieldOfStudyRepository extends Context.Service<
  FieldOfStudyRepository,
  {
    readonly listByDepartment: (
      departmentId: DepartmentId
    ) => Effect.Effect<readonly FieldOfStudy[]>;
    readonly findById: (
      id: FieldOfStudyId
    ) => Effect.Effect<FieldOfStudy, NotFound>;
    readonly create: (draft: FieldOfStudyDraft) => Effect.Effect<FieldOfStudy>;
    readonly rename: (
      id: FieldOfStudyId,
      names: { readonly name: string; readonly shortName: string }
    ) => Effect.Effect<FieldOfStudy, NotFound>;
  }
>()("@vektorprogrammet/domain/organisation/FieldOfStudyRepository") {}
