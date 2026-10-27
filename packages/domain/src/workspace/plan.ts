/**
 * The Google Workspace projection as pure functions (spec 0008, RULE-039, 049, 225, 242 to 246). The system is the
 * source of truth: the desired state is a function of the active memberships, the Accounts' state and the teams'
 * configured group addresses, and the plan is the difference between it and what the directory holds. Nothing here
 * reads a provider or a table; the caller passes facts in and gets lines, issues and changes out.
 *
 * What is managed is what the system names: a group is managed when a team has configured its address, an account
 * when a person with an active membership has a company address. What the directory holds beyond that is
 * `unmanaged`: reported, never changed. Only members of a managed group are ever removed, and only up to the cap.
 */
import { Array as Arr, Option, Order, Schema } from "effect";

import { DepartmentId, PersonId, TeamId } from "../shared/ids.ts";
import { WorkspaceChange } from "./change.ts";
import { CompanyEmail, companyEmailFor } from "./companyEmail.ts";

/** A person with an active engagement this semester and an Active account (RULE-202). */
export interface PersonFact {
  readonly personId: PersonId;
  readonly name: string;
  readonly companyAddress: string | null;
}

/** An active department and one of its active engagements, independent of the engagement's source. */
export interface DepartmentFact {
  readonly departmentId: DepartmentId;
  readonly name: string;
}

export interface DepartmentEngagement {
  readonly departmentId: DepartmentId;
  readonly personId: PersonId;
}

/** An active team, the group address that someone configured for it, and who is active in it this semester. */
export interface TeamFact {
  readonly teamId: TeamId;
  readonly name: string;
  readonly groupAddress: CompanyEmail | null;
  readonly members: readonly PersonId[];
}

/** What the directory holds of one group: its members, `"missing"` when there is no such group, `null` when unread. */
export type ActualGroup = readonly CompanyEmail[] | "missing" | null;

/** A company account that the projection wants, and whether the directory has it (`null`: the directory was not read). */
export const AccountLine = Schema.Struct({
  address: CompanyEmail,
  /** The address came from RULE-058 because the person has none. */
  generated: Schema.Boolean,
  name: Schema.String,
  personId: PersonId,
  present: Schema.NullOr(Schema.Boolean),
});

export type AccountLine = typeof AccountLine.Type;

/** The desired, identity-deduplicated mailing list. A provider group address is not guessed. */
export const DepartmentList = Schema.Struct({
  departmentId: DepartmentId,
  members: Schema.Array(
    Schema.Struct({
      address: CompanyEmail,
      name: Schema.String,
      personId: PersonId,
    })
  ),
  name: Schema.String,
});

export type DepartmentList = typeof DepartmentList.Type;

/** RULE-039/049: one person once per department, regardless of how many teams or engagements they have. */
export const planDepartmentLists = (
  departments: readonly DepartmentFact[],
  engagements: readonly DepartmentEngagement[],
  accounts: readonly AccountLine[]
): readonly DepartmentList[] => {
  const accountsById = new Map(
    Arr.map(accounts, (account) => [account.personId, account] as const)
  );

  const byDepartment = new Map<
    DepartmentId,
    Map<PersonId, DepartmentList["members"][number]>
  >();

  for (const engagement of engagements) {
    const account = accountsById.get(engagement.personId);

    if (account === undefined) {
      continue;
    }

    let members = byDepartment.get(engagement.departmentId);

    if (members === undefined) {
      members = new Map();
      byDepartment.set(engagement.departmentId, members);
    }

    members.set(account.personId, {
      address: account.address,
      name: account.name,
      personId: account.personId,
    });
  }

  return Arr.map(
    Arr.sort(
      departments,
      Order.mapInput(
        Order.Number,
        (department: DepartmentFact) => department.departmentId
      )
    ),
    (department) => ({
      ...department,
      members: Arr.sort(
        [...(byDepartment.get(department.departmentId)?.values() ?? [])],
        Order.mapInput(
          Order.Number,
          (member: DepartmentList["members"][number]) => member.personId
        )
      ),
    })
  );
};

/** One managed group: the members it should have, what it has, and the difference. */
export const GroupLine = Schema.Struct({
  /** Members in the directory; `null` when the group is missing or the directory was not read. */
  actual: Schema.NullOr(Schema.Int),
  additions: Schema.Array(CompanyEmail),
  address: CompanyEmail,
  desired: Schema.Array(CompanyEmail),
  /** The directory was read and has no such group. */
  missing: Schema.Boolean,
  name: Schema.String,
  removals: Schema.Array(CompanyEmail),
  teamId: TeamId,
});

export type GroupLine = typeof GroupLine.Type;

/** What the directory holds that the system does not name. Reported and left alone. */
export const Unmanaged = Schema.Struct({
  accounts: Schema.Array(CompanyEmail),
  groups: Schema.Array(CompanyEmail),
});

export type Unmanaged = typeof Unmanaged.Type;

/** A thing that the projection could not decide, shown instead of a guess. */
export const Issue = Schema.TaggedUnion({
  ActualStateUnavailable: { reason: Schema.String },
  IncompleteGroupMembers: { teamId: TeamId },
  InvalidCompanyAddress: { personId: PersonId },
  NoCompanyAddress: { personId: PersonId },
  NoGroupAddress: { teamId: TeamId },
  RemovalCapExceeded: { cap: Schema.Int, removals: Schema.Int },
});

export type Issue = typeof Issue.Type;

