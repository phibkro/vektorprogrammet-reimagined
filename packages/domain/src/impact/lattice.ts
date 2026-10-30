/**
 * The lattice of one measure in one semester (spec 0027 D4, D6): which cells there are for an audience, how they relate,
 * and the release of their answers. Plain functions: the answers come in as a function, so a test hands them in, and the
 * command reads them from the ports.
 */
import { Array as Arr, Option } from "effect";

import type { Semester } from "../organisation/semester.ts";
import { semesterLabel } from "../organisation/semester.ts";
import type { DepartmentId } from "../shared/ids.ts";
import {
  Coverage,
  Released,
  Scope,
  hiddenNote,
  mayRead,
  measureOf,
  slotId,
} from "./measures.ts";
import type {
  Answer,
  Audience,
  MeasureDeclaration,
  MeasureId,
  Slot,
} from "./measures.ts";
import { release } from "./release.ts";
import type { Relation } from "./release.ts";

/** The schools of each department in the semester that the restricted audience may see: department id, then school ids. */
export type SchoolsOf = readonly (readonly [
  department: DepartmentId,
  schools: readonly number[],
])[];

export interface LatticeInput {
  readonly audience: Audience;
  readonly departments: readonly DepartmentId[];
  readonly measure: MeasureDeclaration;
  readonly schools: SchoolsOf;
  readonly semester: Semester;
}

const slot = (input: LatticeInput, scope: Scope): Slot => ({
  measure: input.measure.id,
  scope,
  semester: input.semester,
});

const schoolsIn = (
  input: LatticeInput,
  department: DepartmentId
): readonly number[] =>
  mayRead(input.audience, "school") &&
  Arr.contains(input.measure.grains, "school")
    ? Option.match(
        Arr.findFirst(input.schools, ([id]) => id === department),
        { onNone: () => [], onSome: ([, schools]) => schools }
      )
    : [];

/** The cells of the lattice that the audience may see: all departments, each department, and (restricted) each school. */
export const slotsOf = (input: LatticeInput): readonly Slot[] => [
  slot(input, Scope.cases.All.make({})),
  ...Arr.flatMap(input.departments, (department) => [
    slot(input, Scope.cases.Department.make({ department })),
    ...Arr.map(schoolsIn(input, department), (school) =>
      slot(input, Scope.cases.School.make({ department, school }))
    ),
  ]),
];

/**
 * How the cells relate: all departments to each department, and a department to its schools. An additive measure's
 * parts sum to the total; a distinct measure's total lies between the largest part and the sum of the parts.
 */
export const relationsOf = (input: LatticeInput): readonly Relation[] => {
  const kind = input.measure.parts === "add" ? "sum" : "bounds";

  const departments: Relation = {
    kind,
    parts: Arr.map(input.departments, (department) =>
      slotId(slot(input, Scope.cases.Department.make({ department })))
    ),
    total: slotId(slot(input, Scope.cases.All.make({}))),
  };

  const schools = Arr.flatMap(
    input.departments,
    (department): readonly Relation[] => {
      const parts = schoolsIn(input, department);

      return Arr.isReadonlyArrayNonEmpty(parts)
        ? [
            {
              kind,
              parts: Arr.map(parts, (school) =>
                slotId(
                  slot(input, Scope.cases.School.make({ department, school }))
                )
              ),
              total: slotId(
                slot(input, Scope.cases.Department.make({ department }))
              ),
            },
          ]
        : [];
    }
  );

  return Arr.isReadonlyArrayNonEmpty(departments.parts)
    ? [departments, ...schools]
    : schools;
};

/** One released cell of a lattice. */
export interface ReleasedSlot {
  readonly released: Released;
  readonly slot: Slot;
}

/** The release of a lattice: the answer of each cell goes in, and what an output may hold comes out. */
export const releaseLattice = (
  input: LatticeInput,
  answerOf: (slot: Slot) => Answer,
  minimum: number
): readonly ReleasedSlot[] => {
  const slots = slotsOf(input);

  const out = release(
    Arr.map(slots, (cell) => ({ answer: answerOf(cell), id: slotId(cell) })),
    relationsOf(input),
    minimum
  );

  return Arr.flatMap(slots, (cell) => {
    const released = out[slotId(cell)];

    return released === undefined ? [] : [{ released, slot: cell }];
  });
};

// ------------------------------------------------------------------ the CSV

/** A CSV field: quoted when it holds a comma, a quote or a line break, with quotes doubled. */
const field = (text: string): string =>
  /[",\n\r]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;

/** One row of the CSV for a released cell; the page shows the same fields. */
export interface CsvCell {
  readonly department: string;
  readonly measure: MeasureId;
  readonly released: Released;
  readonly school: string;
  readonly semester: Semester;
}

const statusOf = (released: Released): string =>
  Released.match(released, {
    Published: () => "published",
    Suppressed: () => "suppressed",
    Unavailable: () => "unavailable",
  });

const valueText = (released: Released): string =>
  Released.match(released, {
    Published: ({ value }) => String(value),
    Suppressed: () => "",
    Unavailable: () => "",
  });

const coverageName = (coverage: Coverage): string =>
  Coverage.match(coverage, {
    Complete: () => "complete",
    Incomplete: () => "incomplete",
  });

const coverageText = (released: Released): string =>
  Released.match(released, {
    Published: ({ coverage }) => coverageName(coverage),
    Suppressed: ({ coverage }) => coverageName(coverage),
    Unavailable: () => "unavailable",
  });

const coverageReason = (coverage: Coverage): string =>
  Coverage.match(coverage, {
    Complete: () => "",
    Incomplete: ({ reason }) => reason,
  });

const reasonText = (released: Released): string =>
  Released.match(released, {
    Published: ({ coverage }) => coverageReason(coverage),
    Suppressed: ({ coverage, minimum }) =>
      Arr.join(
        Arr.filter(
          [hiddenNote(minimum).en, coverageReason(coverage)],
          (text) => text !== ""
        ),
        "; "
      ),
    Unavailable: ({ reason }) => reason,
  });

const HEADER = [
  "measure",
  "semester",
  "department",
  "school",
  "status",
  "value",
  "coverage",
  "reason",
  "definition",
];

/**
 * The CSV of a report: one row per released cell, with the definition of its measure. It is made from `Released` and
 * nothing else, so a suppressed cell has an empty value here as it has on the page.
 */
export const impactCsv = (cells: readonly CsvCell[]): string =>
  Arr.join(
    [
      Arr.join(HEADER, ","),
      ...Arr.map(cells, (cell) =>
        Arr.join(
          Arr.map(
            [
              cell.measure,
              semesterLabel(cell.semester),
              cell.department,
              cell.school,
              statusOf(cell.released),
              valueText(cell.released),
              coverageText(cell.released),
              reasonText(cell.released),
              measureOf(cell.measure).definition.en,
            ],
            field
          ),
          ","
        )
      ),
    ],
    "\n"
  );
