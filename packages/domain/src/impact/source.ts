/**
 * The live source of evidence of operations (spec 0027): what the records answer for a cell. The adapter that ships
 * answers `Unavailable` for every cell (D3), because the tables that placement would fill do not exist (spec 0011).
 */
import { Context } from "effect";
import type { Effect } from "effect";

import type { Semester } from "../organisation/semester.ts";
import type { DepartmentId } from "../shared/ids.ts";
import type { Answer, Slot } from "./measures.ts";

export class ImpactSource extends Context.Service<
  ImpactSource,
  {
    /**
     * The answers for the cells asked, in the order asked, from **one read** of the records: the cells of one lattice
     * relate (a total is the sum of its parts, or lies between the largest part and the sum), and answers taken from
     * different states need not. An adapter reads a lattice in one statement or one snapshot, never cell by cell.
     */
    readonly answers: (
      slots: readonly Slot[]
    ) => Effect.Effect<readonly Answer[]>;
    /** The schools of a department with a placement in the semester: the cells of the restricted grain. */
    readonly schools: (
      semester: Semester,
      department: DepartmentId
    ) => Effect.Effect<readonly number[]>;
  }
>()("@vektorprogrammet/domain/impact/ImpactSource") {}
