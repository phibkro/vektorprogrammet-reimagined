/**
 * Spec 0027 F3, F4 and F5: the release function over generated lattices. A count below the minimum is never published;
 * a reader who is told which hidden cells are small, and who tries every count, learns no hidden cell (an independent
 * search in `oracle.ts`, which shares no code with `release.ts`, and the two attacks that `release` runs, each shown on a
 * lattice of its own); a published cell is always its true value; the release does not depend on the order of the cells;
 * coverage is carried and an unavailable cell takes part in nothing. The negative controls: the primary-only release
 * can be differenced (a named lattice and the generated ones), the prior that took every hidden cell as 0 and up misses
 * a lattice that the strong reader solves, and a minimum of one publishes a three.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  Arbitrary,
  Array as Arr,
  Effect,
  Option,
  Order,
  Predicate,
  Record as Rec,
  Schema,
} from "effect";

import {
  impactCsv,
  releaseLattice,
  relationsOf,
  slotsOf,
} from "../../src/impact/lattice.ts";
import type { LatticeInput } from "../../src/impact/lattice.ts";
import {
  Answer,
  Coverage,
  Minimum,
  Released,
  Scope,
  hiddenNote,
  measureOf,
  releasedCount,
  slotId,
} from "../../src/impact/measures.ts";
import type { MeasureId, Slot } from "../../src/impact/measures.ts";
import {
  primaryOf,
  recoverable,
  recoverableByElimination,
  recoverableByNarrowing,
  release,
  releasePrimaryOnly,
} from "../../src/impact/release.ts";
import type { Cell, Relation } from "../../src/impact/release.ts";
import { DepartmentId } from "../../src/shared/ids.ts";
import { learn } from "./oracle.ts";
import type { Learned, Reader } from "./oracle.ts";

const MIN = Minimum.value;

const complete = Coverage.cases.Complete.make({});

const available = (value: number): Answer =>
  Answer.cases.Available.make({ coverage: complete, value });

/** A published cell as the test expects `release` to make it: the count must be publishable under `minimum`. */
const publishedAs = (
  coverage: Coverage,
  value: number,
  minimum: number = MIN
): Released =>
  Option.match(releasedCount(value, minimum), {
    onNone: () => assert.fail(`${value} is not publishable under ${minimum}`),
    onSome: (count) =>
      Released.cases.Published.make({ coverage, value: count }),
  });

const SEMESTER = { term: "VAR", year: 2026 } as const;

const department = (id: number) => DepartmentId.make(id);

const isSchool = (slot: Slot): boolean =>
  Predicate.isTagged(slot.scope, "School");

const slotAt = (measure: MeasureId, scope: Scope): Slot => ({
  measure,
  scope,
  semester: SEMESTER,
});

// ------------------------------------------------------------------ a world whose truth is known

const ScenarioSchema = Schema.Struct({
  departments: Schema.Int.check(Schema.isBetween({ maximum: 4, minimum: 2 })),
  measure: Schema.Literals(["assistantsPlaced", "placements", "schoolsServed"]),
  restricted: Schema.Boolean,
  seeds: Schema.Array(
    Schema.Int.check(Schema.isBetween({ maximum: 12, minimum: 0 }))
  ).check(Schema.isMinLength(48), Schema.isMaxLength(48)),
});

type Scenario = typeof ScenarioSchema.Type;

interface World {
  readonly input: LatticeInput;
  readonly relations: readonly Relation[];
  readonly truth: Readonly<Record<string, number>>;
}

const pick = (seeds: readonly number[], at: number): number =>
  seeds[at % seeds.length] ?? 0;

/** A total that is consistent with its parts: their sum, or (a distinct measure) between the largest and the sum. */
const totalOf = (
  parts: readonly number[],
  additive: boolean,
  seed: number
): number => {
  const sum = Arr.reduce(parts, 0, (a, b) => a + b);
  const largest = Math.max(0, ...parts);

  if (additive || sum === largest) {
    return additive ? sum : largest;
  }

  return largest + (seed % (sum - largest + 1));
};

const schoolsOfDepartment = (
  schools: LatticeInput["schools"],
  id: number
): readonly number[] =>
  Option.match(
    Arr.findFirst(schools, ([found]) => found === id),
    { onNone: () => [], onSome: ([, own]) => own }
  );

