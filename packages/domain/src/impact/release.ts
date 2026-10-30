/**
 * The one release function (spec 0027 D4): the cells of a lattice in, what an output may hold out. A count below the
 * minimum is suppressed (primary); then, while a suppressed cell can still be recovered from the published ones, the
 * published cell beside it with the smallest value is suppressed too (complementary). Everything here is plain and
 * deterministic; nothing reads a clock or a store.
 *
 * Two attacks decide "can still be recovered", and both read the output and nothing else, so what they can do is what
 * a reader of the page can do: **exact elimination** (a suppressed cell that is a linear combination of published
 * cells over the additive relations) and **bound narrowing** (a suppressed cell whose feasible interval collapses to
 * one value when the relations' bounds are propagated to a fixed point). A suppressed cell may hold any count for the
 * attacker, because a complementary cell is suppressed with a value above the minimum and looks the same. Neither
 * attack is complete: an integer program could pin a value that these miss. The spec claims what the tests run.
 */
import { Array as Arr, Option, Order, Predicate, Record as Rec } from "effect";

import { Answer, Released } from "./measures.ts";

/** One cell: an id that the relations name, and what the source or the snapshot answered. */
export interface Cell {
  readonly id: string;
  readonly answer: Answer;
}

/**
 * `total` stands to `parts` as a `sum` (equal to the sum of the parts) or as `bounds` (at least the largest part and at
 * most the sum of the parts).
 */
export interface Relation {
  readonly kind: "bounds" | "sum";
  readonly parts: readonly string[];
  readonly total: string;
}

type Output = Readonly<Record<string, Released>>;

type Interval = readonly [low: number, high: number];

type Intervals = Readonly<Record<string, Interval>>;

const UNKNOWN: Interval = [0, Infinity];

const members = (relation: Relation): readonly string[] => [
  relation.total,
  ...relation.parts,
];

const valueOf = (released: Released | undefined): Option.Option<number> =>
  released?._tag === "Published" ? Option.some(released.value) : Option.none();

const suppressedIds = (released: Output): readonly string[] =>
  Arr.filter(Rec.keys(released), (id) => released[id]?._tag === "Suppressed");

// ------------------------------------------------------------------ bound narrowing

const intervalOf = (state: Intervals, id: string): Interval =>
  state[id] ?? UNKNOWN;

const sumOf = (intervals: readonly Interval[], end: 0 | 1): number =>
  Arr.reduce(intervals, 0, (sum, interval) => sum + interval[end]);

/** The intervals of a relation's members after it is applied once to `state`. */
const narrowed = (relation: Relation, state: Intervals): Intervals => {
  const total = intervalOf(state, relation.total);
  const parts = Arr.map(relation.parts, (id) => intervalOf(state, id));
  const sumLow = sumOf(parts, 0);
  const sumHigh = sumOf(parts, 1);
  const largestLow = Math.max(0, ...Arr.map(parts, ([low]) => low));

  const nextTotal: Interval =
    relation.kind === "sum"
      ? [Math.max(total[0], sumLow), Math.min(total[1], sumHigh)]
      : [Math.max(total[0], largestLow), Math.min(total[1], sumHigh)];

  const nextParts = Arr.map(
    relation.parts,
    (id, index): readonly [string, Interval] => {
      const [low, high] = parts[index] ?? UNKNOWN;
      const rest = Arr.filter(parts, (_other, place) => place !== index);
      const othersHigh = sumOf(rest, 1);
      const othersLow = sumOf(rest, 0);

      // Both kinds: total ≤ Σ parts, so a part is at least the total less what the others can hold.
      const fromBelow = Number.isFinite(othersHigh)
        ? nextTotal[0] - othersHigh
        : -Infinity;

      // A sum: a part is at most the total less what the others must hold. Bounds: a part is at most the total.
      const fromAbove =
        relation.kind === "sum" ? nextTotal[1] - othersLow : nextTotal[1];

      return [id, [Math.max(low, fromBelow), Math.min(high, fromAbove)]];
    }
  );

  return Rec.fromEntries([[relation.total, nextTotal] as const, ...nextParts]);
};

