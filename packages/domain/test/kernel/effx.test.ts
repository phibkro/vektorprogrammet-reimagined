/**
 * Spec 0007d: the export of the kernel's declarations to effx's `DomainDescription`. The conformance of `authorize`
 * and the machine tables to effx's vectors is `tools/effx-conformance`; here is the pure function between the two:
 * each field's source, each gap, and a negative control that changes one declaration and shows what moves.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  Array as Arr,
  Option,
  Order,
  Predicate,
  Record as Rec,
  Schema,
} from "effect";
import { expectTypeOf } from "vite-plus/test";

import {
  Accounts,
  Contact,
  Declarations,
  Domain,
  Effx,
  Grant,
  Guard,
  Machine,
  MembershipState,
  Subject,
  SystemJob,
  Teams,
} from "../../src/index.ts";
import type { Declaration } from "../../src/kernel/domain.ts";
import { Sample } from "./sample.ts";

const Group = Schema.TaggedStruct("FilterGroup", {
  checks: Schema.Array(Schema.Json),
});

const Filter = Schema.TaggedStruct("Filter", {
  representation: Schema.Struct({ id: Schema.String, payload: Schema.Json }),
});

const after = (left: readonly string[], right: readonly string[]) => ({
  id: "effx/order/after",
  payload: { left, right },
});

/** What a test needs to hold; a missing value fails the test with its name. */
const must = <A>(option: Option.Option<A>, what: string): A =>
  Option.match(option, {
    onNone: () => assert.fail(`${what} is missing`),
    onSome: (value) => value,
  });

const exported = (declaration: Declaration) =>
  must(
    Effx.describe(declaration).description,
    `the description of ${declaration.name}`
  );

/** The gaps of one kind that a domain's export lists: `guard` is the union's own guard of the kind. */
const gapsOf = <Narrowed extends Effx.Gap>(
  declaration: Declaration,
  guard: (gap: unknown) => gap is Narrowed
): readonly Narrowed[] =>
  Arr.filter(Effx.describe(declaration).gaps, (gap): gap is Narrowed =>
    guard(gap)
  );

const expressionOf = (declaration: Declaration, name: string) =>
  Arr.findFirst(
    exported(declaration).subjectSets,
    (found) => found.name === name
  ).pipe(Option.map(({ expression }) => expression));

