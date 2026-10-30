/**
 * The applications repository (spec 0009). An application belongs to the person who applied (spec 0006b): a write takes
 * that person's `Locked` token, and so does a read that a decision rests on. The reads without a token are for display
 * and for finding whom to lock.
 */
import { Context } from "effect";
import type { DateTime, Effect } from "effect";

import type { Locked } from "../shared/aggregate.ts";
import type { AlreadyExists, Conflict, NotFound } from "../shared/errors.ts";
import type {
  AdmissionPeriodId,
  ApplicationId,
  DepartmentId,
  FieldOfStudyId,
  PersonId,
} from "../shared/ids.ts";
import type { InTransaction } from "../shared/transaction.ts";
import type { EmailAddress } from "../shared/validation.ts";
import type { ApplicationMachineTransition } from "./declaration.ts";
import type { Application, ApplicantInput } from "./entities.ts";

/** What a new application is stored with: the checked input, the period, and the consent that the special needs rest on. */
export interface ApplicationDraft {
  readonly bolk: ApplicantInput["bolk"];
  readonly doublePosition: boolean;
  readonly fieldOfStudyId: FieldOfStudyId;
  readonly gender: ApplicantInput["gender"];
  readonly heardAbout: ApplicantInput["heardAbout"];
  readonly periodId: AdmissionPeriodId;
  readonly specialNeeds: {
    readonly consentedAt: DateTime.Utc;
    readonly consentVersion: number;
    readonly text: string;
  } | null;
  readonly teamInterest: ApplicantInput["teamInterest"];
  readonly weekdays: ApplicantInput["weekdays"];
  readonly yearOfStudy: number;
}

/** An application as the panel lists it: with the person's name and address, and the department of its period. */
export interface ApplicationView extends Application {
  readonly departmentId: DepartmentId;
  readonly emailVerified: boolean;
  readonly personEmail: EmailAddress;
  readonly personName: string;
}

/** What a grant needs of an application: whose it is, and the department it is to. */
export interface ApplicationRef {
  readonly departmentId: DepartmentId;
  readonly id: ApplicationId;
  readonly periodId: AdmissionPeriodId;
  readonly personId: PersonId;
}

export class ApplicationRepository extends Context.Service<
  ApplicationRepository,
  {
    /** Stores an application for the locked person, `Submitted`. `AlreadyExists` when they already applied in the period (UK1). */
    readonly insert: (
      locked: Locked<"Person">,
      draft: ApplicationDraft
    ) => Effect.Effect<Application, AlreadyExists, InTransaction>;
    /** Whom an application is, for the grant table; the command then reads it through the lock. */
    readonly find: (
      id: ApplicationId
    ) => Effect.Effect<ApplicationRef, NotFound>;
    /** An application of the locked person: a decision read, which runs after the lock. */
    readonly findLocked: (
      locked: Locked<"Person">,
      id: ApplicationId
    ) => Effect.Effect<Application, NotFound, InTransaction>;
    /**
     * Applies one transition of the Application machine to an application of the locked person, only while it is in a
     * state that the transition starts from (CW1). One that is not (any more) is a `Conflict`.
     */
    readonly transition: (
      locked: Locked<"Person">,
      id: ApplicationId,
      transition: ApplicationMachineTransition
    ) => Effect.Effect<Application, Conflict, InTransaction>;
    /** Whether someone with this address has an application in the period, in any state and verified or not. */
    readonly existsForAddress: (
      periodId: AdmissionPeriodId,
      email: EmailAddress
    ) => Effect.Effect<boolean>;
    /** The applications of the departments, or of all (`null`), newest first. */
    readonly list: (
      departmentIds: readonly DepartmentId[] | null
    ) => Effect.Effect<readonly ApplicationView[]>;
  }
>()("@vektorprogrammet/domain/admission/ApplicationRepository") {}
