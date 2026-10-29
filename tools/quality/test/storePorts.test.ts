/**
 * Spec 0018, falsifier 2 (the coverage half): every service that `packages/domain/src` declares is either a store port
 * with a transaction mode for each of its methods (`TransactionModes`), or a service that is not one, with its reason
 * (`NotStorePorts`). A new service in neither fails here; a name in either list that no service has fails too, so the
 * lists cannot rot.
 */
import { assert, describe, it } from "@effect/vitest";
import { NotStorePorts, TransactionModes } from "@vektorprogrammet/domain";
import {
  Array as Arr,
  Effect,
  Order,
  Record as Rec,
  String as Str,
} from "effect";

import { domainSources } from "./support/sources.ts";

const serviceClass =
  /export class (?<name>\w+)\s+extends\s+Context\.Service</gu;

/** The names of the services that `text` declares as classes. */
export const servicesDeclared = (text: string): readonly string[] =>
  Arr.flatMap(Arr.fromIterable(Str.matchAll(serviceClass)(text)), (match) =>
    match.groups?.name === undefined ? [] : [match.groups.name]
  );

const accounted = Arr.sort(
  [...Rec.keys(TransactionModes), ...Rec.keys(NotStorePorts)],
  Order.String
);

describe("every service of the domain has a place (spec 0018)", () => {
  it("falsifier 2, control: a service class is found however its type arguments are written", () => {
    assert.deepStrictEqual(
      servicesDeclared(
        Arr.join(
          [
            'export class A extends Context.Service<A, { readonly x: 1 }>()("a") {}',
            "export class B extends Context.Service<",
            "  B,",
            "  { readonly y: 2 }",
            '>()("b") {}',
            "export class C",
            '  extends Context.Service<C, { readonly z: 3 }>()("c")',
            "  implements Marker {}",
            "export class NotAService extends Other {}",
          ],
          "\n"
        )
      ),
      ["A", "B", "C"]
    );
  });

  it("falsifier 2: no name is in both lists", () => {
    assert.deepStrictEqual(
      Arr.intersection(Rec.keys(TransactionModes), Rec.keys(NotStorePorts)),
      []
    );
  });

  it.effect(
    "falsifier 2: the services of the domain are exactly the ports of TransactionModes and the names of NotStorePorts",
    () =>
      Effect.gen(function* everyServiceHasAPlace() {
        const declared = Arr.sort(
          Arr.flatMap(yield* domainSources, ({ text }) =>
            servicesDeclared(text)
          ),
          Order.String
        );

        assert.deepStrictEqual(
          Arr.difference(declared, accounted),
          [],
          "a service in neither list"
        );

        assert.deepStrictEqual(
          Arr.difference(accounted, declared),
          [],
          "a name in a list that no service has"
        );
      })
  );
});
