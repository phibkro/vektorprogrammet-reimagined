/**
 * Organisation repositories. `packages/db` implements them as Layers; every
 * method requires nothing and fails only with the listed domain errors
 * (infrastructure failures are defects).
 */
import { Context, type Effect, type Option } from "effect";
import type { AlreadyExists, NotFound } from "../shared/errors.ts";
import type { DepartmentId, FieldOfStudyId } from "../shared/ids.ts";
import type { Department, DepartmentDraft } from "./department.ts";
import type { FieldOfStudy, FieldOfStudyDraft } from "./fieldOfStudy.ts";
import type { Semester, StoredSemester } from "./semester.ts";

export class DepartmentRepository extends Context.Service<
  DepartmentRepository,
  {
    readonly list: Effect.Effect<ReadonlyArray<Department>>;
    findById(id: DepartmentId): Effect.Effect<Department, NotFound>;
    /** Fails with `AlreadyExists` on the unique city constraint. */
    create(draft: DepartmentDraft): Effect.Effect<Department, AlreadyExists>;
    update(
      id: DepartmentId,
      draft: DepartmentDraft,
    ): Effect.Effect<Department, NotFound | AlreadyExists>;
  }
>()("@vektorprogrammet/domain/organisation/DepartmentRepository") {}

export class SemesterRepository extends Context.Service<
  SemesterRepository,
  {
    /** Unordered; callers order with `sortNewestFirst` (RULE-084). */
    readonly list: Effect.Effect<ReadonlyArray<StoredSemester>>;
    find(semester: Semester): Effect.Effect<Option.Option<StoredSemester>>;
    /**
     * RULE-144: `INSERT … ON CONFLICT (term, year) DO NOTHING RETURNING`; no
     * returned row fails with `AlreadyExists` and nothing is saved.
     */
    create(semester: Semester): Effect.Effect<StoredSemester, AlreadyExists>;
    /**
     * RULE-237: atomic find-or-create on the unique (term, year) constraint
     * (`INSERT … ON CONFLICT DO NOTHING` then select). Concurrent calls yield one row.
     */
    ensure(semester: Semester): Effect.Effect<StoredSemester>;
  }
>()("@vektorprogrammet/domain/organisation/SemesterRepository") {}

export class FieldOfStudyRepository extends Context.Service<
  FieldOfStudyRepository,
  {
    listByDepartment(departmentId: DepartmentId): Effect.Effect<ReadonlyArray<FieldOfStudy>>;
    findById(id: FieldOfStudyId): Effect.Effect<FieldOfStudy, NotFound>;
    create(draft: FieldOfStudyDraft): Effect.Effect<FieldOfStudy>;
    rename(
      id: FieldOfStudyId,
      names: { readonly name: string; readonly shortName: string },
    ): Effect.Effect<FieldOfStudy, NotFound>;
  }
>()("@vektorprogrammet/domain/organisation/FieldOfStudyRepository") {}
