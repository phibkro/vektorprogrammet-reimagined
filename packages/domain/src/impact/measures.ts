/**
 * The measures of evidence of operations, declared once (spec 0027): what each counts, in words, at which grains it is
 * published and for whom, whether its parts add up, and the minimum below which a count is never output. The page, the
 * CSV and `docs/system/impact.md` are read from this file; no count is written anywhere else.
 *
 * The raw count of a cell is a `Cell` and lives only inside `release` and the snapshot port. What leaves the domain is
 * `Released`, whose `Published` case holds a value that is not below the minimum.
 */
import { Array as Arr, Schema } from "effect";

import { Semester } from "../organisation/semester.ts";
import { DepartmentId } from "../shared/ids.ts";

export const MeasureId = Schema.Literals([
  "assistantsPlaced",
  "placements",
  "schoolsServed",
]);

export type MeasureId = typeof MeasureId.Type;

/** At which level a measure is published: a department (and all of them), or one school of a department. */
export const Grain = Schema.Literals(["department", "school"]);

export type Grain = typeof Grain.Type;

/** Who may see a grain. The command that ships serves `standard` only (spec 0027 D6). */
export const Audience = Schema.Literals(["restricted", "standard"]);

export type Audience = typeof Audience.Type;

/** The audience that a grain is published to. */
export const audienceOf = (grain: Grain): Audience =>
  grain === "school" ? "restricted" : "standard";

/** Whether `audience` may see a cell of `grain`: the restricted audience sees everything, the standard one its own grains. */
export const mayRead = (audience: Audience, grain: Grain): boolean =>
  audience === "restricted" || audienceOf(grain) === "standard";

const Words = Schema.Struct({ en: Schema.String, no: Schema.String });

export type Words = typeof Words.Type;

/**
 * How the cells of a measure relate to the cell that is their total: an additive measure's total equals the sum of its
 * parts; a distinct measure's total is at least its largest part and at most the sum of the parts (a person placed in
 * two departments is one in the total).
 */
export const Parts = Schema.Literals(["add", "distinct"]);

export type Parts = typeof Parts.Type;

export const MeasureDeclaration = Schema.Struct({
  definition: Words,
  grains: Schema.Array(Grain),
  id: MeasureId,
  name: Words,
  parts: Parts,
});

export type MeasureDeclaration = typeof MeasureDeclaration.Type;

/** The three measures. A definition that the sponsor team or the board has not confirmed is an open item of the spec. */
export const MeasureTable: Readonly<Record<MeasureId, MeasureDeclaration>> = {
  assistantsPlaced: {
    definition: {
      en: "The distinct people placed at a school in the semester: a person placed twice counts once.",
      no: "Antall ulike personer som er plassert på en skole i semesteret: en person som er plassert to ganger telles én gang.",
    },
    grains: ["department", "school"],
    id: "assistantsPlaced",
    name: { en: "Assistants placed", no: "Assistenter plassert" },
    parts: "distinct",
  },
  placements: {
    definition: {
      en: "The placements of the semester: one assistant at one school is one placement.",
      no: "Antall plasseringer i semesteret: én assistent på én skole er én plassering.",
    },
    grains: ["department", "school"],
    id: "placements",
    name: { en: "Placements", no: "Plasseringer" },
    parts: "add",
  },
  schoolsServed: {
    definition: {
      en: "The distinct schools with at least one placement in the semester.",
      no: "Antall ulike skoler med minst én plassering i semesteret.",
    },
    grains: ["department"],
    id: "schoolsServed",
    name: { en: "Schools served", no: "Skoler besøkt" },
    parts: "distinct",
  },
};

/** The measures in the order that a page lists them. */
export const Measures: readonly MeasureDeclaration[] = Arr.map(
  ["assistantsPlaced", "placements", "schoolsServed"] as const,
  (id) => MeasureTable[id]
);

/** The declaration of a measure. */
export const measureOf = (id: MeasureId): MeasureDeclaration =>
  MeasureTable[id];

const Approval = Schema.Literals(["decided", "proposed"]);

/**
 * The smallest count that is output. Below it a count is suppressed (spec 0027 D4). The value is a proposal until the
 * operator approves it; at least three, because below that "less than the minimum" says the exact value.
 */
export const Minimum = {
  approval: Approval.make("proposed"),
  value: 5,
} as const;

/** Why every cell is unavailable today (spec 0027 D3): the tables that placement would fill do not exist. */
export const NO_SOURCE_REASON = "placement is not built (spec 0011)";

export const Coverage = Schema.TaggedUnion({
  /** The source answered from complete history. */
  Complete: {},
  /** The source answered from partial history; the number is "at least". */
  Incomplete: { reason: Schema.String },
});

export type Coverage = typeof Coverage.Type;

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** What a source or a snapshot answers for one cell: a number with its coverage, or why there is none. */
export const Answer = Schema.TaggedUnion({
  Available: { coverage: Coverage, value: Count },
  Unavailable: { reason: Schema.String },
});

export type Answer = typeof Answer.Type;

/** What an output may hold for a cell: never a count below the minimum. */
export const Released = Schema.TaggedUnion({
  Published: { coverage: Coverage, value: Count },
  Suppressed: { coverage: Coverage, minimum: Schema.Int },
  Unavailable: { reason: Schema.String },
});

export type Released = typeof Released.Type;

/** Where a cell lies: all departments of the semester, one department, or one school of a department. */
export const Scope = Schema.TaggedUnion({
  All: {},
  Department: { department: DepartmentId },
  School: { department: DepartmentId, school: Schema.Int },
});

export type Scope = typeof Scope.Type;

/** One cell of the lattice: a measure, a semester and a scope. */
export const Slot = Schema.Struct({
  measure: MeasureId,
  scope: Scope,
  semester: Semester,
});

export type Slot = typeof Slot.Type;

/** The grain of a scope. `All` and a department are the department grain. */
export const grainOf = (scope: Scope): Grain =>
  Scope.match(scope, {
    All: () => "department",
    Department: () => "department",
    School: () => "school",
  });

/** A stable text for a slot, used as the cell's id in relations. */
export const slotId = ({ measure, scope, semester }: Slot): string => {
  const place = Scope.match(scope, {
    All: () => "all",
    Department: ({ department }) => `d${department}`,
    School: ({ department, school }) => `d${department}s${school}`,
  });

  return `${measure}/${semester.year}${semester.term}/${place}`;
};