const sameIntervals = (left: Intervals, right: Intervals): boolean =>
  Arr.every(Rec.toEntries(right), ([id, [low, high]]) => {
    const found = left[id];

    return found?.[0] === low && found[1] === high;
  });

/** The intervals after the relations' bounds are propagated to a fixed point (or `rounds` passes). */
const propagate = (
  start: Intervals,
  relations: readonly Relation[],
  rounds: number
): Intervals => {
  const next = Arr.reduce(relations, start, (state, relation) => ({
    ...state,
    ...narrowed(relation, state),
  }));

  return rounds === 0 || sameIntervals(next, start)
    ? next
    : propagate(next, relations, rounds - 1);
};

/** The suppressed cells whose feasible interval holds one value. */
const collapsed = (
  released: Output,
  relations: readonly Relation[]
): readonly string[] => {
  const named = Arr.dedupe(Arr.flatMap(relations, members));

  const start: Intervals = Rec.fromEntries(
    Arr.map(named, (id) => {
      const known = valueOf(released[id]);

      return [
        id,
        Option.match(known, {
          onNone: (): Interval => UNKNOWN,
          onSome: (value): Interval => [value, value],
        }),
      ] as const;
    })
  );

  const settled = propagate(start, relations, 200);

  return Arr.filter(suppressedIds(released), (id) => {
    const found = settled[id];

    return found !== undefined && found[0] === found[1];
  });
};

// ------------------------------------------------------------------ exact elimination

type Row = readonly number[];

const gcd = (a: number, b: number): number =>
  b === 0 ? Math.abs(a) : gcd(b, a % b);

/** `row` without the common factor of its entries: elimination over the integers keeps the numbers small. */
const reduced = (row: Row): Row => {
  const divisor = Arr.reduce(row, 0, gcd);

  return divisor === 0 ? row : Arr.map(row, (entry) => entry / divisor);
};

interface Elimination {
  readonly pivots: readonly number[];
  readonly rows: readonly Row[];
}

/** The pivot of `state` for `column` applied to every other row: one step of Gauss-Jordan elimination. */
const clearColumn = (state: Elimination, column: number): Elimination =>
  Option.match(
    Arr.findFirstIndex(
      state.rows,
      (row, index) =>
        (row[column] ?? 0) !== 0 && !Arr.contains(state.pivots, index)
    ),
    {
      onNone: () => state,
      onSome: (index) => {
        const pivot = state.rows[index] ?? [];
        const lead = pivot[column] ?? 1;

        return {
          pivots: [...state.pivots, index],
          rows: Arr.map(state.rows, (row, at) => {
            const factor = row[column] ?? 0;

            return at === index || factor === 0
              ? row
              : reduced(
                  Arr.map(
                    row,
                    (entry, place) =>
                      entry * lead - (pivot[place] ?? 0) * factor
                  )
                );
          }),
        };
      },
    }
  );

/** Gauss-Jordan elimination over the integers, one column at a time. */
const eliminate = (rows: readonly Row[], columns: number): readonly Row[] => {
  const start: Elimination = { pivots: [], rows };

  return Arr.reduce(Arr.range(0, columns - 1), start, clearColumn).rows;
};

/** The coefficient of a cell in the equation `Σ parts − total = 0` of a sum relation. */
const coefficient = (relation: Relation, id: string): number => {
  if (id === relation.total) {
    return -1;
  }

  return Arr.contains(relation.parts, id) ? 1 : 0;
};

/**
 * The suppressed cells that are a linear combination of the published ones over the `sum` relations: a row of the
 * reduced system with one unknown in it says that unknown's value.
 */
