/**
 * Spec 0027 F3, F4 and F5: the release function over generated lattices. A count below the minimum is never published;
 * no suppressed cell can be recovered from the published ones, by the two attacks that `release` runs and by an
 * independent brute force that tries every count for the suppressed cells; a published cell is always its true value; the
 * release does not depend on the order of the cells; coverage is carried and an unavailable cell takes part in nothing.
 * The negative controls: the primary-only release can be differenced (a named lattice and the generated ones), and a
 * minimum of one publishes a three.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  Arbitrary,
  Array as Arr,
  Effect,
  Option,
  Predicate,
  Record as Rec,
  Schema,
} from "effect";

import {
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
  measureOf,
  slotId,
} from "../../src/impact/measures.ts";
import type { MeasureId, Slot } from "../../src/impact/measures.ts";
import {
  recoverable,
  release,
  releasePrimaryOnly,
} from "../../src/impact/release.ts";
import type { Cell, Relation } from "../../src/impact/release.ts";
import { DepartmentId } from "../../src/shared/ids.ts";

const MIN = Minimum.value;

const complete = Coverage.cases.Complete.make({});

const available = (value: number): Answer =>
  Answer.cases.Available.make({ coverage: complete, value });

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

// ------------------------------------------------------------------ an attacker that tries every count

type Output = Readonly<Record<string, Released>>;

type Assignment = Readonly<Record<string, number>>;

const holds = (relations: readonly Relation[], values: Assignment): boolean =>
  Arr.every(relations, (relation) => {
    const total = values[relation.total] ?? 0;
    const parts = Arr.map(relation.parts, (id) => values[id] ?? 0);
    const sum = Arr.reduce(parts, 0, (a, b) => a + b);

    return relation.kind === "sum"
      ? total === sum
      : total >= Math.max(0, ...parts) && total <= sum;
  });

/** Every assignment of counts 0 to `ceiling` to `unknown` that satisfies every relation, given the published values. */
const consistent = (
  out: Output,
  relations: readonly Relation[],
  unknown: readonly string[],
  ceiling: number
): readonly Assignment[] => {
  const known = Rec.fromEntries(
    Arr.flatMap(Rec.toEntries(out), ([id, cell]) =>
      Predicate.isTagged(cell, "Published") ? [[id, cell.value] as const] : []
    )
  );

  const assign = (index: number, values: Assignment): readonly Assignment[] => {
    const id = unknown[index];

    if (id === undefined) {
      return holds(relations, values) ? [values] : [];
    }

    return Arr.flatMap(Arr.range(0, ceiling), (value) =>
      assign(index + 1, { ...values, [id]: value })
    );
  };

  return assign(0, known);
};

const suppressedIn = (out: Output): readonly string[] =>
  Arr.filter(Rec.keys(out), (id) => out[id]?._tag === "Suppressed");

/** The suppressed cells that every consistent assignment gives one value: a reader who tries everything learns them. */
const determined = (
  out: Output,
  relations: readonly Relation[],
  ceiling: number
): readonly string[] | undefined => {
  const unknown = suppressedIn(out);

  if (unknown.length > 3) {
    return undefined;
  }

  const options = consistent(out, relations, unknown, ceiling);

  return Arr.filter(
    unknown,
    (id) => new Set(Arr.map(options, (values) => values[id])).size === 1
  );
};

// ------------------------------------------------------------------ the properties

const arbitrary = Arbitrary.schema(ScenarioSchema);

const property = (
  name: string,
  outcome: "Falsified" | "Passed",
  check: (scenario: Scenario) => boolean,
  runs = 1500
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

  it("negative control: a minimum of one publishes a three, so the property can fail", () => {
    const cells = [{ answer: available(3), id: "a" }];

    assert.deepStrictEqual(
      release(cells, [], 1).a,
      Released.cases.Published.make({ coverage: complete, value: 3 })
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

describe("spec 0027 F4: no suppressed cell can be recovered", () => {
  property(
    "property: neither attack of the release recovers a suppressed cell of the output",
    "Passed",
    (scenario) => {
      const world = worldOf(scenario);

      return (
        recoverable(
          release(cellsOf(world), world.relations, MIN),
          world.relations
        ).length === 0
      );
    }
  );

  property(
    "property: a reader who tries every count learns no suppressed cell either (lattices with at most three suppressed cells)",
    "Passed",
    (scenario) => {
      const world = worldOf(scenario);
      const out = release(cellsOf(world), world.relations, MIN);
      const learned = determined(out, world.relations, 36);

      return learned === undefined || learned.length === 0;
    },
    300
  );

  property(
    "negative control: the primary-only release can be differenced in some generated lattice",
    "Falsified",
    (scenario) => {
      const world = worldOf(scenario);

      return (
        recoverable(releasePrimaryOnly(cellsOf(world), MIN), world.relations)
          .length === 0
      );
    }
  );

  it("negative control: a named lattice, one small cell between published ones, is recovered without the complementary pass and not with it", () => {
    const input: LatticeInput = {
      audience: "standard",
      departments: [department(1), department(2), department(3)],
      measure: measureOf("placements"),
      schools: [],
      semester: SEMESTER,
    };

    const small = slotId(
      slotAt(
        "placements",
        Scope.cases.Department.make({ department: department(1) })
      )
    );

    const truth = Rec.fromEntries([
      [slotId(slotAt("placements", Scope.cases.All.make({}))), 22],
      [small, 2],
      [
        slotId(
          slotAt(
            "placements",
            Scope.cases.Department.make({ department: department(2) })
          )
        ),
        9,
      ],
      [
        slotId(
          slotAt(
            "placements",
            Scope.cases.Department.make({ department: department(3) })
          )
        ),
        11,
      ],
    ] as const);

    const cells = Arr.map(Rec.toEntries(truth), ([id, value]) => ({
      answer: available(value),
      id,
    }));

    const relations = relationsOf(input);

    assert.deepStrictEqual(
      recoverable(releasePrimaryOnly(cells, MIN), relations),
      [small]
    );

    // The independent oracle can fail too: it learns the small cell from the primary-only output, and nothing from the protected one.
    assert.deepStrictEqual(
      determined(releasePrimaryOnly(cells, MIN), relations, 36),
      [small]
    );

    const protectedOutput = release(cells, relations, MIN);

    assert.deepStrictEqual(determined(protectedOutput, relations, 36), []);
    assert.deepStrictEqual(recoverable(protectedOutput, relations), []);
    assert.strictEqual(protectedOutput[small]?._tag, "Suppressed");

    // Two cells are suppressed: the small one and the smallest published cell beside it (9: not 11, and not the total).
    assert.strictEqual(suppressedIn(protectedOutput).length, 2);

    // The published ones are the true ones.
    for (const [id, value] of publishedValues(protectedOutput)) {
      assert.strictEqual(value, truth[id]);
    }
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

    assert.deepStrictEqual(
      out.a,
      Released.cases.Published.make({ coverage: partial, value: 12 })
    );

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
});
