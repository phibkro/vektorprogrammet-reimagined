/**
 * Organisation repositories. `packages/db` implements them as Layers; every
 * method requires nothing and fails only with the listed domain errors
 * (infrastructure failures are defects).
 */
import { Context } from "effect";
import type { DateTime, Effect, Option } from "effect";

import type { AlreadyExists, Conflict, NotFound } from "../shared/errors.ts";
import type {
  AdmissionPeriodId,
  DepartmentId,
  FieldOfStudyId,
} from "../shared/ids.ts";
import type {
  AdmissionPeriod,
  AdmissionPeriodDraft,
  StoredAdmissionPeriod,
} from "./admission.ts";
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
     * RULE-237: atomic find-or-create on the unique (term, year) key, one step (UK3; spec 0001, R1). Concurrent calls
     * all get the single record. Only the scheduled semester job calls it (spec 0003); a read never does.
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

/**
 * The admission periods of every department: the public site reads whether admission is open (`hasOpenAdmission`) and
 * recruitment staff schedule, extend and cancel them (spec 0009). The state of a period is never stored: callers derive
 * it with `admissionState`. A write is one statement that names the state the caller read, so a period that changed
 * since (a second extension, a cancellation, an application) loses with a `Conflict` and nothing is written.
 */
export class AdmissionPeriodRepository extends Context.Service<
  AdmissionPeriodRepository,
  {
    /** Unordered; the caller groups them by department. */
    readonly list: Effect.Effect<readonly AdmissionPeriod[]>;
    /** The same periods with their ids, newest start first. */
    readonly listStored: Effect.Effect<readonly StoredAdmissionPeriod[]>;
    readonly findById: (
      id: AdmissionPeriodId
    ) => Effect.Effect<StoredAdmissionPeriod, NotFound>;
    /** Fails with `AlreadyExists` on the unique `(department, semester)` (UK1). */
    readonly create: (
      draft: AdmissionPeriodDraft
    ) => Effect.Effect<StoredAdmissionPeriod, AlreadyExists>;
    /** Moves the end later, only while the period has not ended at `now` and the new end is later (CW1). */
    readonly extend: (
      id: AdmissionPeriodId,
      end: DateTime.Utc,
      now: DateTime.Utc
    ) => Effect.Effect<StoredAdmissionPeriod, NotFound | Conflict>;
    /** Removes a period that has not started at `now` and that no application refers to (CW1). */
    readonly remove: (
      id: AdmissionPeriodId,
      now: DateTime.Utc
    ) => Effect.Effect<void, NotFound | Conflict>;
  }
>()("@vektorprogrammet/domain/organisation/AdmissionPeriodRepository") {}
