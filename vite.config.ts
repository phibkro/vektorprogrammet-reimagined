import { effectNative, strict } from "@effect/tsgo/oxlint-presets";
import { effect } from "@phibkro/oxlint-effect-plugin";
import type { EffectConfigInput } from "@phibkro/oxlint-effect-plugin";
import ultraciteFmt from "ultracite/oxfmt";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import shadcn from "ultracite/oxlint/shadcn";
import { defineConfig } from "vite-plus";

const tsgoPresets = [strict, effectNative];

const tsgoRules: Record<string, "error"> = {};

for (const preset of tsgoPresets) {
  for (const rule of Object.getOwnPropertyNames(preset.rules ?? {})) {
    tsgoRules[rule] = "error";
  }
}

const effectConfig: EffectConfigInput = {
  groups: [
    {
      files: ["packages/domain/src/**"],
      platform: "portable",
      role: "effect-library",
      strictness: "strict",
    },
    {
      boundaries: ["external-data"],
      files: ["packages/db/src/**"],
      platform: "node",
      role: "runtime-adapter",
      strictness: "strict",
    },
    {
      files: ["apps/web/src/**"],
      platform: "portable",
      role: "application",
      strictness: "strict",
    },
    {
      files: ["tools/import/src/**"],
      platform: "node",
      role: "composition-root",
      strictness: "strict",
    },
    {
      files: ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts"],
      platform: "node",
      role: "test",
      strictness: "strict",
    },
    {
      files: ["tools/quality/**"],
      platform: "node",
      role: "composition-root",
      strictness: "strict",
    },
  ],
};

const effectConfigResult = effect(effectConfig);

// Ultracite already enables the identical 18 upstream rules, so enable only the four local additions.
const antiSlopRuleNames = [
  "no-dev-server",
  "no-implicit-date-time-zone",
  "no-multi-statement-unsafe",
  "no-unkeyed-command-row",
];

const effectAntiSlopRuleNames = [
  "no-manual-effect-error-tag",
  "no-manual-tag-comparison",
  "no-manual-tagged-construction",
  "no-service-constructor-imports",
  "prefer-effect-match",
];

const localAntiSlopRules: Record<string, "error"> = {};

for (const name of antiSlopRuleNames) {
  localAntiSlopRules[`vektor-anti-slop/${name}`] = "error";
}

for (const name of effectAntiSlopRuleNames) {
  localAntiSlopRules[`anti-slop-effect/${name}`] = "error";
}

const restrictedSourcePatterns = [
  {
    message:
      "Import another workspace package through its export map, not its source path.",
    regex: "^@vektorprogrammet/[^/]+/src(?:/|$)",
  },
  {
    message:
      "Import another workspace package through its export map, not its source path.",
    regex: "^(?:\\./|(?:\\.\\./)+)(?:apps|packages|tools)/[^/]+/src(?:/|$)",
  },
];