/** The truth of a generated lattice, bottom up, so that every relation holds for it. */
const worldOf = (scenario: Scenario): World => {
  const measure = measureOf(scenario.measure);

  const departments = Arr.makeBy(scenario.departments, (index) =>
    department(index + 1)
  );

  const additive = measure.parts === "add";

  const withSchools =
    scenario.restricted && Arr.contains(measure.grains, "school");

  const schools = Arr.map(
    departments,
    (id, index) =>
      [
        id,
        withSchools
          ? Arr.makeBy(1 + (pick(scenario.seeds, index) % 2), (n) => n + 1)
          : [],
      ] as const
  );

  const input: LatticeInput = {
    audience: scenario.restricted ? "restricted" : "standard",
    departments,
    measure,
    schools,
    semester: SEMESTER,
  };

  const schoolValue = (id: number, school: number): number =>
    pick(scenario.seeds, 7 * id + 3 * school);

  const departmentValue = (id: number): number => {
    const own = schoolsOfDepartment(schools, id);

    return own.length === 0
      ? pick(scenario.seeds, 5 * id)
      : totalOf(
          Arr.map(own, (school) => schoolValue(id, school)),
          additive,
          pick(scenario.seeds, 11 * id)
        );
  };

  const allValue = totalOf(
    Arr.map(departments, departmentValue),
    additive,
    pick(scenario.seeds, 13)
  );

  const valueOf = (slot: Slot): number =>
    Scope.match(slot.scope, {
      All: () => allValue,
      Department: ({ department: id }) => departmentValue(id),
      School: ({ department: id, school }) => schoolValue(id, school),
    });

  const truth = Rec.fromEntries(
    Arr.map(slotsOf(input), (slot) => [slotId(slot), valueOf(slot)] as const)
  );

  return { input, relations: relationsOf(input), truth };
};

const cellsOf = (world: World): readonly Cell[] =>
  Arr.map(slotsOf(world.input), (slot) => ({
    answer: available(world.truth[slotId(slot)] ?? 0),
    id: slotId(slot),
  }));

// ------------------------------------------------------------------ the reader

type Output = Readonly<Record<string, Released>>;

const suppressedIn = (out: Output): readonly string[] =>
  Arr.filter(Rec.keys(out), (id) => out[id]?._tag === "Suppressed");

/**
 * What the release assumes of a reader (`release.ts`): told the minimum and which hidden cells are primary. The ceiling
 * only keeps the search finite; the generated worlds hold at most 96 (four departments of two schools of 12).
 */
const readerOf = (cells: readonly Cell[]): Reader => ({
  ceiling: 100,
  minimum: MIN,
  primary: primaryOf(cells, MIN),
});

/** What the release holds against that reader, for the attacks that `release` itself runs. */
const priorOf = (cells: readonly Cell[]) => ({
  minimum: MIN,
  primary: primaryOf(cells, MIN),
});

/** How the searches of the properties ended: a search that gave up learned nothing, and the tests count them. */
const searches = { complete: 0, gaveUp: 0 };

const tally = (learned: Learned): Learned => {
  if (learned.complete) {
    searches.complete += 1;
  } else {
    searches.gaveUp += 1;
  }

  return learned;
};

// ------------------------------------------------------------------ the properties

const arbitrary = Arbitrary.schema(ScenarioSchema);

const property = (
  name: string,
  outcome: "Falsified" | "Passed",
  check: (scenario: Scenario) => boolean,
  runs = 1500,
  after: () => void = () => {}
) => {
  it.effect(
    name,
    () =>
      Effect.gen(function* checked() {
        const result = yield* Arbitrary.checkEffect(arbitrary, check, { runs });

        assert.strictEqual(
          result._tag,
          outcome,
          Arbitrary.formatCheckFailure(result)
        );

        after();
      }),
    120_000
  );
};

const publishedValues = (out: Output) =>
  Arr.flatMap(Rec.toEntries(out), ([id, cell]) =>
    Predicate.isTagged(cell, "Published") ? [[id, cell.value] as const] : []
  );

