/**
 * Spec 0008, falsifiers 4 and 5 on the pure projection: the company address rule (RULE-058, 178, 179), the plan
 * (desired, actual, additions, removals, unmanaged, typed issues) and the removal cap, each with a negative control.
 */
import { assert, describe, it } from "@effect/vitest";
import { Array as Arr, Option, Predicate } from "effect";

import {
  CompanyEmail,
  DepartmentId,
  PersonId,
  TeamId,
  WorkspaceChange,
  WorkspacePlan,
  companyEmailFor,
} from "../../src/index.ts";

const email = (address: string) => CompanyEmail.make(address);

const emails = (...addresses: readonly string[]) => Arr.map(addresses, email);

const person = (
  id: number,
  name: string,
  companyAddress: string | null = null
): WorkspacePlan.PersonFact => ({
  companyAddress,
  name,
  personId: PersonId.make(id),
});

const team = (
  id: number,
  groupAddress: string | null,
  members: readonly number[]
): WorkspacePlan.TeamFact => ({
  groupAddress: groupAddress === null ? null : email(groupAddress),
  members: Arr.map(members, (member) => PersonId.make(member)),
  name: `Team ${id}`,
  teamId: TeamId.make(id),
});

describe("RULE-058, 178, 179: the company address", () => {
  it("is the first name, then the full name with dots, then a number from 2 on, the first that is free", () => {
    const name = "Ola Nordmann";

    const address = (taken: readonly string[]) =>
      Option.getOrUndefined(companyEmailFor(name, new Set(taken)));

    assert.strictEqual(address([]), "ola@vektorprogrammet.no");
    assert.strictEqual(
      address(["ola@vektorprogrammet.no"]),
      "ola.nordmann@vektorprogrammet.no"
    );
    assert.strictEqual(
      address(["ola@vektorprogrammet.no", "ola.nordmann@vektorprogrammet.no"]),
      "ola.nordmann2@vektorprogrammet.no"
    );
    assert.strictEqual(
      address([
        "ola@vektorprogrammet.no",
        "ola.nordmann@vektorprogrammet.no",
        "ola.nordmann2@vektorprogrammet.no",
      ]),
      "ola.nordmann3@vektorprogrammet.no"
    );
  });

  it("transliterates æ, ø and å, drops what an address cannot hold, and gives none for a name without letters", () => {
    assert.strictEqual(
      Option.getOrUndefined(companyEmailFor("Åse Bjørk-Hansen", new Set())),
      "aase@vektorprogrammet.no"
    );
    assert.strictEqual(
      Option.getOrUndefined(
        companyEmailFor("Ærlig Østby", new Set(["aerlig@vektorprogrammet.no"]))
      ),
      "aerlig.ostby@vektorprogrammet.no"
    );
    assert.isTrue(Option.isNone(companyEmailFor("-- ??", new Set())));
    assert.isTrue(Option.isNone(companyEmailFor("", new Set())));
  });

  it("always ends in @vektorprogrammet.no, and a generated address is a valid company address", () => {
    for (const name of ["Kari Nordmann", "Ola", "Per Ole Hansen", "Åse Ø"]) {
      const address = Option.getOrThrow(companyEmailFor(name, new Set()));

      assert.isTrue(address.endsWith("@vektorprogrammet.no"));
      assert.isTrue(Option.isSome(Option.some(CompanyEmail.make(address))));
    }
  });

  it("negative control: an address of another domain, or in capitals, is not a company address", () => {
    assert.throws(() => {
      CompanyEmail.make("ola@example.org");
    });
    assert.throws(() => {
      CompanyEmail.make("Ola@vektorprogrammet.no");
    });
    assert.throws(() => {
      CompanyEmail.make("ola@vektorprogrammet.no.evil.org");
    });
  });
});

