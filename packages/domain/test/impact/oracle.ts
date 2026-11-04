/**
 * The attacker that the release tests hold `release` to (spec 0027 F4). It shares no code with `release.ts`: it tries
 * counts for the hidden cells, one cell after another, keeps the assignments that satisfy every relation and the
 * published values, and says which hidden cells hold one value in all of them. What it is told is what the release
 * assumes of a reader (`Reader`): the minimum, which hidden cells are primary (1 to `minimum − 1`) and nothing else about
 * the others (0 up to a ceiling that only keeps the search finite).
 *
 * The search prunes with the bounds of the relations at every step, ends early once every hidden cell has been seen
 * with two values (nothing is determined), and gives up after a number of steps. A search that gave up learned nothing and
 * says so (`complete: false`): the tests count those and require that they are few, so a pass is not a skip.
 */
import { Array as Arr, Order, Predicate, Record as Rec } from "effect";

import type { Released } from "../../src/impact/measures.ts";
import type { Relation } from "../../src/impact/release.ts";

type Output = Readonly<Record<string, Released>>;

type Bounds = readonly [low: number, high: number];

export interface Reader {
  /** The largest count that a hidden cell may hold in the search: the reader has no such limit, the search needs one. */
  readonly ceiling: number;
  readonly minimum: number;
  /** The hidden cells that hold a count from 1 to `minimum − 1`. */
  readonly primary: readonly string[];
}

export interface Learned {
  /** False when the search gave up before it could tell: `determined` is then empty and means nothing. */
  readonly complete: boolean;
  /** The hidden cells that every assignment gives one value. */
  readonly determined: readonly string[];
  /** The assignments that the search met before it stopped; the truth is one of them when the reader is told no lie. */
  readonly solutions: number;
}

const STEPS = 400_000;

/** Whether a relation can still hold when each member lies in its bounds. */
const mayHold = (
  relation: Relation,
  boundsOf: (id: string) => Bounds
): boolean => {
  const [totalLow, totalHigh] = boundsOf(relation.total);
  const parts = Arr.map(relation.parts, boundsOf);
  const sumLow = Arr.reduce(parts, 0, (sum, [low]) => sum + low);
  const sumHigh = Arr.reduce(parts, 0, (sum, [, high]) => sum + high);

  if (relation.kind === "sum") {
    return totalLow <= sumHigh && totalHigh >= sumLow;
  }

  const largestLow = Math.max(0, ...Arr.map(parts, ([low]) => low));

  return totalLow <= sumHigh && totalHigh >= largestLow;
};

/** The hidden cells, totals before their parts, so that a relation closes as early as it can. */
const searchOrder = (
  hidden: readonly string[],
  relations: readonly Relation[]
): readonly string[] => {
  const depth = (id: string, seen: readonly string[]): number => {
    const above = Arr.filter(
      relations,
      (relation) => Arr.contains(relation.parts, id) && !Arr.contains(seen, id)
    );

    return above.length === 0
      ? 0
      : 1 +
          Math.max(
            ...Arr.map(above, ({ total }) => depth(total, [...seen, id]))
          );
  };

  return Arr.sort(
    hidden,
    Order.combine(
      Order.mapInput(Order.Number, (id: string) => depth(id, [])),
      Order.String
    )
  );
};

export const learn = (
  output: Output,
  relations: readonly Relation[],
  reader: Reader
): Learned => {
  const hidden = Arr.filter(
    Rec.keys(output),
    (id) => output[id]?._tag === "Suppressed"
  );

  const published = new Map<string, number>(
    Arr.flatMap(Rec.toEntries(output), ([id, cell]) =>
      Predicate.isTagged(cell, "Published") ? [[id, cell.value] as const] : []
    )
  );

  const assigned = new Map<string, number>();

  const seen = new Map<string, Set<number>>(
    Arr.map(hidden, (id) => [id, new Set()] as const)
  );

  const order = searchOrder(hidden, relations);

  const domainOf = (id: string): Bounds =>
    Arr.contains(reader.primary, id)
      ? [1, reader.minimum - 1]
      : [0, reader.ceiling];

  const boundsOf = (id: string): Bounds => {
    const fixed = assigned.get(id) ?? published.get(id);

    return fixed === undefined ? domainOf(id) : [fixed, fixed];
  };

  const state = { gaveUp: false, solutions: 0, steps: 0, stop: false };

  const record = () => {
    state.solutions += 1;

    for (const id of hidden) {
      seen.get(id)?.add(assigned.get(id) ?? -1);
    }

    state.stop = Arr.every(hidden, (id) => (seen.get(id)?.size ?? 0) >= 2);
  };

  const search = (index: number) => {
    state.steps += 1;

    if (state.steps > STEPS) {
      state.gaveUp = true;
      state.stop = true;
    }

    if (
      state.stop ||
      !Arr.every(relations, (relation) => mayHold(relation, boundsOf))
    ) {
      return;
    }

    const id = order[index];

    if (id === undefined) {
      record();

      return;
    }

    const [low, high] = domainOf(id);

    for (let value = low; value <= high && !state.stop; value += 1) {
      assigned.set(id, value);
      search(index + 1);
    }

    assigned.delete(id);
  };

  search(0);

  return {
    complete: !state.gaveUp,
    determined: state.gaveUp
      ? []
      : Arr.filter(hidden, (id) => (seen.get(id)?.size ?? 0) === 1),
    solutions: state.solutions,
  };
};