describe("spec 0027 F3: nothing below the minimum is published", () => {
  property(
    "property: a published cell is a true value, and is zero or at least the minimum",
    "Passed",
    (scenario) => {
      const world = worldOf(scenario);
      const out = release(cellsOf(world), world.relations, MIN);

      return Arr.every(
        publishedValues(out),
        ([id, value]) =>
          value === world.truth[id] && (value === 0 || value >= MIN)
      );
    }
  );

  it("the one maker of a published count says no for a small one, and yes for zero, the minimum and more", () => {
    assert.isTrue(Option.isNone(releasedCount(1, MIN)));
    assert.isTrue(Option.isNone(releasedCount(MIN - 1, MIN)));
    assert.isTrue(Option.isSome(releasedCount(0, MIN)));
    assert.isTrue(Option.isSome(releasedCount(MIN, MIN)));
    assert.isTrue(Option.isSome(releasedCount(MIN + 1, MIN)));
    assert.isTrue(Option.isSome(releasedCount(3, 1)));
  });

  it("negative control: a minimum of one publishes a three, so the property can fail", () => {
    const cells = [{ answer: available(3), id: "a" }];

    assert.deepStrictEqual(
      release(cells, [], 1).a,
      publishedAs(complete, 3, 1)
    );

    assert.deepStrictEqual(
      release(cells, [], MIN).a,
      Released.cases.Suppressed.make({ coverage: complete, minimum: MIN })
    );
  });

  it.effect("the encoded report of a suppressed cell has no value in it", () =>
    Effect.gen(function* encodedSuppressed() {
      const encoded = yield* Schema.encodeEffect(Released)(
        Released.cases.Suppressed.make({ coverage: complete, minimum: MIN })
      );

      assert.notProperty(encoded, "value");
    })
  );
});

const sameOutput = Schema.toEquivalence(Schema.Record(Schema.String, Released));

/**
 * The cells of a lattice of `measure` with one department for each of `parts`, by their true counts; `all` is the
 * total. `id(0)` names the total and `id(n)` the n-th department.
 */
interface Lattice {
  readonly cells: readonly Cell[];
  readonly id: (place: number) => string;
  readonly relations: readonly Relation[];
}

const lattice = (
  measure: MeasureId,
  all: number,
  parts: readonly number[]
): Lattice => {
  const departments = Arr.makeBy(parts.length, (index) =>
    department(index + 1)
  );

  const input: LatticeInput = {
    audience: "standard",
    departments,
    measure: measureOf(measure),
    schools: [],
    semester: SEMESTER,
  };

  const names = [
    slotId(slotAt(measure, Scope.cases.All.make({}))),
    ...Arr.map(departments, (found) =>
      slotId(
        slotAt(measure, Scope.cases.Department.make({ department: found }))
      )
    ),
  ];

  const id = (place: number): string =>
    Option.getOrElse(Arr.get(names, place), () =>
      assert.fail(`the lattice has no cell ${place}`)
    );

  return {
    cells: Arr.map([all, ...parts], (value, place) => ({
      answer: available(value),
      id: id(place),
    })),
    id,
    relations: relationsOf(input),
  };
};

const truthOf = (cells: readonly Cell[]): Readonly<Record<string, number>> =>
  Rec.fromEntries(
    Arr.flatMap(cells, ({ answer, id }) =>
      Predicate.isTagged(answer, "Available")
        ? [[id, answer.value] as const]
        : []
    )
  );

