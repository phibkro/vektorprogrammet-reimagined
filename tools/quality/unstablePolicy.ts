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
    override(["packages/db/src/**"], ...base, "sql"),
    {
      include: paths(
        "spikes/alchemy-domain/src/**/*.ts",
        "spikes/alchemy-domain/src/**/*.tsx"
      ),
      options: {
        allowedDuplicatedPackages: ["alchemy"],
        allowedUnstableApis: modules(...base, "sql", "rpcMiddleware"),
      },
    },
    {
      include: paths(
        "packages/domain/src/organisation/semester.ts",
        "packages/domain/src/shared/clock.ts",
        "packages/domain/src/shared/ids.ts"
      ),
      options: {
        allowedDuplicatedPackages: ["alchemy"],
        allowedUnstableApis: modules(...base),
      },
    },
    override(["spikes/alchemy-domain/test/**"], ...testing, "rpcMiddleware"),
    {
      include: paths(
        "spikes/alchemy-workflows/src/**/*.ts",
        "spikes/alchemy-workflows/src/**/*.tsx"
      ),
      options: {
        allowedDuplicatedPackages: ["alchemy"],
        allowedUnstableApis: modules(...base, "sql", "httpServer"),
      },
    },
    {
      include: paths(
        "spikes/alchemy-workflows/test/**/*.ts",
        "spikes/alchemy-workflows/test/**/*.tsx"
      ),
      options: {
        allowedDuplicatedPackages: ["alchemy"],
        allowedUnstableApis: modules(...testingTools),
      },
    },
    {
      include: paths(
        "spikes/alchemy-workflows/alchemy.run.ts",
        "spikes/alchemy-workflows/vite.config.ts",
        "spikes/alchemy-workflows/vite.runtime.config.ts",
        "spikes/alchemy-workflows/alchemy.cloud.ts",
        "spikes/alchemy-workflows/vite.cloud.config.ts"
      ),
      options: {
        allowedDuplicatedPackages: ["alchemy"],
        allowedUnstableApis: modules(...base),
      },
    },
    override(["apps/web/src/server/**"], ...base, "sql", "http"),
    override(["packages/cms-client/src/**"], ...base, "http"),
    override(["tools/import/src/**"], ...tools, "mysql"),
    override(["tools/import/test/**"], ...testingTools, "mysql"),
    override(["packages/cms-client/scripts/**"], ...tools, "openapi"),
    override(
      [
        "packages/cms-client/test/client.test.ts",
        "apps/web/test/sandbox.test.ts",
      ],
      ...testing,
      "http"
    ),
    override(
      ["packages/db/test/support/disposableDatabase.ts"],
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
      include: paths(
        "tools/oxlint/anti-slop/**",
        "packages/cms-client/src/generated.ts"
      ),
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
        "apps/web/test/organisationPanel.test.ts",
        "apps/web/test/support/run.ts",
        "apps/web/test/site.test.ts",
        "apps/web/test/panel.test.ts",
        "apps/web/test/publicFiles.test.ts",
        "apps/web/test/redirects.test.ts",
        "apps/web/test/sandbox.test.ts",
        "tools/db-path-spike/test/**"
      ),
      options: { diagnosticSeverity: { asyncFunction: "off" } },
    },
    // This synchronous function maps an already typed error union.
    {
      include: paths("apps/web/src/server/errors.ts"),
      options: { diagnosticSeverity: { schemaSync: "off" } },
    },
  ],
};
