/**
 * Spec 0006b falsifier 5: ownership is closed over the schema. Every table with a foreign key to an aggregate root's table
 * is owned by a declared root or declared `NotOwned` with its reason, so a table added later cannot escape the lock
 * construct without a test failing. The negative controls show that the check can fail, each in its own way.
 */
import { assert, describe, it } from "@effect/vitest";
import { AggregateRoots } from "@vektorprogrammet/domain";
import { integer, pgTable } from "drizzle-orm/pg-core";
import { Array as Arr } from "effect";

import { NotOwned, Ownership } from "../src/aggregate/ownership.ts";
import type { RootOwnership } from "../src/aggregate/ownership.ts";
import * as schema from "../src/schema.ts";
import { closureProblems, tablesOf } from "./support/ownershipClosure.ts";
import type { SchemaTables } from "./support/ownershipClosure.ts";

const closure = (
  changes: {
    readonly notOwned?: Readonly<Record<string, string>>;
    readonly ownership?: readonly RootOwnership[];
    readonly tables?: SchemaTables;
  } = {}
) =>
  closureProblems({
    notOwned: changes.notOwned ?? NotOwned,
    ownership: changes.ownership ?? Ownership,
    tables: changes.tables ?? tablesOf(schema),
  });

/**
 * What a change adds to the problems of the real declaration. A negative control reads this, so it keeps failing for
 * its own reason when the schema itself has an undeclared table (the first test reports that one).
 */
const reported = (changes: Parameters<typeof closure>[0]) =>
  Arr.difference(closure(changes), closure());

/** A table that a later spec might add: it refers to a person, and nothing declares who owns it. */
const loose = pgTable("loose", {
  personId: integer("person_id").references(() => schema.person.id),
});

const extended = { ...schema, loose };

const withLoose = tablesOf(extended);

describe("spec 0006b falsifier 5: ownership is closed over the schema", () => {
  it("every table that refers to a root is owned by it or declared NotOwned, and each owner column is a foreign key to the root", () => {
    assert.deepStrictEqual(closure(), []);
  });

  it("the domain's roots are the declaration's roots, in the order that a transaction locks them", () => {
    assert.deepStrictEqual(
      Arr.map(Ownership, (root) => root.name),
      [...AggregateRoots]
    );
  });

  it("negative control: a new table with a foreign key to person and no declaration is reported", () => {
    assert.deepStrictEqual(reported({ tables: withLoose }), [
      "`loose` refers to person and is neither owned by Person nor declared NotOwned",
    ]);
  });

  it("negative control: declaring the new table NotOwned without a reason is reported, and with one it is closed", () => {
    assert.deepStrictEqual(
      reported({ notOwned: { ...NotOwned, loose: " " }, tables: withLoose }),
      ["NotOwned `loose` gives no reason"]
    );

    assert.deepStrictEqual(
      reported({
        notOwned: { ...NotOwned, loose: "a test table" },
        tables: withLoose,
      }),
      []
    );
  });

  it("negative control: an owner column that is not a foreign key to the root is reported", () => {
    const [person] = Ownership;

    const wrongOwner: readonly RootOwnership[] = [
      {
        ...person,
        owns: { ...person.owns, membership: { owner: "positionId" } },
      },
    ];

    assert.deepStrictEqual(reported({ ownership: wrongOwner }), [
      "Person owns `membership` by `positionId`, which is not a foreign key to person",
    ]);
  });

  it("negative control: a NotOwned entry for a table that refers to no root, or that a root owns, is reported", () => {
    assert.deepStrictEqual(
      reported({ notOwned: { ...NotOwned, department: "not about a person" } }),
      ["NotOwned `department` is no table that refers to a root"]
    );

    assert.deepStrictEqual(
      reported({ notOwned: { ...NotOwned, membership: "owned already" } }),
      ["`membership` is both owned and NotOwned"]
    );
  });
});
