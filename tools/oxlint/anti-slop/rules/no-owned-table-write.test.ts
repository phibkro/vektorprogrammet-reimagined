// Run with `node --test`: the Oxlint RuleTester parses through raw transfer, which Bun lacks.
import { describe, it } from "node:test";

import { RuleTester } from "vite-plus/lint/plugins-dev";

import { noOwnedTableWriteRule } from "./no-owned-table-write.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const owned = [{ messageId: "ownedTableWrite" }];
const root = [{ messageId: "rootTableWrite" }];
const state = [{ messageId: "stateColumnWrite" }];

const schemaNamed = (names: string) =>
  `import { ${names} } from "../schema.ts";\n`;

const schemaNamespace = 'import * as schema from "../schema.ts";\n';

new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" }, sourceType: "module" },
}).run("no-owned-table-write", noOwnedTableWriteRule, {
  valid: [
    // Negative controls: a table that no root owns, reads of an owned table, and the writer's own calls.
    `${schemaNamed("team")}db.insert(team).values(row)`,
    `${schemaNamed("team")}db.update(team).set({ name }).where(w)`,
    `${schemaNamed("membership")}db.select().from(membership).where(w)`,
    `${schemaNamespace}db.insert(schema.team).values(row)`,
    "aggregates.insert(locked, owned.membership, values)",
    "aggregates.update(locked, owned.account, { set, where })",
    "aggregates.remove(locked, owned.adminGrant, where)",
    "aggregates.apply(transition, locked, row)",
    // A root's own row is created without a token: none exists before it does.
    `${schemaNamed("person")}db.insert(person).values(row)`,
    `${schemaNamespace}db.insert(schema.person).values(row)`,
    // A name is not a schema table unless the schema module exported it.
    'import { membership } from "./elsewhere.ts";\ndb.insert(membership).values(row)',
    "const membership = somethingElse;\ndb.insert(membership).values(row)",
    'import { Ref } from "effect";\nRef.update(held, step)',
    // Other kinds of write on owned tables are not Drizzle statements.
    `${schemaNamed("membership")}db.execute(membership)`,
  ],
  invalid: [
    // The hand-written write that the construct replaces.
    {
      code: `${schemaNamed("membership")}db.insert(membership).values(row)`,
      errors: owned,
    },
    {
      code: `${schemaNamed("adminGrant")}tx.delete(adminGrant).where(w)`,
      errors: owned,
    },
    {
      code: `${schemaNamed("code")}db.update(code).set({ expiresAt: now }).where(w)`,
      errors: owned,
    },
    {
      code: `${schemaNamed("account")}db.insert(account).values(row)`,
      errors: owned,
    },
    // The schema namespace of the in-package module (`import * as schema`); the package root exports no schema.
    {
      code: `${schemaNamespace}db.update(schema.code).set(values)`,
      errors: owned,
    },
    // Another name for the import is still the table.
    {
      code: 'import { membership as place } from "../schema.ts";\ndb.insert(place).values(row)',
      errors: owned,
    },
    // Falsifier 4: a repository method that writes the state column of a stored machine directly.
    {
      code: `${schemaNamed("account")}db.update(account).set({ state: "Deactivated" }).where(w)`,
      errors: state,
    },
    {
      code: `${schemaNamespace}db.update(schema.account).set({ "state": to }).where(and(eq(schema.account.personId, id), eq(schema.account.state, from)))`,
      errors: state,
    },
    // A set that does not name the state is still a write to an owned table.
    {
      code: `${schemaNamed("account")}db.update(account).set({ ...patch }).where(w)`,
      errors: owned,
    },
    // The root's row changes under its lock only.
    {
      code: `${schemaNamed("person")}db.update(person).set({ name }).where(w)`,
      errors: root,
    },
    {
      code: `${schemaNamespace}db.delete(schema.person).where(w)`,
      errors: root,
    },
  ],
});
