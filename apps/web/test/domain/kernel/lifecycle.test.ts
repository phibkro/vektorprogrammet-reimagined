import { assert, describe, it } from "@effect/vitest";
import { Array as Arr, Option, Order } from "effect";
import { expectTypeOf } from "vite-plus/test";

import { Declarations } from "../../../src/core/declarations.ts";
import * as Domain from "../../../src/core/kernel/domain.ts";
import * as Effx from "../../../src/core/kernel/effx.ts";
import * as Machine from "../../../src/core/kernel/machine.ts";
import { AccountMachine } from "../../../src/features/accounts/domain/declaration.ts";
import { ApplicantPerson } from "../../../src/features/admission/domain/declaration.ts";
import * as Privacy from "../../../src/features/personal-data/domain/rpc.ts";
import {
  PersonMachine,
  TeamsDomain,
  TeamMachine,
  TeamPresence,
  acceptsPresence,
} from "../../../src/features/teams/domain/declaration.ts";
import {
  personState,
  teamState,
} from "../../../src/features/teams/domain/lifecycle.ts";

const moments = { blockingHold: false, lastActiveAdmin: false };

const merge = {
  distinct: true,
  sourceIdentifiable: true,
  targetIdentifiable: true,
};

const privacyWith = (contributions: readonly Machine.Contribution[]) =>
  Arr.map(Declarations, (entry) =>
    entry.name === "personalData" ? { ...entry, contributions } : entry
  );

/** Fails if any creating or ending cause silently disappears, including an implicit verification merge. */
const causes = (domains: readonly Domain.Declaration[]) =>
  Arr.flatMap(Domain.incoming(PersonMachine, domains), ({ contribution }) =>
    Arr.map(contribution.transitions, ({ command }) => command)
  );

