import registry from "./effect-exceptions.json" with { type: "json" };

const entries = registry.unstableApis;

const modules = (...names: readonly string[]): string[] => {
  const result = new Set<string>();

  for (const entry of entries) {
    if (names.includes(entry.name)) {
      for (const name of entry.scope.modules) {
        result.add(name);
      }
    }
  }

  return [...result];
};

const paths = (...values: readonly string[]): string[] => {
  const result: string[] = [];

  for (const value of values) {
    if (value.endsWith("/**")) {
      result.push(
        `${value}/*.ts`,
        `${value}/*.tsx`,
        `../../${value}/*.ts`,
        `../../${value}/*.tsx`
      );
    } else {
      result.push(value, `../../${value}`);
    }
  }

  return result;
};

const base = ["platform", "rpc"] as const;
const testing = [...base, "runtimes", "tests", "sql"] as const;
const tools = [...base, "runtimes", "sql", "http", "tools"] as const;
const testingTools = [...tools, "tests"] as const;

const override = (include: readonly string[], ...names: readonly string[]) => ({
  include: paths(...include),
  options: { allowedUnstableApis: modules(...names) },
});

/** Ordered replacement lists for the Effect language service. */
export const unstablePolicy = {
  allowedUnstableApis: modules(...base),
  overrides: [
    override(["test/**", "**/test/**"], ...testing),
    override(
      [
        "tools/**",
        "packages/*/scripts/**",
        "apps/*/scripts/**",
        "apps/*/e2e/**",
        "apps/cms/build/**",
      ],
      ...tools
    ),
    override(["tools/*/test/**", "apps/*/e2e/**"], ...testingTools),
    override(["apps/web/src/adapters/db/**"], ...base, "sql"),
    override(["apps/web/src/server/**"], ...base, "sql", "http"),
    override(
      [
        "apps/web/src/features/accounts/client.ts",
        "apps/web/src/adapters/messaging/senders.ts",
        "apps/web/src/adapters/turnstile.ts",
      ],
      ...base,
      "http"
    ),
    override(["tools/import/src/**"], ...tools, "mysql"),
    override(["tools/import/test/**"], ...testingTools, "mysql"),
    override(
      [
        "apps/web/test/sandbox.test.ts",
        "apps/web/test/integrationGuard.test.ts",
      ],
      ...testing,
      "http"
    ),
    override(
      ["apps/web/test/db/support/disposableDatabase.ts"],
      ...testing,
      "reactivity"
    ),
    override(
      ["tools/db-path-spike/test/support/localWorker.ts"],
      ...testingTools,
      "reactivity"
    ),
    // Mirror the root lint ignores for generated code and local lint plugins.
    {
      include: paths("tools/oxlint/anti-slop/**"),
      options: {
        diagnosticSeverity: {
          preferEffectArray: "off",
          preferEffectRecord: "off",
        },
      },
    },
    // These callbacks are owned by Playwright or other Promise-based test hosts.
    {
      include: paths(
        "apps/web/e2e/**",
        "apps/web/test/contact.test.ts",
        "apps/web/test/errors.test.ts",
        "apps/web/test/formMessages.test.tsx",
        "apps/web/test/formRender.test.tsx",
        "apps/web/test/organisationPanel.test.ts",
        "apps/web/test/support/run.ts",
        "apps/web/test/site.test.ts",
        "apps/web/test/panel.test.ts",
        "apps/web/test/publicFiles.test.ts",
        "apps/web/test/redirects.test.ts",
        "apps/web/test/sandbox.test.ts",
        "apps/web/test/integrationGuard.test.ts",
        // EX-0027: Vitest owns the asynchronous module re-evaluation.
        "apps/web/test/domain/personalData/basesApproval.test.ts",
        "tools/db-path-spike/test/**"
      ),
      options: { diagnosticSeverity: { asyncFunction: "off" } },
    },
    // This synchronous function maps an already typed error union.
    {
      include: paths("apps/web/src/server/http/errors.ts"),
      options: { diagnosticSeverity: { schemaSync: "off" } },
    },
  ],
};
