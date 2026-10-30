/** Spec 0024 F5, the table's half: a code that has not been acknowledged has no way to be used. */
import { assert, describe, it } from "@effect/vitest";
import { Array as Arr, Order, Record as Rec } from "effect";

import {
  CodeMachine,
  CodeState,
  Machine,
  codePolicy,
  codeTransition,
} from "../../src/index.ts";
import type { CodeStep } from "../../src/index.ts";

/** The commands that spend a code: those that a single-use purpose names in `codePolicy`. */
const spending = [
  "activateAccount",
  "resetPassword",
  "verifyApplicantEmail",
] as const;

type Table = Pick<typeof CodeMachine, "states" | "transitions">;

const sorted = (names: readonly string[]) => Arr.sort(names, Order.String);

const isFrom = (table: Table, state: string) => (command: string) =>
  Arr.some(
    table.transitions,
    (transition) =>
      transition.command === command && Arr.contains(transition.from, state)
  );

/** The states from which some command that spends a code is available, whatever its guard says. */
const spendableFrom = (table: Table) =>
  Arr.filter(table.states, (state) => Arr.some(spending, isFrom(table, state)));

/** The states that the boundary reaches by following transitions, one step at a time. */
const reachableFrom = (
  table: Table,
  frontier: readonly string[],
  seen: readonly string[]
): readonly string[] => {
  const next = Arr.filter(
    Arr.dedupe(
      Arr.flatMap(table.transitions, (transition) =>
        Arr.some(frontier, (from) => Arr.contains(transition.from, from))
          ? [transition.to]
          : []
      )
    ),
    (state) => !Arr.contains(seen, state)
  );

  return Arr.isReadonlyArrayEmpty(next)
    ? seen
    : reachableFrom(table, next, [...seen, ...next]);
};

describe("spec 0024 F5: the Code machine", () => {
  it("only a Usable code can be spent, and an Unsent or a Used one has no transition to a use", () => {
    assert.deepStrictEqual(spendableFrom(CodeMachine), ["Usable"]);

    for (const command of spending) {
      assert.isTrue(isFrom(CodeMachine, "Usable")(command));

      for (const state of ["Unsent", "Used", Machine.Boundary]) {
        assert.isFalse(isFrom(CodeMachine, state)(command), state);
      }
    }
  });

  it("negative control: a table that lets an Unsent code be spent is found by the same check", () => {
    const mutant = {
      states: CodeMachine.states,
      transitions: [
        ...CodeMachine.transitions,
        { command: "activateAccount", from: ["Unsent"], to: "Used" } as const,
      ],
    };

    assert.deepStrictEqual(spendableFrom(mutant), ["Unsent", "Usable"]);
  });

  it("an acknowledgement is the only way out of Unsent, and it goes to Usable", () => {
    const out = Arr.filter(CodeMachine.transitions, (transition) =>
      Arr.contains(transition.from, "Unsent")
    );

    assert.deepStrictEqual(
      Arr.map(out, (transition) => [transition.command, transition.to]),
      [["acknowledgeCode", "Usable"]]
    );

    assert.strictEqual(codeTransition("acknowledgeCode").to, "Usable");
  });

  it("a code is created Unsent, every state is reachable, and Used is the one terminal state that nothing leaves", () => {
    assert.deepStrictEqual(
      Arr.map(
        Arr.filter(CodeMachine.transitions, (transition) =>
          Arr.contains(transition.from, Machine.Boundary)
        ),
        (transition) => transition.to
      ),
      ["Unsent"]
    );

    const reached = Arr.filter(
      reachableFrom(CodeMachine, [Machine.Boundary], [Machine.Boundary]),
      (state) => state !== Machine.Boundary
    );

    assert.deepStrictEqual(sorted(reached), sorted(CodeMachine.states));
    assert.deepStrictEqual(CodeMachine.terminal, ["Used"]);

    for (const terminal of CodeMachine.terminal) {
      assert.isFalse(
        Arr.some(CodeMachine.transitions, (transition) =>
          Arr.contains(transition.from, terminal)
        )
      );
    }

    for (const state of Arr.difference(
      CodeMachine.states,
      CodeMachine.terminal
    )) {
      assert.isTrue(
        Arr.some(CodeMachine.transitions, (transition) =>
          Arr.contains(transition.from, state)
        ),
        `${state} has a way out`
      );
    }
  });

  it("the table, the stored states and the policy agree: the states are the schema's, and each spending command is a single-use purpose's", () => {
    assert.deepStrictEqual(
      sorted(CodeMachine.states),
      sorted(Rec.keys(CodeState.cases))
    );

    const steps: readonly CodeStep[] = ["acknowledgeCode", ...spending];

    for (const step of steps) {
      assert.strictEqual(codeTransition(step).command, step);
    }

    const singleUse = Arr.flatMap(Rec.values(codePolicy), (policy) =>
      policy.singleUse ? [policy.command] : []
    );

    assert.deepStrictEqual(sorted(singleUse), sorted(spending));
  });
});