const eliminated = (
  released: Output,
  relations: readonly Relation[]
): readonly string[] => {
  const unknown = suppressedIds(released);

  const equations = Arr.map(
    Arr.filter(relations, (relation) => relation.kind === "sum"),
    (relation): Row => Arr.map(unknown, (id) => coefficient(relation, id))
  );

  const rows = eliminate(equations, unknown.length);

  return Arr.filter(unknown, (id, column) =>
    Arr.some(
      rows,
      (row) =>
        (row[column] ?? 0) !== 0 &&
        Arr.every(
          unknown,
          (_other, place) => place === column || (row[place] ?? 0) === 0
        )
    )
  );
};

// ------------------------------------------------------------------ the release

/** The suppressed cells of `released` that a reader can recover from the published ones. Sorted by id. */
export const recoverable = (
  released: Output,
  relations: readonly Relation[]
): readonly string[] =>
  Arr.sort(
    Arr.dedupe([
      ...collapsed(released, relations),
      ...eliminated(released, relations),
    ]),
    Order.String
  );

const suppress = (released: Output, id: string, minimum: number): Output => {
  const cell = released[id];

  return cell?._tag === "Published"
    ? {
        ...released,
        [id]: Released.cases.Suppressed.make({
          coverage: cell.coverage,
          minimum,
        }),
      }
    : released;
};

/** The published cell that shares a relation with `id` and holds the smallest value (ties: the smallest id). */
const neighbour = (
  released: Output,
  relations: readonly Relation[],
  id: string
): Option.Option<string> =>
  Arr.head(
    Arr.sort(
      Arr.filter(
        Arr.dedupe(
          Arr.flatMap(
            Arr.filter(relations, (relation) =>
              Arr.contains(members(relation), id)
            ),
            members
          )
        ),
        (other) => Option.isSome(valueOf(released[other]))
      ),
      Order.combine(
        Order.mapInput(Order.Number, (other: string) =>
          Option.getOrElse(valueOf(released[other]), () => Infinity)
        ),
        Order.String
      )
    )
  );

/** Suppresses one more cell at a time until nothing can be recovered, or nothing is left to suppress. */
const complemented = (
  released: Output,
  relations: readonly Relation[],
  minimum: number,
  passes: number
): Output => {
  const [first] = recoverable(released, relations);

  if (first === undefined || passes === 0) {
    return released;
  }

  return Option.match(neighbour(released, relations, first), {
    onNone: () => released,
    onSome: (other) =>
      complemented(
        suppress(released, other, minimum),
        relations,
        minimum,
        passes - 1
      ),
  });
};

/**
 * The output for a lattice. A cell with no answer is `Unavailable` and takes part in no relation (a relation that names
 * one is dropped: the number that it would relate does not exist). A count from 1 to `minimum − 1` is suppressed; zero
 * and larger counts are published; then the complementary pass makes sure that no suppressed cell can be recovered.
 */
export const release = (
  cells: readonly Cell[],
  relations: readonly Relation[],
  minimum: number
): Output => {
  const answered = Arr.map(
    Arr.filter(cells, ({ answer }) => Predicate.isTagged(answer, "Available")),
    ({ id }) => id
  );

  const usable = Arr.filter(relations, (relation) =>
    Arr.every(members(relation), (id) => Arr.contains(answered, id))
  );

  const first = Rec.fromEntries(
    Arr.map(
      cells,
      ({ answer, id }) =>
        [
          id,
          Answer.match(answer, {
            Available: ({ coverage, value }): Released =>
              value > 0 && value < minimum
                ? Released.cases.Suppressed.make({ coverage, minimum })
                : Released.cases.Published.make({ coverage, value }),
            Unavailable: ({ reason }): Released =>
              Released.cases.Unavailable.make({ reason }),
          }),
        ] as const
    )
  );

  return complemented(first, usable, minimum, cells.length);
};

/** The output without the complementary pass: what the control of the differencing falsifier releases. */
export const releasePrimaryOnly = (
  cells: readonly Cell[],
  minimum: number
): Output => release(cells, [], minimum);
