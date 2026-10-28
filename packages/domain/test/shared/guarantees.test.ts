/**
 * Spec 0018, falsifier 3: the declaration of the store guarantees holds together. The same check that passes the real
 * declaration refuses each fixture below, so it is not vacuous.
 */
import { assert, describe, it } from "@effect/vitest";
import { Array as Arr, Effect, Schema } from "effect";

import {
  Guarantee,
  NonGuarantees,
  StoreGuarantees,
  problemsOf,
} from "../../src/shared/guarantees.ts";

const base: Guarantee = {
  capability: "UniqueKeys",
  carriers: [],
  id: "UK9",
  invariant: true,
  property: "At most one record per key.",
  rawWriter: "inserts a second record with the key: refused",
  strength: "store-enforced",
};

describe("StoreGuarantees (spec 0018)", () => {
  it("falsifier 3: the declaration passes its own check", () => {
    assert.deepStrictEqual(problemsOf(StoreGuarantees), []);
  });

  it.effect(
    "falsifier 3: every guarantee decodes (an id such as TX1, a closed capability and strength)",
    () =>
      Effect.gen(function* decodesEveryGuarantee() {
        const decoded = yield* Schema.decodeEffect(Schema.Array(Guarantee))(
          StoreGuarantees
        );

        assert.strictEqual(decoded.length, StoreGuarantees.length);
      })
  );

  it("falsifier 3: an id is used once across the guarantees and the promises it does not make", () => {
    const ids = [
      ...Arr.map(StoreGuarantees, ({ id }) => id),
      ...Arr.map(NonGuarantees, ({ id }) => id),
    ];

    assert.strictEqual(Arr.dedupe(ids).length, ids.length);
  });

  it("falsifier 3: the last-administrator rule is the one port-enforced invariant, and it names why", () => {
    const exceptions = Arr.filter(
      StoreGuarantees,
      ({ exception }) => exception !== undefined
    );

    assert.deepStrictEqual(
      Arr.map(exceptions, ({ id }) => id),
      ["LK7"]
    );

    assert.strictEqual(
      exceptions[0]?.exception?.reason,
      "validity depends on time"
    );

    assert.deepStrictEqual(
      Arr.map(
        Arr.filter(
          StoreGuarantees,
          ({ invariant, strength }) => invariant && strength === "port-enforced"
        ),
        ({ id }) => id
      ),
      ["LK7"]
    );
  });

  it("falsifier 3, control: a port-enforced invariant with no exception is refused", () => {
    assert.deepStrictEqual(
      problemsOf([{ ...base, strength: "port-enforced" }]),
      [
        "UK9 is an invariant and port-enforced, with no named exception (ADR 0014, answer 2)",
      ]
    );
  });

  it("falsifier 3, control: an exception on a store-enforced guarantee is refused, so no exception is spare", () => {
    assert.deepStrictEqual(
      problemsOf([
        {
          ...base,
          exception: { reason: "none", recovery: "none" },
        },
      ]),
      ["UK9 names an exception but is not a port-enforced invariant"]
    );
  });

  it("falsifier 3, control: a duplicate id and an empty raw-writer case are refused", () => {
    assert.deepStrictEqual(problemsOf([base, { ...base, rawWriter: " " }]), [
      "UK9 is declared twice",
      "UK9 has no raw-writer case",
    ]);
  });
});
