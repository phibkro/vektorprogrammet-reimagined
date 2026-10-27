/**
 * Spec 0006b falsifier 1: what the construct refuses at the type level. Each case is a statement that must not type-check,
 * under a `@ts-expect-error` that fails the type check itself the day the statement starts to compile, so a case cannot
 * rot. The statements never run: the lock registry that refuses the same mistakes at run time is tested in
 * `aggregates.postgres.test.ts`.
 */
import { assert, describe, it } from "@effect/vitest";
import type {
  Accounts,
  Locked,
  MembershipRepository,
} from "@vektorprogrammet/domain";

import type { Aggregates } from "../src/aggregate/aggregates.ts";
import { Person } from "../src/aggregate/declaration.ts";
import type * as Schema from "../src/schema.ts";

type Writer = Aggregates["Service"];

type Memberships = MembershipRepository["Service"];

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

const ofAnotherRoot = (w: Writer, team: Locked<"Team">, row: Row) =>
  // @ts-expect-error a lock of a team is not a lock of a person
  w.insert(team, membership, row);

const repositoryOfAnotherRoot = (
  m: Memberships,
  team: Locked<"Team">,
  draft: Draft
) =>
  // @ts-expect-error the same holds for a repository
  m.insert(team, draft);

const handMade = (writer: Writer, row: Row) =>
  // @ts-expect-error an object literal lacks the brand that only a lock gives
  writer.insert({ id: 1, root: "Person" }, membership, row);

const otherOwner = (writer: Writer, locked: Locked, row: Row) =>
  // @ts-expect-error the owner column is filled from the token, so it is not a value
  writer.insert(locked, membership, { ...row, personId: 7 });

const appliesWithoutMachine = (
  writer: Writer,
  locked: Locked,
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

  it("a write cannot name another owner, and only a table with a stored machine can have a transition applied", () => {
    assert.isFunction(otherOwner);
    assert.isFunction(appliesWithoutMachine);
  });
});
