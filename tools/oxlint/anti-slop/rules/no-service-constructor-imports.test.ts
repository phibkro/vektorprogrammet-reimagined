// Run with `node --test`: the Oxlint RuleTester parses through raw transfer, which Bun lacks.
import { describe, it } from "node:test";

import { RuleTester } from "vite-plus/lint/plugins-dev";

import { noServiceConstructorImportsRule } from "../effect/rules/no-service-constructor-imports.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const code =
  'import { makeTeamTables } from "../domain/support/teamsInMemory.ts";';

new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" }, sourceType: "module" },
}).run("no-service-constructor-imports", noServiceConstructorImportsRule, {
  valid: [
    { code, filename: "apps/web/test/support/memory.ts" },
    { code, filename: "apps/web/test/domain/support/teamsInMemory.ts" },
    { code, filename: "apps/web/test/example.test.ts" },
  ],
  invalid: [
    {
      code,
      filename: "apps/web/src/features/example.ts",
      errors: [{ messageId: "serviceConstructorImport" }],
    },
    {
      code,
      filename: "apps/web/src/test/supporting/example.ts",
      errors: [{ messageId: "serviceConstructorImport" }],
    },
  ],
});