describe("spec 0027 F4: no hidden cell can be recovered by a reader who knows which are small", () => {
  property(
    "property: a reader who is told which hidden cells are small, and tries every count, learns no hidden cell",
    "Passed",
    (scenario) => {
      const world = worldOf(scenario);
      const cells = cellsOf(world);

      const learned = tally(
        learn(
          release(cells, world.relations, MIN),
          world.relations,
          readerOf(cells)
        )
      );

      return (
        !learned.complete ||
        (learned.determined.length === 0 && learned.solutions >= 1)
      );
    },
    400,
    () => {
      const total = searches.complete + searches.gaveUp;

      assert.isAbove(total, 0);
      // A search that gave up proved nothing: it must be rare, or the pass above is mostly a skip.
      assert.isAtMost(
        searches.gaveUp,
        Math.ceil(total / 20),
        `${searches.gaveUp} of ${total} searches gave up`
      );
    }
  );

  property(
    "property: neither attack that the release runs recovers a hidden cell of its output (the fixed point it stops at)",
    "Passed",
    (scenario) => {
      const world = worldOf(scenario);
      const cells = cellsOf(world);

      return (
        recoverable(
          release(cells, world.relations, MIN),
          world.relations,
          priorOf(cells)
        ).length === 0
      );
    }
  );

  property(
    "negative control: the primary-only release can be differenced by the same reader in some generated lattice",
    "Falsified",
    (scenario) => {
      const world = worldOf(scenario);
      const cells = cellsOf(world);

      const learned = learn(
        releasePrimaryOnly(cells, MIN),
        world.relations,
        readerOf(cells)
      );

      return !(learned.complete && learned.determined.length > 0);
    }
  );

  it("negative control: a named lattice, one small cell between published ones, is recovered without the complementary pass and not with it", () => {
    const { cells, id, relations } = lattice("placements", 22, [2, 9, 11]);
    const small = id(1);
    const truth = truthOf(cells);
    const prior = priorOf(cells);
    const reader = readerOf(cells);

    assert.deepStrictEqual(
      recoverable(releasePrimaryOnly(cells, MIN), relations, prior),
      [small]
    );

    // The independent oracle can fail too: it learns the small cell from the primary-only output, and nothing from the protected one.
    assert.deepStrictEqual(
      learn(releasePrimaryOnly(cells, MIN), relations, reader).determined,
      [small]
    );

    const protectedOutput = release(cells, relations, MIN);

    assert.deepStrictEqual(
      learn(protectedOutput, relations, reader).determined,
      []
    );
    assert.deepStrictEqual(recoverable(protectedOutput, relations, prior), []);
    assert.strictEqual(protectedOutput[small]?._tag, "Suppressed");

    // Two cells are hidden: the small one and the smallest published cell beside it (9: not 11, and not the total).
    assert.strictEqual(suppressedIn(protectedOutput).length, 2);

    // The published ones are the true ones.
    for (const [cellId, value] of publishedValues(protectedOutput)) {
      assert.strictEqual(value, truth[cellId]);
    }
  });

  it("negative control: a total of 21 with parts 4, 7 and 10 of a distinct measure gives the 4 away to a reader who knows it is below five, and the old prior (0 and up for every hidden cell) did not see it", () => {
    const { cells, id, relations } = lattice("schoolsServed", 21, [4, 7, 10]);
    const small = id(1);
    const truth = truthOf(cells);
    const reader = readerOf(cells);
    const prior = priorOf(cells);
    const unprotected = releasePrimaryOnly(cells, MIN);

    assert.deepStrictEqual(suppressedIn(unprotected), [small]);

    // The reader solves it: 21 is at most the sum of the parts, so the small part is at least 21 − 7 − 10 = 4, and it is below five.
    const learned = learn(unprotected, relations, reader);

    assert.isTrue(learned.complete);
    assert.deepStrictEqual(learned.determined, [small]);

    // Bound narrowing finds it, and only with the prior that the cell is small; exact elimination has no equation to use.
    assert.deepStrictEqual(
      recoverableByNarrowing(unprotected, relations, prior),
      [small]
    );

    assert.deepStrictEqual(
      recoverableByNarrowing(unprotected, relations, {
        minimum: MIN,
        primary: [],
      }),
      []
    );

    assert.deepStrictEqual(
      recoverableByElimination(unprotected, relations),
      []
    );

    const out = release(cells, relations, MIN);

    // The release holds the small part back and the smallest published part beside it (7); the total and the other part stay.
    assert.deepStrictEqual(
      Arr.sort(suppressedIn(out), Order.String),
      Arr.sort([small, id(2)], Order.String)
    );
    assert.strictEqual(out[id(0)]?._tag, "Published");
    assert.strictEqual(out[id(3)]?._tag, "Published");
    assert.deepStrictEqual(learn(out, relations, reader).determined, []);
    assert.deepStrictEqual(recoverable(out, relations, prior), []);

    for (const [cellId, value] of publishedValues(out)) {
      assert.strictEqual(value, truth[cellId]);
    }
  });

  it("two small parts of an additive lattice that add to what is left are found by bound narrowing with the prior, not by elimination, and the release hides the total's other part too", () => {
    const { cells, id, relations } = lattice("placements", 17, [1, 1, 15]);
    const reader = readerOf(cells);
    const prior = priorOf(cells);
    const unprotected = releasePrimaryOnly(cells, MIN);

    assert.deepStrictEqual(Arr.sort(suppressedIn(unprotected), Order.String), [
      id(1),
      id(2),
    ]);

    // 17 − 15 = 2 and each part is at least one: both are one. A row with two unknowns says neither on its own.
    assert.deepStrictEqual(
      Arr.sort(
        recoverableByNarrowing(unprotected, relations, prior),
        Order.String
      ),
      [id(1), id(2)]
    );

    assert.deepStrictEqual(
      recoverableByElimination(unprotected, relations),
      []
    );
    assert.isAbove(learn(unprotected, relations, reader).determined.length, 0);

    const out = release(cells, relations, MIN);

    assert.strictEqual(out[id(3)]?._tag, "Suppressed");
    assert.deepStrictEqual(learn(out, relations, reader).determined, []);
    assert.deepStrictEqual(recoverable(out, relations, prior), []);
  });

  it("exact elimination alone finds the small part of an additive lattice from the published ones", () => {
    const { cells, id, relations } = lattice("placements", 22, [2, 9, 11]);
    const unprotected = releasePrimaryOnly(cells, MIN);

    assert.deepStrictEqual(recoverableByElimination(unprotected, relations), [
      id(1),
    ]);
  });

  it("overlapping relations: three sums that share their parts are solved by exact elimination and not by bound narrowing, and the release holds back what elimination finds", () => {
    // x + y, y + z and x + z are published as 6 each, and x, y and z are 3 each (below five, so hidden). The relations overlap,
    // as the lattice's never do, and no interval narrows: each part lies in 2 to 4. The system has one solution.
    const relations: readonly Relation[] = [
      { kind: "sum", parts: ["x", "y"], total: "xy" },
      { kind: "sum", parts: ["y", "z"], total: "yz" },
      { kind: "sum", parts: ["x", "z"], total: "xz" },
    ];

    const cells: readonly Cell[] = Arr.map(
      [
        ["x", 3],
        ["y", 3],
        ["z", 3],
        ["xy", 6],
        ["yz", 6],
        ["xz", 6],
      ] as const,
      ([id, value]) => ({ answer: available(value), id })
    );

    const reader = readerOf(cells);
    const prior = priorOf(cells);
    const unprotected = releasePrimaryOnly(cells, MIN);

    assert.deepStrictEqual(
      recoverableByNarrowing(unprotected, relations, prior),
      []
    );

    assert.deepStrictEqual(
      Arr.sort(recoverableByElimination(unprotected, relations), Order.String),
      ["x", "y", "z"]
    );

    assert.deepStrictEqual(
      Arr.sort(learn(unprotected, relations, reader).determined, Order.String),
      ["x", "y", "z"]
    );

    const out = release(cells, relations, MIN);

    assert.deepStrictEqual(learn(out, relations, reader).determined, []);
    assert.deepStrictEqual(recoverable(out, relations, prior), []);
    assert.isAbove(suppressedIn(out).length, 3);
  });

  property(
    "property: the release does not depend on the order of the cells",
    "Passed",
    (scenario) => {
      const world = worldOf(scenario);
      const cells = cellsOf(world);

      return sameOutput(
        release(cells, world.relations, MIN),
        release(Arr.reverse(cells), Arr.reverse(world.relations), MIN)
      );
    }
  );
});

