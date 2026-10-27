/**
 * Spec 0006b falsifier 1: what the construct refuses at the type level. Each case is a statement that must not type-check,
 * under a `@ts-expect-error` that fails the type check itself the day the statement starts to compile, so a case cannot
 * rot. The statements never run: the lock registry that refuses the same mistakes at run time is tested in
 * `aggregates.postgres.test.ts`.
 * One case goes the other way, on purpose: it pins what the types let through (a token respelled with a spread, R3).
 */
import { assert, describe, it } from "@effect/vitest";
import type {
  AccountRepository,
  Accounts,
  AdminGrantId,
  AdminGrantRepository,
  Locked,
  MembershipRepository,
  PersonId,
} from "@vektorprogrammet/domain";
import type { DateTime } from "effect";

import type { Aggregates } from "../src/aggregate/aggregates.ts";
import { Person } from "../src/aggregate/declaration.ts";
import type * as Schema from "../src/schema.ts";

type Writer = Aggregates["Service"];

type Memberships = MembershipRepository["Service"];

type Grants = AdminGrantRepository["Service"];

/** A membership as a write takes it: the owner's column is not a value, the token gives it. */
type Row = Omit<typeof Schema.membership.$inferInsert, "personId">;

type Draft = Parameters<Memberships["insert"]>[1];

const { membership } = Person.owned;

const withoutToken = (writer: Writer, row: Row) =>
  // @ts-expect-error the first argument of a write is the lock of its owner
  writer.insert(membership, row);

const throughRepository = (memberships: Memberships, draft: Draft) =>
  // @ts-expect-error a repository write takes the person's lock first
  memberships.insert(draft);

const decisionRead = (writer: Writer) =>
  // @ts-expect-error a decision read is made through the locks of the owners it reads
  writer.select(membership);

const ofAnotherRoot = (w: Writer, adminList: Locked<"AdminList">, row: Row) =>
  // @ts-expect-error a lock of the admin list is not a lock of a person
  w.insert(adminList, membership, row);

const repositoryOfAnotherRoot = (
  m: Memberships,
  adminList: Locked<"AdminList">,
  draft: Draft
) =>
  // @ts-expect-error the same holds for a repository
  m.insert(adminList, draft);

const handMade = (writer: Writer, row: Row) =>
  // @ts-expect-error an object literal lacks the brand that only a lock gives
  writer.insert({ id: 1, root: "Person" }, membership, row);

/**
 * What the types let through (spec 0006b R3): a spread copies the brand, and `id` is an ordinary property, so a token
 * of one row type-checks as a token of another. The lock registry refuses it at run time (`aggregates.postgres.test.ts`).
 */
const respelled = (held: Locked<"Person">): Locked<"Person"> => ({
  ...held,
  id: 7,
});

const otherOwner = (writer: Writer, locked: Locked<"Person">, row: Row) =>
  // @ts-expect-error the owner column is filled from the token, so it is not a value
  writer.insert(locked, membership, { ...row, personId: 7 });

const appliesWithoutMachine = (
  writer: Writer,
  locked: Locked<"Person">,
  transition: Accounts.AccountMachineTransition
) => {
  const row = {
    entity: "Membership",
    key: "1",
    message: "a membership has no stored machine",
    owned: membership,
  } as const;

  // @ts-expect-error only a table with a stored machine can have a transition applied
  return writer.apply(transition, locked, row);
};

const lastAdminThroughPerson = (
  accounts: AccountRepository["Service"],
  locked: Locked<"Person">,
  personId: PersonId,
  now: DateTime.Utc
) =>
  // @ts-expect-error whether an Active administrator is left is read through the admin list's lock
  accounts.isLastActiveAdmin(locked, personId, now);

const revokeThroughPerson = (
  grants: Grants,
  locked: Locked<"Person">,
  id: AdminGrantId,
  validAfter: DateTime.Utc
) =>
  // @ts-expect-error a revocation decides on every place, so it takes the admin list's lock first
  grants.revoke(locked, locked, id, validAfter);

const grantThroughPerson = (
  grants: Grants,
  locked: Locked<"Person">,
  draft: Parameters<Grants["create"]>[2]
) =>
  // @ts-expect-error a place changes who is on the list, so a grant takes the admin list's lock first
  grants.create(locked, locked, draft);

describe("spec 0006b falsifier 1: the construct's promises hold at the type level", () => {
  it("a write to membership without the lock of its owner does not type-check", () => {
    assert.isFunction(withoutToken);
    assert.isFunction(throughRepository);
    assert.isFunction(decisionRead);
  });

  it("the lock of another root does not stand for the lock of a person", () => {
    assert.isFunction(ofAnotherRoot);
    assert.isFunction(repositoryOfAnotherRoot);
  });

  it("a token made by hand does not type-check", () => {
    assert.isFunction(handMade);
  });

  it("a token respelled from a real one does type-check: the types do not tie a token to its row, the lock registry does", () => {
    assert.isFunction(respelled);
  });

  it("a write cannot name another owner, and only a table with a stored machine can have a transition applied", () => {
    assert.isFunction(otherOwner);
    assert.isFunction(appliesWithoutMachine);
  });
});

describe("spec 0006b R2: the decision on every administrator is read through the admin list's lock", () => {
  it("the lock of a person does not stand for the admin list's, in a read or in a write", () => {
    assert.isFunction(lastAdminThroughPerson);
    assert.isFunction(revokeThroughPerson);
    assert.isFunction(grantThroughPerson);
  });
});