describe("spec 0007d falsifier 1: the description is derived from the declarations", () => {
  it("every domain is exported but `contact`, whose only subject is Anyone", () => {
    const without = Arr.filter(Declarations, (declaration) =>
      Option.isNone(Effx.describe(declaration).description)
    );

    assert.deepStrictEqual(
      Arr.map(without, ({ name }) => name),
      ["contact"]
    );
  });

  it("teams: its commands, reads, job, jobs, admin list, clock, order and membership binding come from its declarations", () => {
    const description = exported(Teams.TeamsDomain);

    assert.deepStrictEqual(
      Arr.map(description.commands, ({ name }) => name),
      Arr.map(Teams.TeamsDomain.commands, (rpc) => rpc._tag)
    );
    assert.deepStrictEqual(
      Arr.map(description.reads, ({ name }) => name),
      ["viewPeople", "viewTeams"]
    );
    assert.deepStrictEqual(
      Arr.filter(description.commands, ({ runBy }) => runBy !== undefined),
      [
        {
          kind: "Command",
          name: "sendEndingSoon",
          runBy: { job: "endingSoon" },
        },
      ]
    );
    assert.deepStrictEqual(
      description.principals.System.jobs,
      SystemJob.literals
    );
    assert.deepStrictEqual(description.adminList, {
      grant: "createAdminGrant",
      revoke: "deleteAdminGrant",
    });
    assert.deepStrictEqual(description.clock, { order: "Semester" });
    assert.deepStrictEqual(description.orders, [{ name: "Semester" }]);
    assert.deepStrictEqual(description.memberships, {
      grantingStates: ["Active"],
      machine: "Membership",
    });
  });

  it("a subject follows its scope: a department scope asks for a membership in the department of the target, `all` anywhere", () => {
    const { Expression } = Effx;

    assert.deepStrictEqual(
      expressionOf(Sample, "Leader(d)@department"),
      Option.some(
        Expression.cases.Membership.make({
          department: "target",
          position: "leader",
          term: "active",
        })
      )
    );
    assert.deepStrictEqual(
      expressionOf(Sample, "Board@department"),
      Option.some(
        Expression.cases.Membership.make({
          department: "target",
          function: "board",
          term: "active",
        })
      )
    );
    assert.deepStrictEqual(
      expressionOf(Sample, "Self@own"),
      Option.some(Expression.cases.Self.make({}))
    );
    assert.deepStrictEqual(
      expressionOf(Sample, "System(semesters)@all"),
      Option.some(Expression.cases.System.make({ job: "semesters" }))
    );
    assert.deepStrictEqual(
      expressionOf(Sample, "Admin@all"),
      Option.some(Expression.cases.Admin.make({}))
    );

    const everywhere: Declaration = {
      ...Sample,
      table: [
        ...Sample.table,
        Grant.make([Subject.member], ["viewNotes"], "all"),
      ],
    };

    assert.deepStrictEqual(
      expressionOf(everywhere, "Member(d)@all"),
      Option.some(
        Expression.cases.Membership.make({ department: "any", term: "active" })
      )
    );
  });

  it("a row of several subjects is one grant over a Union of their sets", () => {
    const grant = must(
      Arr.findFirst(exported(Sample).grants, ({ permits }) =>
        permits.includes("createArticle")
      ),
      "the grant of createArticle"
    );

    assert.strictEqual(grant.subject, "Leader(d) + Board@department");
    assert.deepStrictEqual(
      expressionOf(Sample, grant.subject),
      Option.some(
        Effx.Expression.cases.Union.make({
          sets: ["Leader(d)@department", "Board@department"],
        })
      )
    );
  });

  it("negative control: one grant row less is one grant and its subject set less, and nothing else moves", () => {
    const fewer: Declaration = {
      ...Teams.TeamsDomain,
      table: Arr.filter(
        Teams.TeamsDomain.table,
        (row) =>
          !(
            Arr.contains(row.commands, "viewTeams") &&
            row.scope === "department" &&
            Arr.some(row.subjects, Predicate.isTagged("Member"))
          )
      ),
    };

    const before = exported(Teams.TeamsDomain);
    const afterwards = exported(fewer);

    assert.deepStrictEqual(
      afterwards.grants,
      Arr.filter(
        before.grants,
        ({ subject }) => subject !== "Member(d)@department"
      )
    );
    assert.deepStrictEqual(
      afterwards.subjectSets,
      Arr.filter(
        before.subjectSets,
        ({ name }) => name !== "Member(d)@department"
      )
    );
    assert.deepStrictEqual(afterwards.machines, before.machines);
    assert.deepStrictEqual(afterwards.commands, before.commands);
  });
});

