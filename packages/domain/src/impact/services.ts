/**
 * The snapshot port of evidence of operations (spec 0027) and the report that leaves the domain. `ImpactSnapshots` keeps
 * the closed cells, written once. The report holds `Released` cells and nothing else: no raw count can be put in it.
 */
import { Context, Schema } from "effect";
import type { DateTime, Effect, Option } from "effect";

import { Semester } from "../organisation/semester.ts";
import { DepartmentId } from "../shared/ids.ts";
import {
  Audience,
  MeasureDeclaration,
  MeasureId,
  Released,
  Scope,
} from "./measures.ts";
import type { Coverage } from "./measures.ts";

/** Where a closed cell came from (spec 0027 D7). */
export type SnapshotSource = "legacy-import" | "reimagined";

/** One closed cell of the standard grain: all departments of a semester, or one department. */
export interface Snapshot {
  readonly closedAt: DateTime.Utc;
  readonly coverage: Coverage;
  /** The digest of the measure's declaration when the cell was closed; a changed definition is another measure. */
  readonly definitionHash: string;
  readonly department: Option.Option<DepartmentId>;
  readonly measure: MeasureId;
  readonly semester: Semester;
  readonly source: SnapshotSource;
  /** The import run that wrote the cell, when there is one. */
  readonly sourceRef: Option.Option<string>;
  readonly value: number;
}

/**
 * The closed cells. There is an insert that never changes a closed cell and a read, and no update or delete: the
 * property is `port-enforced`, as a writer with the table's own privileges could change a row.
 */
export class ImpactSnapshots extends Context.Service<
  ImpactSnapshots,
  {
    /** Every closed cell of a semester. */
    readonly read: (semester: Semester) => Effect.Effect<readonly Snapshot[]>;
    /**
     * Closes the cells of one lattice in one statement, so that they are all closed or none is. A cell that is closed
     * already conflicts and is left as it is: the first value stays. Says how many cells it closed.
     */
    readonly close: (snapshots: readonly Snapshot[]) => Effect.Effect<number>;
  }
>()("@vektorprogrammet/domain/impact/ImpactSnapshots") {}

// ------------------------------------------------------------------ the report

export const ReportCell = Schema.Struct({
  measure: MeasureId,
  released: Released,
  scope: Scope,
  semester: Semester,
});

export type ReportCell = typeof ReportCell.Type;

/** What `listImpact` returns: the definitions, the minimum and every cell that the audience may see, as released. */
export const ImpactReport = Schema.Struct({
  audience: Audience,
  cells: Schema.Array(ReportCell),
  departments: Schema.Array(
    Schema.Struct({ id: DepartmentId, name: Schema.String })
  ),
  measures: Schema.Array(MeasureDeclaration),
  minimum: Schema.Int,
  semesters: Schema.Array(Semester),
});

export type ImpactReport = typeof ImpactReport.Type;

/** What `closeImpact` reports: cells written, cells that were closed already, cells that the source could not answer. */
export const CloseOutcome = Schema.Struct({
  alreadyClosed: Schema.Int,
  closed: Schema.Int,
  unavailable: Schema.Int,
});

export type CloseOutcome = typeof CloseOutcome.Type;
