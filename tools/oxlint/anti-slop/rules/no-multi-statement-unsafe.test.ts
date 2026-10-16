// Run with `node --test`: the Oxlint RuleTester parses through raw transfer, which Bun lacks.
import { describe, it } from "node:test";

import { RuleTester } from "vite-plus/lint/plugins-dev";

import { noMultiStatementUnsafeRule } from "./no-multi-statement-unsafe.ts";

RuleTester.describe = describe;
RuleTester.it = it;

new RuleTester().run("no-multi-statement-unsafe", noMultiStatementUnsafeRule, {
  valid: [
    // Negative controls: one command, in each spelling that hides a semicolon.
    'sql.unsafe("SELECT 1")',
    'sql.unsafe("SELECT 1;")',
    "sql.unsafe(`SELECT 1;\n`)",
    "sql.unsafe(`DO $$ BEGIN PERFORM 1; PERFORM 2; END $$`)",
    "sql.unsafe(`CREATE FUNCTION f() RETURNS trigger AS $body$ BEGIN RETURN NEW; END; $body$ LANGUAGE plpgsql`)",
    'sql.unsafe("SELECT \'a;b\' AS \\"x;y\\"")',
    "sql.unsafe(`-- one; two\nSELECT 1`)",
    "sql.unsafe(`/* one; two */ SELECT 1`)",
    "sql.unsafe(`SELECT ${column} FROM t WHERE id = $1`, [id])",
    // Other executors and sources keep their own rules.
    'executePostgresMigration("CREATE TABLE a (id int); CREATE TABLE b (id int)")',
    'pglite.exec("SELECT 1; SELECT 2")',
    "sql.unsafe(source)",
  ],
  invalid: [
    {
      code: 'sql.unsafe("DROP SCHEMA a CASCADE; CREATE SCHEMA a;")',
      errors: [{ messageId: "multipleCommands" }],
    },
    {
      code: "sql.unsafe(`INSERT INTO t VALUES (1);\nINSERT INTO t VALUES (2)`)",
      errors: [{ messageId: "multipleCommands" }],
    },
    {
      code: "database.unsafe(`CREATE FUNCTION f() RETURNS trigger AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql; CREATE TRIGGER g BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION f();`)",
      errors: [{ messageId: "multipleCommands" }],
    },
    {
      code: "sql.unsafe(`SELECT ${first}; SELECT 2`)",
      errors: [{ messageId: "multipleCommands" }],
    },
  ],
});