describe("spec 0007d falsifier 4: what effx cannot state is a typed gap, never a silent drop", () => {
  it("the accounts domain loses `activateAccount`, `resetPassword` and `requestPasswordReset` with the subjects that took them away", () => {
    assert.deepStrictEqual(
      Arr.map(
        gapsOf(Accounts.AccountDomain, Effx.Gap.guards.UnexpressibleSubject),
        (gap) => [gap.subject, ...gap.commands]
      ),
      [
        ["Holder(activation)", "activateAccount"],
        ["Holder(resetPassword)", "resetPassword"],
        ["Anyone", "requestPasswordReset"],
      ]
    );
    assert.deepStrictEqual(
      Arr.map(exported(Accounts.AccountDomain).commands, ({ name }) => name),
      [
        "createAccount",
        "deactivateAccount",
        "reactivateAccount",
        "updatePerson",
      ]
    );
  });

  it("the Account machine is dropped whole: its guards compare ids and a flag, and one of its commands is gone", () => {
    assert.deepStrictEqual(exported(Accounts.AccountDomain).machines, []);
    assert.deepStrictEqual(
      Arr.map(
        gapsOf(Accounts.AccountDomain, Effx.Gap.guards.UnexpressibleGuard),
        (gap) => [gap.transition, gap.id]
      ),
      [
        ["deactivateAccount", "vektorprogrammet/account/different-person"],
        ["deactivateAccount", "vektorprogrammet/account/not-last-active-admin"],
        ["reactivateAccount", "vektorprogrammet/account/different-person"],
      ]
    );
    assert.lengthOf(
      gapsOf(Accounts.AccountDomain, Effx.Gap.guards.MachineDropped),
      2
    );
  });

  it("a domain whose every command needs a subject that effx cannot state has no description", () => {
    const described = Effx.describe(Contact.ContactDomain);

    assert.isTrue(Option.isNone(described.description));
    assert.deepStrictEqual(
      Arr.map(described.gaps, ({ _tag }) => _tag),
      ["UnexpressibleSubject", "NoDescription"]
    );
  });

  it("a guard check outside the closed vocabulary drops its machine and names the check", () => {
    assert.deepStrictEqual(
      Arr.map(
        gapsOf(Sample, Effx.Gap.guards.UnexpressibleGuard),
        ({ id }) => id
      ),
      ["test/note/hasWords"]
    );
    assert.lengthOf(gapsOf(Sample, Effx.Gap.guards.MachineDropped), 1);
  });

  it("the writes of the Membership machine are undeclared, and the admin list's expiry is a gap", () => {
    assert.deepStrictEqual(
      Arr.map(
        gapsOf(Teams.TeamsDomain, Effx.Gap.guards.UndeclaredWrites),
        ({ commands }) => commands
      ),
      [
        [
          "createMembership",
          "extendMembership",
          "changeMembership",
          "endEarlyMembership",
          "deleteMembership",
        ],
      ]
    );
    assert.lengthOf(gapsOf(Teams.TeamsDomain, Effx.Gap.guards.AdminExpiry), 1);
  });

  it("only a subject that effx cannot state takes a command out of its description: the commands that the other gaps name stay", () => {
    const teams = Arr.map(
      exported(Teams.TeamsDomain).commands,
      ({ name }) => name
    );

    const accounts = Arr.map(
      exported(Accounts.AccountDomain).commands,
      ({ name }) => name
    );

    assert.includeMembers(teams, [
      "createMembership",
      "extendMembership",
      "changeMembership",
      "endEarlyMembership",
      "deleteMembership",
    ]);
    assert.includeMembers(accounts, ["deactivateAccount", "reactivateAccount"]);

    for (const gap of gapsOf(
      Accounts.AccountDomain,
      Effx.Gap.guards.UnexpressibleSubject
    )) {
      for (const command of gap.commands) {
        assert.notInclude(accounts, command);
      }
    }
  });

  it("the changes that time makes are exported with their guards: a start that has arrived, an end that has passed", () => {
    const [membership] = exported(Teams.TeamsDomain).machines;

    assert.deepStrictEqual(membership?.context.clockPath, ["current"]);
    assert.deepStrictEqual(
      Arr.map(membership?.calculated ?? [], ({ from, to, when }) => [
        from,
        to,
        when,
      ]),
      [
        [
          "Planned",
          "Active",
          {
            context: "MembershipContext",
            representation: {
              id: "effx/guard/not",
              payload: after(["term", "start"], ["current"]),
            },
          },
        ],
        [
          "Active",
          "Ended",
          {
            context: "MembershipContext",
            representation: after(["current"], ["term", "end"]),
          },
        ],
      ]
    );
  });

  it("negative control: a change of time whose guard is outside the vocabulary drops the machine and names the change", () => {
    const unreadable: Declaration = {
      ...Teams.TeamsDomain,
      machines: [
        {
          ...Teams.MembershipMachine,
          calculated: Arr.map(
            Teams.MembershipMachine.calculated,
            (change, index) =>
              index === 0
                ? {
                    ...change,
                    guardRepresentation: {
                      representation: {
                        checks: [
                          Filter.make({
                            representation: {
                              id: "test/note/hasWords",
                              payload: null,
                            },
                          }),
                        ],
                      },
                    },
                  }
                : change
          ),
        },
      ],
    };

    assert.deepStrictEqual(
      Arr.map(
        gapsOf(unreadable, Effx.Gap.guards.UnexpressibleGuard),
        ({ id, transition }) => [transition, id]
      ),
      [["Planned → Active", "test/note/hasWords"]]
    );
    assert.deepStrictEqual(exported(unreadable).machines, []);
    assert.lengthOf(gapsOf(unreadable, Effx.Gap.guards.MachineDropped), 1);
  });

  it("negative control: a guard that reads a semester the machine does not declare is a MissingDeclaration, and the machine is dropped", () => {
    const undeclared: Declaration = {
      ...Teams.TeamsDomain,
      machines: [{ ...Teams.MembershipMachine, fields: [] }],
    };

    assert.lengthOf(gapsOf(undeclared, Effx.Gap.guards.MissingDeclaration), 1);
    assert.deepStrictEqual(exported(undeclared).machines, []);
    assert.isUndefined(exported(undeclared).memberships);
  });

  it("negative control: a domain with a grant command but no revoke has an unclear admin list", () => {
    const halfAList: Declaration = {
      ...Teams.TeamsDomain,
      commands: Arr.filter(
        Teams.TeamsDomain.commands,
        (rpc) => !Predicate.isTagged(rpc, "deleteAdminGrant")
      ),
    };

    assert.deepStrictEqual(
      Arr.map(
        gapsOf(halfAList, Effx.Gap.guards.AdminListUnclear),
        ({ grants, revokes }) => [grants, revokes]
      ),
      [[["createAdminGrant"], []]]
    );
    assert.isUndefined(exported(halfAList).adminList);
  });

  it("the roots of the kernel are a gap of the whole kernel, not of a domain", () => {
    assert.deepStrictEqual(
      Arr.flatMap(Effx.kernelGaps, (gap) =>
        Predicate.isTagged(gap, "NoField") ? [gap.values] : []
      ),
      [["AdminList", "Person"]]
    );
  });

  it("every kind of gap says what closes it, and a closure by effx names the issue or the spec that tracks it", () => {
    assert.deepStrictEqual(
      Arr.sort(Rec.keys(Effx.closures), Order.String),
      Arr.sort(Rec.keys(Effx.Gap.cases), Order.String)
    );

    for (const [kind, steps] of Rec.toEntries(Effx.closures)) {
      assert.isAbove(steps.length, 0, kind);

      for (const step of steps) {
        assert.isAbove(step.change.length, 0, kind);

        if (step.by === "effx") {
          assert.match(step.change, /effx (?:issue|spec) \d+/u, kind);
        }
      }
    }
  });

  it("a dropped machine is closed by whoever closes each of its reasons, and the kernel closes one of the three", () => {
    const withoutFields: Declaration = {
      ...Teams.TeamsDomain,
      machines: [{ ...Teams.MembershipMachine, fields: [] }],
    };

    // the three ways that the real declarations and the controls drop a machine
    const reasons = Arr.dedupe(
      Arr.map(
        Arr.flatMap(
          [Accounts.AccountDomain, Sample, withoutFields],
          (declaration) => gapsOf(declaration, Effx.Gap.guards.MachineDropped)
        ),
        ({ reason }) => reason
      )
    );

    assert.deepStrictEqual(Arr.sort(reasons, Order.String), [
      "a guard reads a semester that the machine does not declare",
      "a guard uses a check that effx does not know",
      "a transition applies activateAccount, which effx cannot be given",
    ]);

    assert.deepStrictEqual(
      Arr.sort(
        Arr.map(Effx.closures.MachineDropped, ({ by }) => by),
        Order.String
      ),
      ["effx", "effx", "kernel"]
    );
  });
});