export default defineConfig({
  fmt: {
    ...ultraciteFmt,
    // The router-generated tree is recreated during development and builds.
    ignorePatterns: [
      ...(ultraciteFmt.ignorePatterns ?? []),
      "apps/web/src/routeTree.gen.ts",
    ],
  },
  lint: {
    extends: [core, antiSlop, shadcn, strict, effectNative],
    // Preserve the existing generated route-tree exclusion.
    ignorePatterns: [
      ...(core.ignorePatterns ?? []),
      "apps/web/src/routeTree.gen.ts",
      "tools/oxlint/anti-slop/**",
    ],
    jsPlugins: [
      { name: "vite-plus", specifier: "vite-plus/oxlint-plugin" },
      ...effectConfigResult.jsPlugins,
      {
        name: "vektor-anti-slop",
        specifier: "./tools/oxlint/anti-slop/index.ts",
      },
      {
        name: "anti-slop-effect",
        specifier: "./tools/oxlint/anti-slop/effect/index.ts",
      },
      { name: "complexity", specifier: "oxlint-plugin-complexity" },
    ],
    options: { typeAware: true, typeCheck: true },
    overrides: [
      ...effectConfigResult.overrides,
      {
        files: ["packages/domain/**"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                {
                  group: [
                    "@vektorprogrammet/db",
                    "@vektorprogrammet/db/*",
                    "apps/*",
                  ],
                  message:
                    "The domain is pure and must not depend on the database or application layer.",
                },
                ...restrictedSourcePatterns,
              ],
            },
          ],
        },
      },
      {
        // Effect's dual static map APIs are misread as native array callbacks with a thisArg.
        files: [
          "packages/domain/test/organisation/admission.test.ts",
          "packages/domain/test/content/staticContent.test.ts",
          "tools/import/test/support/databases.ts",
          "tools/import/src/transform/legacyPath.ts",
          "apps/web/src/components/Footer.tsx",
          "apps/web/src/components/ContactPage.tsx",
          "apps/web/src/components/NewsList.tsx",
          "apps/web/src/components/Header.tsx",
          "packages/db/test/repositories.pglite.test.ts",
          "packages/domain/src/files/commands.ts",
          "apps/web/test/publicFiles.test.ts",
          "apps/web/src/components/forms.tsx",
          "apps/web/src/server/redirects.ts",
          "apps/web/src/routes/index.tsx",
          "tools/import/src/report.ts",
          "apps/web/src/server/errors.ts",
          "apps/web/test/sandbox.test.ts",
          "tools/import/test/support/fixture.ts",
          "apps/web/src/server/panel.ts",
          "packages/domain/test/content/article.test.ts",
          "apps/web/test/contact.test.ts",
          "apps/web/src/server/pages.ts",
          "tools/import/src/target.ts",
          "tools/import/test/roundTrip.test.ts",
          "apps/web/src/server/runtime.ts",
          "packages/domain/test/support/inMemory.ts",
          "tools/import/src/files.ts",
          "apps/web/test/support/memory.ts",
          "packages/db/src/repositories/outbox.ts",
          "tools/import/src/transform/plan.ts",
          "apps/web/alchemy.run.ts",
          "apps/web/test/news.test.ts",
        ],
        rules: {
          "unicorn/no-array-method-this-argument": "off",
        },
      },
      {
        // These Effect Schema declarations intentionally export both a runtime value and same-named type.
        files: [
          "packages/domain/src/content/sanitizer.ts",
          "packages/domain/src/organisation/fieldOfStudy.ts",
          "packages/domain/src/content/sponsor.ts",
          "packages/domain/src/organisation/department.ts",
          "packages/domain/src/files/publicFile.ts",
          "packages/domain/src/organisation/admission.ts",
          "packages/db/src/repositories/outbox.ts",
          "packages/domain/src/shared/validation.ts",
          "packages/domain/src/content/socialEvent.ts",
          "packages/domain/src/contact/supportTicket.ts",
          "packages/domain/src/content/staticContent.ts",
          "packages/domain/src/shared/outbox.ts",
          "packages/domain/src/shared/errors.ts",
          "packages/domain/src/shared/actor.ts",
          "tools/import/src/config.ts",
          "apps/web/src/server/deployment.ts",
          "packages/domain/src/shared/ids.ts",
          "packages/domain/src/content/slug.ts",
          "tools/import/src/legacy/rows.ts",
          "packages/domain/src/content/article.ts",
          "packages/domain/src/audit/auditLog.ts",
          "packages/domain/src/shared/capabilities.ts",
          "tools/import/src/report.ts",
          "packages/db/src/schema.ts",
          "packages/domain/src/organisation/commands.ts",
          "packages/domain/src/organisation/semester.ts",
          "packages/domain/src/files/fileType.ts",
        ],
        rules: {
          "no-redeclare": "off",
        },
      },
      {
        // These framework entry callbacks return the Effect runtime's Promise; requiring async wrappers conflicts with the Effect async-function rule.
        files: [
          "apps/web/src/functions/public.functions.ts",
          "apps/web/src/components/forms.tsx",
          "apps/web/src/routes/filer/$key.ts",
          "apps/web/src/routes/kontakt/index.tsx",
          "apps/web/src/functions/panel.functions.ts",
          "apps/web/src/routes/nyhet/$slug.tsx",
          "apps/web/src/routes/nyheter/index.tsx",
          "apps/web/src/routes/nyheter/$department.tsx",
          "apps/web/src/routes/kontakt/avdeling/$id.tsx",
          "apps/web/src/server.ts",
        ],
        rules: {
          "typescript/promise-function-async": "off",
        },
      },
      {
        // Schema.TaggedError class definitions are falsely treated as throw sites by Unicorn.
        files: ["tools/import/src/config.ts"],
        rules: {
          "unicorn/throw-new-error": "off",
        },
      },
    ],
    rules: {
      ...effectConfigResult.rules,
      ...tsgoRules,
      ...localAntiSlopRules,
      "complexity/complexity": ["error", { cognitive: 15 }],
      "no-restricted-imports": [
        "error",
        { patterns: restrictedSourcePatterns },
      ],
      // Workspace modules consistently use lower camelCase filenames.
      "unicorn/filename-case": ["error", { case: "camelCase" }],
      "vite-plus/prefer-vite-plus-imports": "error",
    },
  },
  run: { cache: true },
  staged: { "*": "vp check --fix" },
});
