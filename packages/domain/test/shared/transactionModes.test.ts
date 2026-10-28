/**
 * Spec 0018, falsifier 2: every store-port method has a transaction mode, and the mode agrees with its type. A method
 * whose mode is `Requires` requires `InTransaction`; every other mode (but `Opens`, which `transactor.test.ts` pins)
 * does not. The declaration is exhaustive by its type (`ModesOf`); the controls below show that the check sees a
 * mismatch, over a fixture port whose methods are known.
 */
import { assert, describe, it } from "@effect/vitest";
import { Array as Arr, Order, Record as Rec } from "effect";
import type { Effect } from "effect";
import { expectTypeOf } from "vite-plus/test";

import type { Locked } from "../../src/shared/aggregate.ts";
import type { InTransaction } from "../../src/shared/transaction.ts";
import { TransactionModes } from "../../src/shared/transactionModes.ts";
import type {
  ModesOf,
  StorePorts,
  TransactionMode,
} from "../../src/shared/transactionModes.ts";

/** What a method (a function that returns an Effect, or an Effect) requires. */
type Requirement<Method> = Method extends (
  ...args: never[]
) => Effect.Effect<unknown, unknown, infer R>
  ? R
  : Method extends Effect.Effect<unknown, unknown, infer R>
    ? R
    : never;

type RequiresTransaction<Method> =
  InTransaction extends Requirement<Method> ? true : false;

type Ports<Known> = Record<keyof Known, { readonly Service: object }>;

/** `Port.method` of every row whose mode disagrees with the method's requirements. */
type Disagreements<Declared, Known extends Ports<Known>> = {
  [Port in keyof Declared & keyof Known]: {
    [
      Method in keyof Declared[Port] & keyof Known[Port]["Service"]
    ]: Declared[Port][Method] extends "Opens"
      ? never
      : (
            Declared[Port][Method] extends "Requires" ? true : false
          ) extends RequiresTransaction<Known[Port]["Service"][Method]>
        ? never
        : `${Port & string}.${Method & string}`;
  }[keyof Declared[Port] & keyof Known[Port]["Service"]];
}[keyof Declared & keyof Known];

/** Whether a method takes a lock token (the token of a person or of the admin list) among its parameters. */
type TakesToken<Method> = Method extends (
  ...args: infer Args
) => Effect.Effect<unknown, unknown, unknown>
  ? [Extract<Args[number], Locked<"Person"> | Locked<"AdminList">>] extends [
      never,
    ]
    ? false
    : true
  : false;

/** `Port.method` of every row that is not `Requires` though its method takes a lock token. */
type UnguardedTokens<Declared, Known extends Ports<Known>> = {
  [Port in keyof Declared & keyof Known]: {
    [Method in keyof Declared[Port] & keyof Known[Port]["Service"]]: TakesToken<
      Known[Port]["Service"][Method]
    > extends true
      ? Declared[Port][Method] extends "Requires"
        ? never
        : `${Port & string}.${Method & string}`
      : never;
  }[keyof Declared[Port] & keyof Known[Port]["Service"]];
}[keyof Declared & keyof Known];

interface Fixture {
  readonly Fake: {
    readonly Service: {
      readonly writes: () => Effect.Effect<void, never, InTransaction>;
      readonly reads: Effect.Effect<number>;
      readonly stands: (id: number) => Effect.Effect<void>;
      readonly locks: (token: Locked<"Person">) => Effect.Effect<void>;
    };
  };
}

describe("TransactionModes (spec 0018)", () => {
  it("falsifier 2: every method that takes a lock token is Requires", () => {
    expectTypeOf<
      UnguardedTokens<typeof TransactionModes, StorePorts>
    >().toEqualTypeOf<never>();
  });

  it("falsifier 2, control: a fixture method that takes a token and is declared Standalone is found, and one declared Requires is not", () => {
    expectTypeOf<
      UnguardedTokens<
        { readonly Fake: { readonly locks: "Standalone" } },
        Fixture
      >
    >().toEqualTypeOf<"Fake.locks">();

    expectTypeOf<
      UnguardedTokens<
        { readonly Fake: { readonly locks: "Requires" } },
        Fixture
      >
    >().toEqualTypeOf<never>();
  });

  it("falsifier 2: every row of the declaration agrees with the type of its method", () => {
    expectTypeOf<
      Disagreements<typeof TransactionModes, StorePorts>
    >().toEqualTypeOf<never>();
  });

  it("falsifier 2: the declaration is exhaustive over the ports and their methods", () => {
    expectTypeOf<typeof TransactionModes>().toExtend<ModesOf<StorePorts>>();
    expectTypeOf<keyof typeof TransactionModes>().toEqualTypeOf<
      keyof StorePorts
    >();
  });

  it("falsifier 2, control: a fixture that agrees reports nothing", () => {
    expectTypeOf<
      Disagreements<
        {
          readonly Fake: {
            readonly writes: "Requires";
            readonly reads: "Read";
            readonly stands: "Standalone";
          };
        },
        Fixture
      >
    >().toEqualTypeOf<never>();
  });

  it("falsifier 2, control: a method declared Standalone that requires the proof, and one declared Requires that does not, are both found", () => {
    expectTypeOf<
      Disagreements<
        {
          readonly Fake: {
            readonly writes: "Standalone";
            readonly reads: "Requires";
            readonly stands: "Standalone";
          };
        },
        Fixture
      >
    >().toEqualTypeOf<"Fake.writes" | "Fake.reads">();
  });

  it("falsifier 2, control: a method that the declaration does not name is a type error", () => {
    expectTypeOf<ModesOf<Fixture>["Fake"]>().toEqualTypeOf<{
      readonly writes: TransactionMode;
      readonly reads: TransactionMode;
      readonly stands: TransactionMode;
      readonly locks: TransactionMode;
    }>();
  });

  it("every mode that a row can have is used by some method", () => {
    const declared: Record<
      string,
      Record<string, TransactionMode>
    > = TransactionModes;

    const used = Arr.dedupe(
      Arr.flatMap(Rec.values(declared), (methods) => Rec.values(methods))
    );

    assert.sameMembers(Arr.sort(used, Order.String), [
      "Joins",
      "Opens",
      "Outside",
      "Read",
      "Requires",
      "Standalone",
    ]);
  });
});
