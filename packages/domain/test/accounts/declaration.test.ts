/** Spec 0007 falsifiers 2, 4 and 6: represented Account guards and code-only authority. */
import { assert, describe, it } from "@effect/vitest";
import {
  Arbitrary,
  Array as Arr,
  DateTime,
  Effect,
  Predicate,
  Schema,
  SchemaRepresentation,
} from "effect";

import {
  AccountState,
  Accounts,
  Declarations,
  Domain,
  Machine,
  PersonId,
  Principal,
  authorize,
} from "../../src/index.ts";

const personId = PersonId.make(1);
const otherId = PersonId.make(2);

const admin = Principal.cases.Person.make({
  adminUntil: DateTime.makeUnsafe("2100-01-01T00:00:00Z"),
  memberships: [],
  personId,
});

const context = {
  actorId: otherId,
  lastActiveAdmin: false,
  personId,
};

describe("spec 0007: Account declarations", () => {
  it("every account command has a grant and each transition belongs to its command group", () => {
    assert.include(Declarations, Accounts.AccountDomain);
    assert.deepStrictEqual(Domain.problems(Accounts.AccountDomain), []);
  });

  it.effect(
    "the Account guards round-trip through SchemaRepresentation for generated contexts",
    () =>
      Effect.gen(function* roundTrip() {
        const guarded = Arr.filter(
          Accounts.AccountMachine.transitions,
          (transition) => transition.guard !== undefined
        );

        assert.strictEqual(guarded.length, 2);

        for (const transition of guarded) {
          if (
            transition.guard === undefined ||
            transition.guardRepresentation === undefined
          ) {
            assert.fail(`${transition.command} has no represented guard`);
          }

          const original = Schema.is(
            Accounts.AccountTransition.check(transition.guard)
          );

          const revived = Schema.is(
            SchemaRepresentation.fromRepresentation(
              SchemaRepresentation.fromJson(transition.guardRepresentation),
              { revivers: Accounts.accountGuardRevivers }
            )
          );

          const result = yield* Arbitrary.checkEffect(
            Arbitrary.schema(Accounts.AccountTransition),
            (value) => original(value) === revived(value),
            { runs: 300 }
          );

          assert.isTrue(
            Predicate.isTagged(result, "Passed"),
            Arbitrary.formatCheckFailure(result) ?? transition.command
          );
        }
      })
  );

  it("RULE-202, 299: neither one's own account nor the last active admin can be deactivated", () => {
    assert.isTrue(
      Machine.can(
        Accounts.AccountMachine,
        "deactivateAccount",
        "Active",
        context
      )
    );
    assert.isFalse(
      Machine.can(Accounts.AccountMachine, "deactivateAccount", "Active", {
        ...context,
        actorId: personId,
      })
    );
    assert.isFalse(
      Machine.can(Accounts.AccountMachine, "deactivateAccount", "Active", {
        ...context,
        lastActiveAdmin: true,
      })
    );
    assert.isFalse(
      Machine.can(Accounts.AccountMachine, "reactivateAccount", "Deactivated", {
        ...context,
        actorId: personId,
      })
    );
  });

  it("negative control: removing the deactivation guard admits the last active admin", () => {
    const mutant = Machine.make({
      commands: Accounts.AccountRpc,
      context: Accounts.AccountTransition,
      name: "Account",
      states: AccountState,
      terminal: Accounts.AccountMachine.terminal,
      transitions: Arr.map(Accounts.AccountMachine.transitions, (transition) =>
        transition.command === "deactivateAccount"
          ? {
              command: transition.command,
              from: transition.from,
              to: transition.to,
            }
          : transition
      ),
    });

    const last = { ...context, lastActiveAdmin: true };
    assert.isFalse(
      Machine.can(Accounts.AccountMachine, "deactivateAccount", "Active", last)
    );
    assert.isTrue(Machine.can(mutant, "deactivateAccount", "Active", last));
  });

  it("RULE-131, 201: an admin holding an activation code is confined to activateAccount and its person", () => {
    const codePrincipal = Principal.narrow(admin, {
      command: "activateAccount",
      resource: { personId },
    });

    assert.isTrue(authorize(codePrincipal, "activateAccount", { personId }));
    assert.isFalse(
      authorize(codePrincipal, "activateAccount", { personId: otherId })
    );
    assert.isFalse(authorize(codePrincipal, "resetPassword", { personId }));
    assert.isFalse(authorize(codePrincipal, "deactivateAccount", { personId }));
    assert.isFalse(authorize(admin, "activateAccount", { personId }));

    const narrowedAgain = Principal.narrow(codePrincipal, {
      command: "deactivateAccount",
      resource: { personId },
    });

    assert.isFalse(authorize(narrowedAgain, "activateAccount", { personId }));
    assert.isFalse(authorize(narrowedAgain, "deactivateAccount", { personId }));
  });
});
