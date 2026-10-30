/**
 * What the impact domain declares about its stored columns (spec 0027 D7): the closed cells of a semester. A row is a
 * count with its provenance; it names no person and holds nothing about one. A count below the minimum is stored as it
 * was counted (the cell closes once, and its source rows may be gone) and is never output except through `release`.
 */
import { columns, notPersonal, table } from "../personalData/declaration.ts";

const COUNT =
  "A count of placements, assistants or schools for a semester and a department, or for all departments. It names no person, and a count below the minimum is output only as suppressed (spec 0027)";

const PROVENANCE =
  "Where the count came from and when it was closed: a source name, an import run, a digest of the definition and an instant. None names a person";

export const ImpactTables = {
  impact_snapshot: table({
    columns: {
      ...columns(notPersonal(COUNT), [
        "coverage",
        "coverage_reason",
        "department_id",
        "measure",
        "semester_term",
        "semester_year",
        "value",
      ]),
      ...columns(notPersonal(PROVENANCE), [
        "closed_at",
        "definition_hash",
        "source",
        "source_ref",
      ]),
      id: notPersonal("A surrogate key"),
    },
    person: null,
  }),
} as const;