describe("RULE-039/049: department mailing lists", () => {
  it("uses department-scoped engagement facts and deduplicates by person id, not name", () => {
    const a = DepartmentId.make(1);
    const b = DepartmentId.make(2);

    const accounts = WorkspacePlan.planAccounts(
      [
        person(1, "Ola Nordmann"),
        person(2, "Ola Nordmann"),
        person(3, "Kari Hansen"),
      ],
      new Set(),
      emails(),
      new Set()
    );

    const engagements: readonly WorkspacePlan.DepartmentEngagement[] = [
      { departmentId: a, personId: PersonId.make(1) },
      { departmentId: a, personId: PersonId.make(1) },
      { departmentId: a, personId: PersonId.make(2) },
      { departmentId: b, personId: PersonId.make(1) },
      { departmentId: b, personId: PersonId.make(3) },
    ];

    const lists = WorkspacePlan.planDepartmentLists(
      [
        { departmentId: a, name: "A" },
        { departmentId: b, name: "B" },
      ],
      engagements,
      accounts.lines
    );

    assert.deepStrictEqual(
      Arr.map(lists, (list) =>
        Arr.map(list.members, (member) => member.personId)
      ),
      [
        [1, 2],
        [1, 3],
      ]
    );
    assert.strictEqual(lists[0]?.members[0]?.name, lists[0]?.members[1]?.name);
    // Negative controls: not deduplicating emits person 1 twice; deduplicating by name loses person 2.
    assert.deepStrictEqual(
      Arr.map(
        Arr.filter(engagements, (engagement) => engagement.departmentId === a),
        (engagement) => engagement.personId
      ),
      [1, 1, 2]
    );
    assert.strictEqual(
      new Set(Arr.map(lists[0]?.members ?? [], (member) => member.name)).size,
      1
    );
  });
});

describe("spec 0008 falsifier 4: the plan counts exactly", () => {
  const people = [
    person(1, "Ola Nordmann", "ola@vektorprogrammet.no"),
    person(2, "Kari Hansen", "kari@vektorprogrammet.no"),
    person(3, "Per Olsen"),
  ];

  const accounts = WorkspacePlan.planAccounts(
    people,
    new Set(["ola@vektorprogrammet.no", "kari@vektorprogrammet.no"]),
    emails(
      "ola@vektorprogrammet.no",
      "stray@vektorprogrammet.no",
      "other@vektorprogrammet.no"
    ),
    new Set()
  );

  it("keeps the address a person has, names one for a person without, and marks what the directory lacks", () => {
    assert.deepStrictEqual(
      Arr.map(
        accounts.lines,
        (line) =>
          `${line.personId} ${line.address} generated=${line.generated} present=${String(line.present)}`
      ),
      [
        "1 ola@vektorprogrammet.no generated=false present=true",
        "2 kari@vektorprogrammet.no generated=false present=false",
        "3 per@vektorprogrammet.no generated=true present=false",
      ]
    );
    assert.deepStrictEqual(accounts.issues, []);
  });

  it("reports what the directory holds beyond the system's people as unmanaged, and changes nothing about it", () => {
    assert.deepStrictEqual(
      accounts.unmanaged,
      emails("other@vektorprogrammet.no", "stray@vektorprogrammet.no")
    );
  });

  it("a stored address outside the company domain is reported, never silently regenerated", () => {
    const plan = WorkspacePlan.planAccounts(
      [person(8, "Invalid Person", "invalid@example.org")],
      new Set(["invalid@example.org"]),
      emails(),
      new Set()
    );

    assert.deepStrictEqual(plan.lines, []);
    assert.deepStrictEqual(plan.issues, [
      WorkspacePlan.Issue.cases.InvalidCompanyAddress.make({
        personId: PersonId.make(8),
      }),
    ]);
  });

  it("gives two people with one first name two addresses, not one", () => {
    const twins = WorkspacePlan.planAccounts(
      [person(5, "Ola Berg"), person(6, "Ola Strand")],
      new Set(),
      emails(),
      new Set()
    );

    assert.deepStrictEqual(
      Arr.map(twins.lines, (line) => line.address),
      ["ola@vektorprogrammet.no", "ola.strand@vektorprogrammet.no"]
    );
  });

  it("RULE-058: generated account addresses cannot collide with configured or directory groups", () => {
    const reserved = new Set([
      "ola@vektorprogrammet.no",
      "ola.berg@vektorprogrammet.no",
    ]);

    const plan = WorkspacePlan.planAccounts(
      [person(5, "Ola Berg")],
      new Set(),
      emails(),
      reserved
    );

    assert.strictEqual(plan.lines[0]?.address, "ola.berg2@vektorprogrammet.no");

    const control = WorkspacePlan.planAccounts(
      [person(5, "Ola Berg")],
      new Set(),
      emails(),
      new Set()
    );

    assert.strictEqual(control.lines[0]?.address, "ola@vektorprogrammet.no");
  });

  it("a name that gives no address is a typed issue, never a guess", () => {
    const plan = WorkspacePlan.planAccounts(
      [person(7, "?? --")],
      new Set(),
      emails(),
      new Set()
    );

    assert.deepStrictEqual(plan.lines, []);
    assert.deepStrictEqual(plan.issues, [
      WorkspacePlan.Issue.cases.NoCompanyAddress.make({
        personId: PersonId.make(7),
      }),
    ]);
  });

  it("counts a group's desired, actual, additions and removals, sorted, with an unknown directory giving no difference", () => {
    const members = team(1, "it@vektorprogrammet.no", [1, 2, 3]);

    const desired = WorkspacePlan.memberAddresses(members, accounts.lines);

    assert.deepStrictEqual(
      desired,
      emails(
        "ola@vektorprogrammet.no",
        "kari@vektorprogrammet.no",
        "per@vektorprogrammet.no"
      )
    );

    const line = WorkspacePlan.planGroup(
      members,
      email("it@vektorprogrammet.no"),
      desired,
      emails("ola@vektorprogrammet.no", "gone@vektorprogrammet.no")
    );

    assert.strictEqual(line.actual, 2);
    assert.deepStrictEqual(
      line.additions,
      emails("kari@vektorprogrammet.no", "per@vektorprogrammet.no")
    );
    assert.deepStrictEqual(line.removals, emails("gone@vektorprogrammet.no"));
    assert.isFalse(line.missing);

    const missing = WorkspacePlan.planGroup(
      members,
      email("it@vektorprogrammet.no"),
      desired,
      "missing"
    );

    assert.isTrue(missing.missing);
    assert.strictEqual(missing.actual, null);
    assert.strictEqual(missing.additions.length, 3);

    const unread = WorkspacePlan.planGroup(
      members,
      email("it@vektorprogrammet.no"),
      desired,
      null
    );

    assert.deepStrictEqual([unread.additions, unread.removals], [[], []]);
  });

  it("a group address that no team configured is reported as unmanaged, and one that a team did is not", () => {
    assert.deepStrictEqual(
      WorkspacePlan.unmanagedGroups(
        emails("it@vektorprogrammet.no", "info@vektorprogrammet.no"),
        new Set(["it@vektorprogrammet.no"])
      ),
      emails("info@vektorprogrammet.no")
    );
  });
});