describe("spec 0032: declared lifecycles", () => {
  it("F1/F2: every account state ends on erasure, but neither a blocking hold nor the last admin passes", () => {
    for (const state of AccountMachine.states) {
      assert.deepStrictEqual(
        Machine.next(Privacy.AccountErasure, "erasePerson", state, moments),
        Option.some(Machine.Boundary)
      );
      assert.isFalse(
        Machine.can(Privacy.AccountErasure, "erasePerson", state, {
          ...moments,
          lastActiveAdmin: true,
        })
      );
      assert.isFalse(
        Machine.can(Privacy.AccountErasure, "erasePerson", state, {
          ...moments,
          blockingHold: true,
        })
      );
    }

    // Negative control: removing the incoming end changes the resolved reference, not the local command group.
    const stripped = privacyWith(
      Arr.filter(
        Privacy.PersonalDataDomain.contributions,
        (entry) => entry !== Privacy.AccountErasure
      )
    );

    assert.throws(() => {
      assert.deepStrictEqual(
        Domain.incoming(AccountMachine, stripped),
        Domain.incoming(AccountMachine, Declarations)
      );
    });
    expectTypeOf<"erasePerson">().not.toExtend<
      (typeof AccountMachine.transitions)[number]["command"]
    >();
  });

  it("F3: merged wins over anonymised; both terminal projections stay distinct", () => {
    assert.strictEqual(
      personState({ anonymised: false, merged: false })._tag,
      "Identifiable"
    );
    assert.strictEqual(
      personState({ anonymised: true, merged: false })._tag,
      "Anonymised"
    );
    assert.strictEqual(
      personState({ anonymised: true, merged: true })._tag,
      "Merged"
    );
    assert.notStrictEqual(
      personState({ anonymised: true, merged: false })._tag,
      "Merged"
    );
    assert.deepStrictEqual(Arr.sort(causes(Declarations), Order.String), [
      "erasePerson",
      "mergePersons",
      "registerApplication",
      "runRetention",
      "submitApplication",
      "verifyApplicantEmail",
    ]);

    for (const contribution of Arr.filter(
      [...Privacy.PersonalDataDomain.contributions, ApplicantPerson],
      (entry) => entry.target === PersonMachine
    )) {
      for (const transition of contribution.transitions) {
        const reduced = Arr.map(Declarations, (domain) => ({
          ...domain,
          contributions: Arr.map(domain.contributions, (entry) =>
            entry === contribution
              ? {
                  ...entry,
                  transitions: Arr.filter(
                    entry.transitions,
                    (edge) => edge !== transition
                  ),
                }
              : entry
          ),
        }));

        assert.lengthOf(
          causes(reduced),
          causes(Declarations).length - 1,
          transition.command
        );
        assert.throws(() => {
          assert.deepStrictEqual(causes(reduced), causes(Declarations));
        });
      }
    }

    assert.isFalse(
      Machine.can(Privacy.PersonRetention, "runRetention", "Identifiable", {
        applying: false,
        coreDue: true,
      })
    );
    assert.isFalse(
      Machine.can(Privacy.PersonRetention, "runRetention", "Identifiable", {
        applying: true,
        coreDue: false,
      })
    );
    assert.isTrue(
      Machine.can(Privacy.PersonRetention, "runRetention", "Identifiable", {
        applying: true,
        coreDue: true,
      })
    );
  });

  it("F4: merge transfers an account without deleting its state; only identifiable distinct records may merge", () => {
    for (const state of AccountMachine.states) {
      assert.deepStrictEqual(
        Machine.next(Privacy.AccountMerge, "mergePersons", state, merge),
        Option.some(state)
      );
    }

    for (const bad of [
      { ...merge, distinct: false },
      { ...merge, sourceIdentifiable: false },
      { ...merge, targetIdentifiable: false },
    ]) {
      assert.isFalse(
        Machine.can(Privacy.PersonMerge, "mergePersons", "Identifiable", bad)
      );
    }

    assert.isFalse(
      Machine.can(
        Privacy.PersonMerge,
        "verifyApplicantEmail",
        "Identifiable",
        merge
      )
    );
    assert.isTrue(
      Machine.can(Privacy.PersonMerge, "verifyApplicantEmail", "Identifiable", {
        ...merge,
        verifiedHolder: true,
      })
    );

    assert.isFalse(
      Machine.can(Privacy.PersonMerge, "mergePersons", "Anonymised", merge)
    );
    assert.isFalse(
      Machine.can(Privacy.PersonMerge, "mergePersons", "Merged", merge)
    );
  });

  it("F6: Team deactivation never reactivates; admission uses the stored fact without changing membership state", () => {
    assert.strictEqual(teamState({ active: true })._tag, "Active");
    assert.strictEqual(teamState({ active: false })._tag, "Inactive");

    for (const { command } of TeamPresence.transitions) {
      assert.isTrue(acceptsPresence({ active: true }, command));
      assert.isFalse(acceptsPresence({ active: false }, command));
    }

    assert.deepStrictEqual(
      Machine.next(TeamMachine, "deactivateTeam", "Active", {}),
      Option.some("Inactive")
    );
    assert.isFalse(
      Arr.some(
        TeamMachine.transitions,
        (edge) => edge.to === "Active" && Arr.contains(edge.from, "Inactive")
      )
    );
  });

  it("F7: real declarations resolve; malformed foreign references and terminal exits are refused", () => {
    assert.deepStrictEqual(Domain.allProblems(Declarations), []);

    const invalid = [
      { ...Privacy.PersonErasure, target: { ...PersonMachine } },
      {
        ...Privacy.PersonErasure,
        transitions: [
          { command: "missing", from: ["Identifiable"], to: "Anonymised" },
        ],
      },
      {
        ...Privacy.PersonErasure,
        transitions: [
          { command: "erasePerson", from: ["Merged"], to: "Identifiable" },
        ],
      },
      {
        ...Privacy.PersonErasure,
        transitions: [
          { command: "erasePerson", from: ["Identifiable"], to: "Missing" },
        ],
      },
      {
        ...Privacy.PersonErasure,
        transitions: [
          ...Privacy.PersonErasure.transitions,
          ...Privacy.PersonErasure.transitions,
        ],
      },
    ];

    for (const mutation of invalid) {
      assert.isNotEmpty(Domain.allProblems(privacyWith([mutation])));
    }

    const duplicate = Arr.map(Declarations, (entry) =>
      entry.name === "teams"
        ? { ...entry, contributions: [TeamPresence, TeamPresence] }
        : entry
    );

    assert.isNotEmpty(Domain.allProblems(duplicate));

    const changingRequirement = {
      ...TeamPresence,
      transitions: [
        { command: "extendMembership", from: ["Active"], to: "Inactive" },
      ],
    };

    const invalidRequirement = Arr.map(Declarations, (entry) =>
      entry.name === "teams"
        ? { ...entry, contributions: [changingRequirement] }
        : entry
    );

    assert.isNotEmpty(Domain.allProblems(invalidRequirement));

    expectTypeOf<"Missing">().not.toExtend<
      (typeof Privacy.PersonErasure.transitions)[number]["to"]
    >();
  });

  it("F8: unsupported contributions are explicit gaps and whole-machine omissions, never silent partial machines", () => {
    const described = Effx.describe(TeamsDomain, Declarations);
    assert.isTrue(Arr.some(described.gaps, Effx.Gap.guards.StateRequirement));
    assert.isTrue(Option.isSome(described.description));

    if (Option.isSome(described.description)) {
      assert.isFalse(
        Arr.some(
          described.description.value.machines,
          (entry) => entry.name === "Person"
        )
      );
    }

    assert.isTrue(
      Arr.some(
        described.gaps,
        (gap) =>
          Effx.Gap.guards.CrossDomainTransition(gap) &&
          gap.command === "verifyApplicantEmail"
      )
    );
    assert.isTrue(
      Arr.some(
        described.gaps,
        (gap) => Effx.Gap.guards.MachineDropped(gap) && gap.machine === "Person"
      )
    );
    assert.throws(() => {
      assert.deepStrictEqual(
        Effx.describe(TeamsDomain, privacyWith([])).gaps,
        described.gaps
      );
    });

    for (const kind of [
      "CrossDomainTransition",
      "IdentityTransfer",
      "MachineDropped",
    ] as const) {
      assert.isNotEmpty(Effx.closures[kind]);
    }
  });
});
