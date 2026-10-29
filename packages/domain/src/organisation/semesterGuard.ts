/**
 * The checks of a machine over semesters (spec 0022 R2). The kernel's guards compare any ordered value
 * (`kernel/guard.ts`); this hands them the semester's schema and order, so the kernel does not import this directory.
 */
import { SchemaRepresentation } from "effect";

import * as Guard from "../kernel/guard.ts";
import { Semester, SemesterOrder } from "./semester.ts";

const semesterChecks = Guard.ordered({
  order: SemesterOrder,
  schema: Semester,
});

/** Typed semester comparisons, logical checks and machine fields for a single machine's context schema. */
export const semesters = semesterChecks.comparisons;

/** Paths to semesters in this context, including semesters nested in one struct. */
export type SemesterPath<Context> = Guard.OrderedPath<Context, Semester>;

/** Revivers of the closed check vocabulary, including Effect's checks on semester years. */
export const revivers = [
  SchemaRepresentation.isIntReviver,
  SchemaRepresentation.isBetweenReviver,
  ...semesterChecks.revivers,
] as const;