/** One group of `n` members that the directory holds and the system does not want: `n` removals. */
const groupWithRemovals = (n: number) =>
  WorkspacePlan.planGroup(
    team(1, "it@vektorprogrammet.no", []),
    email("it@vektorprogrammet.no"),
    emails(),
    Arr.makeBy(n, (index) => email(`gone${index}@vektorprogrammet.no`))
  );

describe("spec 0008 falsifier 5: the removal cap", () => {
  it("20 removals are within the cap and 21 are over it", () => {
    assert.isTrue(
      Option.isNone(WorkspacePlan.capIssue([groupWithRemovals(20)], 20))
    );
    assert.deepStrictEqual(
      Option.getOrUndefined(
        WorkspacePlan.capIssue([groupWithRemovals(21)], 20)
      ),
      WorkspacePlan.Issue.cases.RemovalCapExceeded.make({
        cap: 20,
        removals: 21,
      })
    );
  });

  it("negative control: without the cap check, the same 21 removals are all in the changes that would be applied", () => {
    const changes = WorkspacePlan.changesOf([], [groupWithRemovals(21)]);

    assert.strictEqual(
      Arr.filter(changes, (change) =>
        Predicate.isTagged(change, "EnsureAbsent")
      ).length,
      21
    );
  });

  it("the changes come in an order in which each can be applied, and say what to make true", () => {
    const line = WorkspacePlan.planGroup(
      team(1, "it@vektorprogrammet.no", [1]),
      email("it@vektorprogrammet.no"),
      emails("ola@vektorprogrammet.no"),
      "missing"
    );

    const changes = WorkspacePlan.changesOf(
      [
        {
          address: email("ola@vektorprogrammet.no"),
          generated: false,
          name: "Ola Nordmann",
          personId: PersonId.make(1),
          present: false,
        },
      ],
      [line]
    );

    assert.deepStrictEqual(
      Arr.map(changes, (change) => change._tag),
      ["EnsureAccount", "EnsureGroup", "EnsureMember"]
    );
    assert.deepStrictEqual(
      changes[2],
      WorkspaceChange.cases.EnsureMember.make({
        group: email("it@vektorprogrammet.no"),
        member: email("ola@vektorprogrammet.no"),
      })
    );
  });
});
