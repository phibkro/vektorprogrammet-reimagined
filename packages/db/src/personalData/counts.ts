/** The counts of a run, an erasure or a merge: integers per table, never a value (spec 0007b). */
import type { Counts } from "@vektorprogrammet/domain";
import { Array as Arr } from "effect";

/** Adds the rows that one statement changed to the table's count. */
const addRows = (
  counts: Counts,
  [table, rows]: readonly [string, number]
): Counts => ({ ...counts, [table]: (counts[table] ?? 0) + rows });

/** The rows that each table changed, added up by table, on top of `start`. */
export const tally = (
  start: Counts,
  written: readonly (readonly [string, number])[]
): Counts => Arr.reduce(written, start, addRows);

export const noCounts: Counts = {};
