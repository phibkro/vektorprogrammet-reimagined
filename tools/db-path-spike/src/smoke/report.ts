/** How a smoke run is printed: one line per check, then a summary. Pure, so the output format is tested. */
import { Array as Arr } from "effect";

import type { Verdict } from "../verdicts.ts";

export interface CheckLine {
  readonly id: string;
  readonly title: string;
  readonly verdict: Verdict;
}

/** One check: its verdict and title, then the evidence on its own line. */
export const renderLine = ({ id, title, verdict }: CheckLine) =>
  `${verdict.pass ? "PASS" : "FAIL"}  ${id.padEnd(3)} ${title}\n          ${verdict.evidence}`;

/** The ids of the checks that failed, in order. */
export const failedIds = (lines: readonly CheckLine[]) =>
  Arr.flatMap(lines, ({ id, verdict }) => (verdict.pass ? [] : [id]));

export const renderSummary = (lines: readonly CheckLine[]) => {
  const failed = failedIds(lines);

  return failed.length === 0
    ? `${lines.length} of ${lines.length} checks passed`
    : `${lines.length - failed.length} of ${lines.length} checks passed; failed: ${Arr.join(failed, ", ")}`;
};
