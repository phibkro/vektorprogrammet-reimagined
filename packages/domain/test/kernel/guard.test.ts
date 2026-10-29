/**
 * Spec 0007d R2: the label of a change that time makes is its guard in words, so that it cannot say something other
 * than the guard (review of #38: a label written beside a guard stayed behind when the guard changed, and nothing
 * failed). `Guard.describe` says `not` and `or` with their operands and wraps what would read both ways.
 */
import { assert, describe, it } from "@effect/vitest";
import { Array as Arr, Schema } from "effect";
import { expectTypeOf } from "vite-plus/test";

import {
  Guard,
  Machine,
  MembershipState,
  SemesterGuard,
  Teams,
} from "../../src/index.ts";

const check = SemesterGuard.semesters(Teams.MembershipMoment);

const startAhead = check.after(["term", "start"], ["current"]);
const endPassed = check.after(["current"], ["term", "end"]);
const askedForEnd = check.same(["requested"], ["term", "end"]);

describe("spec 0007d R2: Guard.describe says a check in words", () => {
  it("a comparison says its two paths", () => {
    assert.strictEqual(Guard.describe(startAhead), "term.start after current");
    assert.strictEqual(
      Guard.describe(askedForEnd),
      "requested same as term.end"
    );
  });

  it("not says its operand, and so does a not of a not", () => {
    assert.strictEqual(
      Guard.describe(check.not(startAhead)),
      "not (term.start after current)"
    );
    assert.strictEqual(
      Guard.describe(check.not(check.not(startAhead))),
      "not (not (term.start after current))"
    );
  });

  it("or says every alternative, in order", () => {
    assert.strictEqual(
      Guard.describe(check.or(endPassed, askedForEnd)),
      "current after term.end or requested same as term.end"
    );
    assert.strictEqual(
      Guard.describe(check.or(askedForEnd, endPassed, startAhead)),
      "requested same as term.end or current after term.end or term.start after current"
    );
  });

  it("a group says all of its checks", () => {
    assert.strictEqual(
      Guard.describe(Schema.makeFilterGroup([startAhead, endPassed])),
      "term.start after current and current after term.end"
    );
    assert.strictEqual(
      Guard.describe(
        Schema.makeFilterGroup([startAhead, check.not(endPassed), askedForEnd])
      ),
      "term.start after current and not (current after term.end) and requested same as term.end"
    );
  });

  it("an and inside an or, an or inside an and, and either inside a not are wrapped; an or inside an or is not", () => {
    const both = Schema.makeFilterGroup([startAhead, endPassed]);
    const either = check.or(startAhead, endPassed);

    assert.strictEqual(
      Guard.describe(check.or(both, askedForEnd)),
      "(term.start after current and current after term.end) or requested same as term.end"
    );
    assert.strictEqual(
      Guard.describe(Schema.makeFilterGroup([either, askedForEnd])),
      "(term.start after current or current after term.end) and requested same as term.end"
    );
    assert.strictEqual(
      Guard.describe(check.not(either)),
      "not (term.start after current or current after term.end)"
    );
    assert.strictEqual(
      Guard.describe(check.not(both)),
      "not (term.start after current and current after term.end)"
    );
    assert.strictEqual(
      Guard.describe(check.or(either, askedForEnd)),
      "term.start after current or current after term.end or requested same as term.end"
    );
  });

  it("a check of another kind says what it expects, or that it is a condition", () => {
    assert.strictEqual(
      Guard.describe(
        Schema.makeFilter(() => true, { expected: "the note has words" })
      ),
      "the note has words"
    );
    assert.strictEqual(
      Guard.describe(Schema.makeFilter(() => true)),
      "condition"
    );
  });
});

describe("spec 0007d R2: the label of a change that time makes is its guard in words", () => {
  it("the two changes of a membership say their guards", () => {
    assert.deepStrictEqual(
      Arr.map(Teams.MembershipMachine.calculated, ({ when }) => when),
      ["not (term.start after current)", "current after term.end"]
    );

    for (const change of Teams.MembershipMachine.calculated) {
      assert.strictEqual(change.when, Guard.describe(change.guard));
    }
  });

  it("negative control: the same change with another guard says the other guard, not the old words", () => {
    const [passed] = Teams.MembershipMachine.calculated;

    const changed = Machine.make({
      calculated: [
        {
          from: "Active",
          guard: check.same(["current"], ["term", "end"]),
          to: "Ended",
        },
      ],
      commands: Teams.TeamsRpc,
      context: Teams.MembershipMoment,
      name: "Membership",
      states: MembershipState,
      terminal: ["Ended"],
      transitions: [],
    });

    assert.strictEqual(changed.calculated[0]?.when, "current same as term.end");
    assert.notStrictEqual(changed.calculated[0]?.when, passed?.when);
  });

  it("a change of time has a guard and no label of its own to declare", () => {
    type Definition = Parameters<typeof Machine.make>[0];

    type Change = NonNullable<Definition["calculated"]>[number];

    type IsOptional<Key extends keyof Change> =
      Partial<Pick<Change, Key>> extends Pick<Change, Key> ? true : false;

    expectTypeOf<
      "guard" extends keyof Change ? true : false
    >().toEqualTypeOf<true>();
    expectTypeOf<IsOptional<"guard">>().toEqualTypeOf<false>();
    expectTypeOf<
      "when" extends keyof Change ? true : false
    >().toEqualTypeOf<false>();
  });
});

describe("spec 0022 R2: a machine's field is one that the guards' constructor built", () => {
  type Field = NonNullable<
    Parameters<typeof Machine.make>[0]["fields"]
  >[number];

  type Path = Parameters<typeof check.field>[1];

  it("a field written as a literal is refused, and one that `field` built is accepted", () => {
    expectTypeOf<{
      readonly kind: "stored";
      readonly path: readonly ["term", "start"];
    }>().not.toExtend<Field>();
    expectTypeOf<ReturnType<typeof check.field>>().toExtend<Field>();
  });

  it("control: the path that `field` takes names a semester of the context, and a typo does not", () => {
    expectTypeOf<readonly ["term", "start"]>().toExtend<Path>();
    expectTypeOf<readonly ["term", "strat"]>().not.toExtend<Path>();
  });

  it("the fields of the membership machine are the four that its guards read, with their kinds", () => {
    assert.deepStrictEqual(Teams.MembershipMachine.fields, [
      { kind: "clock", path: ["current"] },
      { kind: "parameter", path: ["requested"] },
      { kind: "stored", path: ["term", "start"] },
      { kind: "stored", path: ["term", "end"] },
    ]);
  });
});