describe("spec 0007d: guards in effx's words", () => {
  it("a group of checks keeps its operands and their order, and a not wraps its operand", () => {
    const transition = must(
      Arr.findFirst(
        Arr.flatMap(
          exported(Teams.TeamsDomain).machines,
          ({ transitions }) => transitions
        ),
        ({ command }) => command === "endEarlyMembership"
      ),
      "the transition of endEarlyMembership"
    );

    assert.deepStrictEqual(transition.guard, {
      context: "MembershipContext",
      representation: Group.make({
        checks: [
          after(["requested"], ["term", "start"]),
          {
            id: "effx/guard/not",
            payload: after(["requested"], ["term", "end"]),
          },
          { id: "effx/guard/not", payload: after(["current"], ["requested"]) },
        ],
      }),
    });
  });

  it("an or keeps every alternative, in order", () => {
    const comparisons = Guard.semesters(Teams.MembershipMoment);

    const either = Machine.make({
      commands: Teams.TeamsRpc,
      context: Teams.MembershipMoment,
      fields: [
        { kind: "parameter", path: ["requested"] },
        { kind: "stored", path: ["term", "end"] },
      ],
      name: "Membership",
      states: MembershipState,
      terminal: ["Ended"],
      transitions: [
        {
          command: "extendMembership",
          from: ["Active"],
          guard: comparisons.or(
            comparisons.after(["requested"], ["term", "end"]),
            comparisons.same(["requested"], ["term", "end"])
          ),
          to: "Active",
        },
      ],
    });

    const [machine] = exported({
      ...Teams.TeamsDomain,
      machines: [either],
    }).machines;

    assert.deepStrictEqual(machine?.transitions[0]?.guard?.representation, {
      id: "effx/guard/or",
      payload: [
        after(["requested"], ["term", "end"]),
        {
          id: "effx/order/same",
          payload: { left: ["requested"], right: ["term", "end"] },
        },
      ],
    });
  });
});

