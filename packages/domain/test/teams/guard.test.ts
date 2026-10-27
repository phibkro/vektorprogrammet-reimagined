/** Serializable checks are the transition guards: a revived schema must make the same decision as the original. */
import { assert, describe, it } from "@effect/vitest";
import {
  Arbitrary,
  Array as Arr,
  Effect,
  Predicate,
  Schema,
  SchemaRepresentation,
} from "effect";
import { expectTypeOf } from "vite-plus/test";

import { Guard, Machine, MembershipState, Teams } from "../../src/index.ts";
import type { MembershipMoment } from "../../src/teams/declaration.ts";
import { host, vaar } from "../support/calendar.ts";

const { MembershipMachine, MembershipMoment: ContextSchema } = Teams;

const moment = {
  current: host(2026),
  requested: host(2027),
  term: { end: vaar(2027), start: vaar(2026) },
};

const comparisons = Guard.semesters(ContextSchema);

/** Encode the schema as JSON, decode it again, and revive every check using its registered Effect reviver. */
const revived = (json: Schema.Json) =>
  Schema.is(
    SchemaRepresentation.fromRepresentation(
      SchemaRepresentation.fromJson(json),
      {
        revivers: Guard.revivers,
      }
    )
  );

describe("spec 0006 R4: native checks are declaration data", () => {
  it.effect(
    "every membership guard round-trips through Schema JSON for generated contexts",
    () =>
      Effect.gen(function* roundTrip() {
        const guarded = Arr.filter(
          MembershipMachine.transitions,
          (row) => row.guard !== undefined
        );

        assert.strictEqual(guarded.length, 7);

        for (const transition of guarded) {
          if (
            transition.guard === undefined ||
            transition.guardRepresentation === undefined
          ) {
            assert.fail(
              `${transition.command} must carry its check and JSON representation`
            );
          }

          const original = Schema.is(ContextSchema.check(transition.guard));
          const restored = revived(transition.guardRepresentation);

          const result = yield* Arbitrary.checkEffect(
            Arbitrary.schema(ContextSchema),
            (input) => original(input) === restored(input),
            { runs: 300 }
          );

          assert.isTrue(
            Predicate.isTagged(result, "Passed"),
            `${transition.command}: ${Arbitrary.formatCheckFailure(result) ?? ""}`
          );
        }
      })
  );

  it("the logical or reviver keeps both alternatives", () => {
    const either = comparisons.or(
      comparisons.same(["current"], ["requested"]),
      comparisons.after(["requested"], ["term", "end"])
    );

    const schema = ContextSchema.check(either);
    const original = Schema.is(schema);

    const restored = revived(
      SchemaRepresentation.toJson(
        SchemaRepresentation.toRepresentation(schema.ast)
      )
    );

    for (const input of [
      moment,
      { ...moment, requested: moment.current },
      { ...moment, requested: moment.term.start },
    ]) {
      assert.strictEqual(restored(input), original(input));
    }

    assert.isTrue(restored(moment));
    assert.isTrue(restored({ ...moment, requested: moment.current }));
    assert.isFalse(restored({ ...moment, requested: moment.term.start }));
  });

  it("negative control: replacing extendMembership's after check with same makes the term assertion fail", () => {
    const mutant = Machine.make({
      commands: Teams.TeamsRpc,
      context: ContextSchema,
      name: "Membership",
      states: MembershipState,
      terminal: MembershipMachine.terminal,
      transitions: Arr.map(MembershipMachine.transitions, (transition) =>
        transition.command === "extendMembership"
          ? {
              ...transition,
              guard: comparisons.same(["requested"], ["term", "end"]),
            }
          : transition
      ),
    });

    const extendsToLater = (machine: typeof MembershipMachine) => {
      assert.isTrue(Machine.can(machine, "extendMembership", "Active", moment));
    };

    extendsToLater(MembershipMachine);
    assert.throws(() => {
      extendsToLater(mutant);
    });
    assert.isFalse(Machine.can(mutant, "extendMembership", "Active", moment));
  });

  it("semester operand paths name existing semester fields of this context", () => {
    type Accepted<Path> =
      Path extends Guard.SemesterPath<MembershipMoment> ? true : false;

    expectTypeOf<Accepted<readonly ["current"]>>().toEqualTypeOf<true>();
    expectTypeOf<Accepted<readonly ["term", "end"]>>().toEqualTypeOf<true>();
    expectTypeOf<Accepted<readonly ["term", "typo"]>>().toEqualTypeOf<false>();
    expectTypeOf<
      Accepted<readonly ["requested", "year"]>
    >().toEqualTypeOf<false>();
  });
});