describe("spec 0027 F5: coverage is carried, and an unavailable cell takes part in nothing", () => {
  it("an incomplete cell keeps its reason, and is suppressed below the minimum like any other", () => {
    const partial = Coverage.cases.Incomplete.make({
      reason: "legacy rows 2016 to 2018 are partial",
    });

    const out = release(
      [
        {
          answer: Answer.cases.Available.make({ coverage: partial, value: 12 }),
          id: "a",
        },
        {
          answer: Answer.cases.Available.make({ coverage: partial, value: 3 }),
          id: "b",
        },
      ],
      [],
      MIN
    );

    assert.deepStrictEqual(out.a, publishedAs(partial, 12));

    assert.deepStrictEqual(
      out.b,
      Released.cases.Suppressed.make({ coverage: partial, minimum: MIN })
    );
  });

  it("an unavailable cell stays unavailable, is never a number or a zero, and its relation is dropped (the others are released alone)", () => {
    const cells: readonly Cell[] = [
      {
        answer: Answer.cases.Unavailable.make({
          reason: "placement is not built",
        }),
        id: "all",
      },
      { answer: available(2), id: "one" },
      { answer: available(30), id: "two" },
    ];

    const relations: readonly Relation[] = [
      { kind: "sum", parts: ["one", "two"], total: "all" },
    ];

    const out = release(cells, relations, MIN);

    assert.deepStrictEqual(
      out.all,
      Released.cases.Unavailable.make({ reason: "placement is not built" })
    );

    assert.strictEqual(out.one?._tag, "Suppressed");
    assert.strictEqual(out.two?._tag, "Published");
  });
});