describe("spec 0007d: what a machine and a domain say about themselves is checked", () => {
  it("the real declarations say it consistently", () => {
    assert.deepStrictEqual(Domain.allProblems(Declarations), []);
  });

  it("falsifier 4: a machine must say which of its states are terminal (the field is required), and its fields may be left out", () => {
    type Definition = Parameters<typeof Machine.make>[0];

    type IsOptional<Key extends keyof Definition> =
      Partial<Pick<Definition, Key>> extends Pick<Definition, Key>
        ? true
        : false;

    expectTypeOf<IsOptional<"terminal">>().toEqualTypeOf<false>();
    expectTypeOf<IsOptional<"fields">>().toEqualTypeOf<true>();
  });

  it("a terminal state that is not a state, a field twice and two clocks are reported", () => {
    const broken: Declaration = {
      ...Teams.TeamsDomain,
      machines: [
        {
          ...Teams.MembershipMachine,
          fields: [
            ...Teams.MembershipMachine.fields,
            { kind: "clock", path: ["term", "start"] },
          ],
          terminal: ["Gone"],
        },
      ],
    };

    assert.deepStrictEqual(
      Arr.filter(Domain.problems(broken), (line) =>
        line.startsWith("Membership")
      ),
      [
        "Membership has the terminal state Gone, which is not one of its states",
        "Membership declares the field term.start twice",
        "Membership declares more than one clock",
      ]
    );
  });

  it("memberships that name a machine or a state that the domain does not have are reported", () => {
    const unknownMachine: Declaration = {
      ...Teams.TeamsDomain,
      memberships: { grantingStates: ["Active"], machine: "Nope" },
    };

    const unknownState: Declaration = {
      ...Teams.TeamsDomain,
      memberships: {
        grantingStates: ["Active", "Retired"],
        machine: "Membership",
      },
    };

    assert.include(
      Domain.problems(unknownMachine),
      "the memberships of teams name the machine Nope, which it does not declare"
    );
    assert.include(
      Domain.problems(unknownState),
      "the memberships of teams grant from Retired, which is not a state of Membership"
    );
  });
});
