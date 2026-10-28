/**
 * What a legacy import hands to the store (spec 0017, ADR 0014: the importer's writes go behind a port).
 *
 * `ImportTarget.replaceAll` replaces the organisation data of Phase 1 with the rows of a plan. Its guarantees are
 * properties of the store, whatever the engine is:
 *
 * - **All or nothing.** A typed failure, a defect or an interruption leaves the target exactly as it was.
 * - **Protected records are refused.** A target that holds an account, a credential, a consent, or durable integration
 *   activity (welcome claims, messages, job runs, Workspace reports) is refused before anything is replaced
 *   (`TargetWriteError` with `step: "protect records"`): the import cannot restore credentials, a consent is the record
 *   of what a person agreed to, and what the system itself recorded is never erased by a replacement.
 * - **The stored rows are the plan.** The row counts that the store reports equal the plan's, or the replacement fails
 *   (`step: "reconcile"`).
 *
 * It opens its own transaction and takes no `InTransaction`: it is a top-level operation, like `Transactor.run`.
 */
import { Context, Schema } from "effect";
import type { DateTime, Effect } from "effect";

import type { StoredContentType } from "../files/fileType.ts";
import type { FileKey } from "../shared/ids.ts";
import type { Term } from "./semester.ts";

/** The tables of Phase 1 that a legacy import writes, in insert (foreign-key) order. */
export const TargetTable = Schema.Literals([
  "public_file",
  "department",
  "semester",
  "field_of_study",
  "admission_period",
  "social_event",
]);

export type TargetTable = typeof TargetTable.Type;

interface PublicFileRow {
  readonly key: FileKey;
  readonly name: string;
  readonly contentType: StoredContentType;
  readonly size: number;
  readonly sha256: string;
  readonly uploadedBy: null;
  readonly legacyPath: string;
  readonly uploadedAt: DateTime.Utc;
}

interface DepartmentRow {
  readonly id: number;
  readonly name: string;
  readonly shortName: string;
  readonly email: string;
  readonly city: string;
  readonly address: string | null;
  readonly active: boolean;
  readonly slackChannel: string | null;
  readonly logoKey: FileKey | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
}

interface SemesterRow {
  readonly id: number;
  readonly term: Term;
  readonly year: number;
}

interface FieldOfStudyRow {
  readonly id: number;
  readonly departmentId: number;
  readonly name: string;
  readonly shortName: string;
}

interface AdmissionPeriodRow {
  readonly id: number;
  readonly departmentId: number;
  readonly semesterId: number;
  readonly startsAt: DateTime.Utc;
  readonly endsAt: DateTime.Utc;
}

interface SocialEventRow {
  readonly id: number;
  readonly title: string;
  readonly description: string;
  readonly startsAt: DateTime.Utc;
  readonly endsAt: DateTime.Utc;
  readonly link: string | null;
  readonly departmentId: number;
  readonly semesterId: number;
}

/** The rows of a plan, by target table. Legacy ids are kept, so the rows carry their ids. */
export interface TargetRows {
  readonly public_file: readonly PublicFileRow[];
  readonly department: readonly DepartmentRow[];
  readonly semester: readonly SemesterRow[];
  readonly field_of_study: readonly FieldOfStudyRow[];
  readonly admission_period: readonly AdmissionPeriodRow[];
  readonly social_event: readonly SocialEventRow[];
}

export class TargetWriteError extends Schema.TaggedError<
  TargetWriteError,
  { readonly brand: unique symbol }
>()("TargetWriteError", {
  cause: Schema.Defect(),
  step: Schema.String,
}) {}

export class ImportTarget extends Context.Service<
  ImportTarget,
  {
    /** Replaces the target's Phase 1 data with `rows`; returns the stored row count per table. */
    readonly replaceAll: (
      rows: TargetRows
    ) => Effect.Effect<Readonly<Record<TargetTable, number>>, TargetWriteError>;
  }
>()("@vektorprogrammet/domain/organisation/ImportTarget") {}