describe("spec 0027 D6: audiences", () => {
  const base = {
    departments: [department(1), department(2)],
    measure: measureOf("placements"),
    schools: [
      [department(1), [1, 2]],
      [department(2), [1]],
    ],
    semester: SEMESTER,
  } satisfies Omit<LatticeInput, "audience">;

  it("the standard lattice has no school cell, the restricted one has them, and they are suppressed like the rest", () => {
    const standard = slotsOf({ ...base, audience: "standard" });
    const restricted = slotsOf({ ...base, audience: "restricted" });

    assert.isFalse(Arr.some(standard, isSchool));
    assert.strictEqual(Arr.filter(restricted, isSchool).length, 3);

    const out = releaseLattice(
      { ...base, audience: "restricted" },
      (slot) => available(isSchool(slot) ? 2 : 20),
      MIN
    );

    for (const { released, slot } of out) {
      if (isSchool(slot)) {
        assert.strictEqual(released._tag, "Suppressed");
      }
    }
  });

  it("a measure with no school grain has no school cell for the restricted audience either", () => {
    const slots = slotsOf({
      ...base,
      audience: "restricted",
      measure: measureOf("schoolsServed"),
    });

    assert.isFalse(Arr.some(slots, isSchool));
  });
});

const csvRow = (measure: MeasureId, place: string, released: Released) => ({
  department: place,
  measure,
  released,
  school: "",
  semester: SEMESTER,
});

describe("spec 0027 F3 and F5: the CSV is made from released cells", () => {
  const rows = [
    csvRow("placements", "Alle avdelinger", publishedAs(complete, 60)),
    csvRow(
      "placements",
      "Bergen",
      Released.cases.Suppressed.make({ coverage: complete, minimum: MIN })
    ),
    csvRow(
      "assistantsPlaced",
      "Alle avdelinger",
      Released.cases.Unavailable.make({
        reason: "placement is not built (spec 0011)",
      })
    ),
    csvRow(
      "schoolsServed",
      "Oslo, sentrum",
      publishedAs(
        Coverage.cases.Incomplete.make({ reason: "legacy rows are partial" }),
        12
      )
    ),
  ];

  it("a published cell has its value, a hidden one has none and no bound, an unavailable one has its reason, and the definition follows each", () => {
    const csv = impactCsv(rows).split("\n");

    assert.strictEqual(
      csv[0],
      "measure,semester,department,school,status,value,coverage,reason,definition"
    );
    assert.include(
      csv[1],
      "placements,Vår 2026,Alle avdelinger,,published,60,complete,,"
    );
    // The note has a comma, so the field is quoted; it names no bound, because a hidden cell may be small or large.
    assert.include(
      csv[2],
      `placements,Vår 2026,Bergen,,suppressed,,complete,"${hiddenNote(MIN).en}",`
    );
    assert.notInclude(csv[2], "less than");
    assert.include(
      csv[3],
      "assistantsPlaced,Vår 2026,Alle avdelinger,,unavailable,,unavailable,placement is not built (spec 0011),"
    );
    // A comma in a field is quoted; an incomplete number is published with its reason.
    assert.include(
      csv[4],
      '"Oslo, sentrum",,published,12,incomplete,legacy rows are partial,'
    );

    for (const [index, cell] of rows.entries()) {
      assert.include(csv[index + 1], measureOf(cell.measure).definition.en);
    }
  });
});

describe("spec 0027 D1: declared once", () => {
  it("every measure has a definition and a name in both languages and says whether its parts add up", () => {
    for (const id of [
      "assistantsPlaced",
      "placements",
      "schoolsServed",
    ] satisfies readonly MeasureId[]) {
      const measure = measureOf(id);

      assert.isAbove(measure.definition.en.length, 10);
      assert.isAbove(measure.definition.no.length, 10);
      assert.isAbove(measure.name.en.length, 3);
      assert.isAbove(measure.name.no.length, 3);
      assert.include(["add", "distinct"], measure.parts);
    }
  });

  it("the note of a hidden cell names no bound and says that it may be large, in both languages", () => {
    const note = hiddenNote(MIN);

    assert.include(note.en, "small or large");
    assert.include(note.no, "lite eller stort");
    assert.notInclude(note.en, "less than");
  });
});