const byAddress = Order.mapInput(
  Order.String,
  (address: CompanyEmail) => address
);

const sorted = (addresses: readonly CompanyEmail[]): readonly CompanyEmail[] =>
  Arr.sort(Arr.dedupe(addresses), byAddress);

const isCompanyEmail = Schema.is(CompanyEmail);

/** The accounts the projection wants, what it could not name, and what the directory holds that the system does not. */
export interface AccountPlan {
  readonly lines: readonly AccountLine[];
  readonly issues: readonly Issue[];
  readonly unmanaged: readonly CompanyEmail[];
}

/**
 * The accounts of `people`, in person-id order. A person's own company address is kept; one without gets the address
 * that RULE-058 names against `stored` (every person's address) and `directory` (every account that exists), and the
 * names given out earlier in this pass, so two new people never get one address. A name that gives none is an issue.
 */
export const planAccounts = (
  people: readonly PersonFact[],
  stored: ReadonlySet<string>,
  directory: readonly CompanyEmail[] | null,
  reservedGroups: ReadonlySet<string>
): AccountPlan => {
  const present = new Set<string>(directory);
  const taken = new Set<string>([...stored, ...present, ...reservedGroups]);
  const lines: AccountLine[] = [];
  const issues: Issue[] = [];

  for (const person of Arr.sort(
    people,
    Order.mapInput(Order.Number, (fact: PersonFact) => fact.personId)
  )) {
    if (
      person.companyAddress !== null &&
      !isCompanyEmail(person.companyAddress)
    ) {
      issues.push(
        Issue.cases.InvalidCompanyAddress.make({ personId: person.personId })
      );
      continue;
    }

    const address =
      person.companyAddress === null
        ? companyEmailFor(person.name, taken)
        : Option.some(person.companyAddress);

    if (Option.isNone(address)) {
      issues.push(
        Issue.cases.NoCompanyAddress.make({ personId: person.personId })
      );
    } else {
      taken.add(address.value);
      lines.push({
        address: address.value,
        generated: person.companyAddress === null,
        name: person.name,
        personId: person.personId,
        present: directory === null ? null : present.has(address.value),
      });
    }
  }

  return {
    issues,
    lines,
    unmanaged:
      directory === null
        ? []
        : sorted(Arr.filter(directory, (address) => !stored.has(address))),
  };
};

/** The group addresses in the directory that no team has configured. */
export const unmanagedGroups = (
  directory: readonly CompanyEmail[] | null,
  configured: ReadonlySet<string>
): readonly CompanyEmail[] =>
  directory === null
    ? []
    : sorted(Arr.filter(directory, (address) => !configured.has(address)));

/**
 * One managed group: `desired` are the addresses of the team's members. A group that the directory lacks is created
 * and filled (`missing`); one that was not read has no difference to report.
 */
export const planGroup = (
  team: TeamFact,
  address: CompanyEmail,
  desired: readonly CompanyEmail[],
  actual: ActualGroup
): GroupLine => {
  const want = sorted(desired);
  const held = actual === null || actual === "missing" ? [] : sorted(actual);

  return {
    actual: actual === null || actual === "missing" ? null : held.length,
    additions: actual === null ? [] : Arr.difference(want, held),
    address,
    desired: want,
    missing: actual === "missing",
    name: team.name,
    removals: Arr.difference(held, want),
    teamId: team.teamId,
  };
};

/** The addresses of a team's members, from the accounts that the plan has named. A member without one is skipped. */
export const memberAddresses = (
  team: TeamFact,
  accounts: readonly AccountLine[]
): readonly CompanyEmail[] =>
  Arr.flatMap(team.members, (personId) =>
    Option.toArray(
      Option.map(
        Arr.findFirst(accounts, (line) => line.personId === personId),
        (line) => line.address
      )
    )
  );

/** The members that the plan would take out of managed groups: what the cap counts. */
export const removalCount = (groups: readonly GroupLine[]): number =>
  Arr.reduce(groups, 0, (total, group) => total + group.removals.length);

/** `Some(issue)` when the plan removes more than `cap` members: the run then changes nothing at all. */
export const capIssue = (
  groups: readonly GroupLine[],
  cap: number
): Option.Option<Issue> => {
  const removals = removalCount(groups);

  return removals > cap
    ? Option.some(Issue.cases.RemovalCapExceeded.make({ cap, removals }))
    : Option.none();
};

/**
 * The changes that make the directory match the plan, in an order in which each can be applied: accounts, then each
 * group, its members, and the members to take out. A line whose directory state was not read yields none.
 */
export const changesOf = (
  accounts: readonly AccountLine[],
  groups: readonly GroupLine[]
): readonly WorkspaceChange[] => [
  ...Arr.flatMap(accounts, (line) =>
    line.present === false
      ? [
          WorkspaceChange.cases.EnsureAccount.make({
            address: line.address,
            name: line.name,
          }),
        ]
      : []
  ),
  ...Arr.flatMap(groups, (group) => [
    ...(group.missing
      ? [
          WorkspaceChange.cases.EnsureGroup.make({
            address: group.address,
            name: group.name,
          }),
        ]
      : []),
    ...Arr.map(group.additions, (member) =>
      WorkspaceChange.cases.EnsureMember.make({ group: group.address, member })
    ),
    ...Arr.map(group.removals, (member) =>
      WorkspaceChange.cases.EnsureAbsent.make({ group: group.address, member })
    ),
  ]),
];
