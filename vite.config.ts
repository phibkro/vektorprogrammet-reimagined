import { effectNative, strict } from "@effect/tsgo/oxlint-presets";
import { effect } from "@phibkro/oxlint-effect-plugin";
import type { EffectConfigInput } from "@phibkro/oxlint-effect-plugin";
import ultraciteFmt from "ultracite/oxfmt";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import shadcn from "ultracite/oxlint/shadcn";
import { defineConfig } from "vite-plus";

import { diagnosticRules } from "./tools/quality/diagnosticRules.ts";

export const tsgoRules = diagnosticRules.lint;

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
      files: [
        "apps/web/src/components/**",
        "apps/web/src/lib/**",
        "apps/web/src/routes/*.tsx",
        "apps/web/src/routes/kontrollpanel/semestre.tsx",
        "apps/web/src/routes/kontrollpanel/sponsorer.tsx",
        "apps/web/src/routes/kontrollpanel/statisk-innhold.tsx",
        "apps/web/src/routes/kontrollpanel/avdelinger.tsx",
        "apps/web/src/routes/kontrollpanel/linjer.tsx",
        "apps/web/src/routes/kontrollpanel/arrangementer.tsx",
        "apps/web/src/routes/kontrollpanel/artikler.tsx",
        "apps/web/src/routes/kontrollpanel/index.tsx",
        "apps/web/src/routes/kontrollpanel/route.tsx",
        "apps/web/src/routes/nyhet/**",
        "apps/web/src/routes/filer/**",
        "apps/web/src/routes/kontakt/*.tsx",
        "apps/web/src/routes/nyheter/**",
        "apps/web/src/routes/team/**",
        "apps/web/src/functions/**",
        "apps/web/src/router.tsx",
        "apps/web/src/start.ts",
        "apps/web/src/server/actor.ts",
        "apps/web/src/server/publicFiles.ts",
        "apps/web/src/server/redirects.ts",
        "apps/web/src/server/fileStore.ts",
        "apps/web/src/server/senders.ts",
        "apps/web/src/server/errors.ts",
        "apps/web/src/server/webCrypto.ts",
        "apps/web/src/server/rateLimit.ts",
        "apps/web/src/server/panel.ts",
        "apps/web/src/server/shell.ts",
        "apps/web/src/server/site/**",
        "apps/web/src/server/turnstile.ts",
        "apps/web/src/server/outboxDelivery.ts",
        "apps/web/src/server/contact.ts",
        "apps/web/src/server/transactor.ts",
        "apps/web/src/server/scope.ts",
        "apps/web/src/server/deployment.ts",
        "apps/web/src/server/env.ts",
        "apps/web/src/server/outcomeStatus.ts",
      ],
      platform: "portable",
      role: "application",
      strictness: "strict",
    },
    {
      files: [
        "apps/web/src/components/panel/testActorSwitch.tsx",
        "apps/web/src/components/ui/sidebar.tsx",
        "apps/web/src/hooks/**",
      ],
      platform: "browser",
      role: "application",
      strictness: "strict",
    },
    {
      files: [
        "apps/web/src/server.ts",
        "apps/web/src/server/runtime.ts",
        "apps/web/src/server/contactPost.ts",
      ],
      platform: "portable",
      role: "composition-root",
      strictness: "strict",
    },
    {
      files: ["apps/web/src/routes/kontakt/avdeling/$id.tsx"],
      platform: "portable",
      role: "composition-root",
      strictness: "strict",
    },
    {
      files: ["tools/import/src/**"],
      platform: "node",
      role: "composition-root",
      strictness: "strict",
    },
    {
      files: ["tools/docgen/src/main.ts"],
      platform: "node",
      role: "composition-root",
      strictness: "strict",
    },
    {
      files: ["tools/docgen/src/render.ts"],
      platform: "portable",
      role: "application",
      strictness: "strict",
    },
    {
      files: ["tools/db-path-spike/src/worker.ts"],
      platform: "portable",
      role: "composition-root",
      strictness: "strict",
    },
    {
      files: [
        "tools/db-path-spike/src/worker/**",
        "tools/db-path-spike/src/protocol.ts",
        "tools/db-path-spike/src/fixtures.ts",
        "tools/db-path-spike/src/verdicts.ts",
      ],
      platform: "portable",
      role: "application",
      strictness: "strict",
    },
    {
      files: ["tools/db-path-spike/src/smoke.ts"],
      platform: "bun",
      role: "composition-root",
      strictness: "strict",
    },
    {
      files: [
        "tools/db-path-spike/src/schema.ts",
        "tools/db-path-spike/alchemy.run.ts",
        "tools/db-path-spike/drizzle.config.ts",
      ],
      platform: "node",
      role: "composition-root",
      strictness: "strict",
    },
    {
      files: ["tools/db-path-spike/src/smoke/**"],
      platform: "node",
      role: "application",
      strictness: "strict",
    },
    {
      files: ["tools/import/test/roundTrip.test.ts"],
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
      files: [
        "packages/cms-client/test/collections.test.ts",
        "apps/web/test/textSlots.test.ts",
        "tools/docgen/test/render.test.ts",
      ],
      platform: "node",
      role: "composition-root",
      strictness: "strict",
    },
    {
      boundaries: ["external-data"],
      files: ["packages/cms-client/src/**"],
      platform: "portable",
      role: "runtime-adapter",
      strictness: "strict",
    },
    {
      files: ["packages/cms-client/scripts/**"],
      platform: "node",
      role: "composition-root",
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
    // The router-generated tree is recreated during development and builds. The EmDash client and the OpenAPI
    // subset it comes from are generated by `packages/cms-client/scripts/generate.ts`; formatting them would make
    // the next regeneration differ from what is committed.
    ignorePatterns: [
      ...(ultraciteFmt.ignorePatterns ?? []),
      "apps/web/src/routeTree.gen.ts",
      "packages/cms-client/openapi/**",
      "packages/cms-client/src/generated.ts",
    ],
  },
  lint: {
    extends: [core, antiSlop, shadcn, strict, effectNative],
    // Preserve the existing generated route-tree exclusion; the generated EmDash client is not ours to restyle.
    ignorePatterns: [
      ...(core.ignorePatterns ?? []),
      "apps/web/src/routeTree.gen.ts",
      "packages/cms-client/src/generated.ts",
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
        // The domain's Effect Schema declarations intentionally export both a runtime value and a same-named type (TypeScript itself rejects every other redeclaration).
        files: [
          "packages/domain/src/**",
          "packages/db/src/repositories/outbox.ts",
          "tools/import/src/config.ts",
          "apps/web/src/server/deployment.ts",
          "tools/import/src/legacy/rows.ts",
          "tools/import/src/report.ts",
          "packages/db/src/schema.ts",
          "packages/cms-client/src/portableText.ts",
          "packages/cms-client/src/collections.ts",
          "packages/cms-client/src/client.ts",
          "packages/cms-client/scripts/subset.ts",
          "tools/import/src/emdash/report.ts",
          "tools/import/src/emdash/write.ts",
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
          "apps/web/src/routes/kontakt/*.tsx",
          "apps/web/src/functions/panel.functions.ts",
          "apps/web/src/routes/nyhet/$slug.tsx",
          "apps/web/src/routes/nyheter/index.tsx",
          "apps/web/src/routes/kontakt/avdeling/$id.tsx",
          "apps/web/src/server/panel.ts",
          "apps/web/src/routes/*.tsx",
          "apps/web/src/routes/team/**",
          "apps/web/src/routes/kontrollpanel/**",
          "apps/web/src/server.ts",
        ],
        rules: {
          "typescript/promise-function-async": "off",
        },
      },
      {
        // unicorn/throw-new-error treats Schema.TaggedError class definitions as throw sites; they contain no throw.
        files: [
          "packages/domain/src/shared/errors.ts",
          "tools/import/src/config.ts",
          "tools/import/src/legacy/source.ts",
          "tools/import/src/files.ts",
          "tools/import/src/target.ts",
          "tools/import/src/report.ts",
          "tools/quality/checkEffectExceptions.ts",
          "tools/db-path-spike/src/worker.ts",
          "tools/db-path-spike/src/worker/checks.ts",
          "tools/db-path-spike/src/worker/http.ts",
          "tools/db-path-spike/src/smoke.ts",
          "tools/db-path-spike/src/smoke/refused.ts",
          "apps/web/e2e/run.ts",
          "apps/web/e2e/support/devServer.ts",
          "apps/web/e2e/support/command.ts",
          "packages/cms-client/src/client.ts",
          "packages/cms-client/scripts/generate.ts",
          "tools/import/src/reportFiles.ts",
          "tools/import/src/emdash/pipeline.ts",
          "apps/cms/scripts/checkBundle.ts",
        ],
        rules: {
          "unicorn/throw-new-error": "off",
        },
      },
      {
        // max-classes-per-file conflicts with the single closed typed-error set owned here.
        files: ["packages/domain/src/shared/errors.ts"],
        rules: { "max-classes-per-file": "off" },
      },
      {
        // Effect Data tagged variants use this exact empty payload representation; the type rule resolves it to {}.
        files: [
          "packages/domain/src/shared/capabilities.ts",
          "tools/import/src/transform/legacyPath.ts",
        ],
        rules: { "typescript/no-generated-empty-object-type": "off" },
      },
      {
        // Promise lint misreads Effect.catch, Effect.flatMap and Effect.catchIf callbacks as native Promise chains.
        files: [
          "packages/db/src/classifySqlFailure.ts",
          "packages/db/src/transactional.ts",
          "tools/db-path-spike/src/worker/checks.ts",
          "tools/db-path-spike/src/worker/http.ts",
          "tools/db-path-spike/src/smoke/client.ts",
        ],
        rules: { "promise/prefer-await-to-callbacks": "off" },
      },
      {
        // Drizzle rows remain unknown until Schema.decodeUnknownEffect validates them at this adapter boundary.
        files: ["packages/db/src/internal/drizzle.ts"],
        rules: { "anti-slop/no-unknown-parameters": "off" },
      },
      {
        // Drizzle's SQL error wrapper is foreign; this classifier narrows its unknown input with isSqlError and Cause guards.
        files: ["packages/db/src/classifySqlFailure.ts"],
        rules: { "anti-slop/no-unknown-parameters": "off" },
      },
      {
        // The command endpoint and the input decoders own untrusted request decoding through the command's schema; this rule cannot see decodeInput inside the boundary.
        files: [
          "packages/domain/src/kernel/commands.ts",
          "packages/domain/src/shared/validation.ts",
        ],
        rules: { "anti-slop/no-unknown-parameters": "off" },
      },
      {
        // Context.Service contracts are grouped by bounded context; max-classes-per-file would fragment these service modules.
        files: [
          "packages/domain/src/content/services.ts",
          "packages/domain/src/files/services.ts",
          "packages/domain/src/organisation/services.ts",
          "packages/domain/src/teams/services.ts",
        ],
        rules: { "max-classes-per-file": "off" },
      },
      {
        // These documented workspace entry points intentionally re-export their public API.
        files: [
          "packages/db/src/index.ts",
          "packages/domain/src/index.ts",
          "packages/cms-client/src/index.ts",
        ],
        rules: { "oxc/no-barrel-file": "off" },
      },
      {
        // The transport error types and service form one cohesive adapter contract.
        files: [
          "apps/web/src/server/senders.ts",
          "packages/cms-client/src/client.ts",
        ],
        rules: { "max-classes-per-file": "off" },
      },
      {
        // Each importer seam co-locates one service with its typed error class.
        files: [
          "tools/import/src/legacy/source.ts",
          "tools/import/src/files.ts",
          "tools/import/src/target.ts",
        ],
        rules: { "max-classes-per-file": "off" },
      },
      {
        // One integration fixture module owns both independently scoped database services.
        files: ["tools/import/test/support/databases.ts"],
        rules: { "max-classes-per-file": "off" },
      },
      {
        // Each synthetic SQL row stays beside the quarantine reason it is designed to exercise.
        files: ["tools/import/test/support/fixture.ts"],
        rules: { "no-inline-comments": "off" },
      },
      {
        // promise/prefer-await-to-then and typescript/promise-function-async conflict with effecttsgo/async-function at TanStack, React, Playwright-runner and Miniflare Promise ABIs.
        files: [
          "apps/web/src/server.ts",
          "apps/web/src/server/runtime.ts",
          "apps/web/src/server/contactPost.ts",
          "apps/web/src/routes/kontakt/avdeling/$id.tsx",
          "apps/web/src/server/fileStore.ts",
          "apps/web/src/server/rateLimit.ts",
          "apps/web/src/server/senders.ts",
          "apps/web/src/server/webCrypto.ts",
          "apps/web/src/routes/*.tsx",
          "apps/web/src/routes/team/**",
          "apps/web/src/routes/nyheter/index.tsx",
          "apps/web/src/routes/filer/$key.ts",
          "apps/web/src/routes/nyhet/$slug.tsx",
          "apps/web/src/routes/kontrollpanel/**",
          "apps/web/src/routes/kontakt/*.tsx",
          "apps/web/src/components/forms.tsx",
          "apps/web/src/components/panel/testActorSwitch.tsx",
          "apps/web/src/server/outcomeStatus.ts",
          "tools/db-path-spike/src/worker.ts",
          "apps/web/e2e/support/probes.ts",
          "apps/cms/scripts/checkBundle.ts",
        ],
        rules: {
          "promise/prefer-await-to-callbacks": "off",
          "promise/prefer-await-to-then": "off",
          "typescript/promise-function-async": "off",
        },
      },
      {
        // The Web Crypto adapter implements Effect's Crypto service using the Worker runtime capability.
        files: ["apps/web/src/server/webCrypto.ts"],
        rules: { "effect/no-ambient-authority": "off" },
      },
      {
        // TanStack loaders signal not-found, redirects and page failures by throwing host control-flow objects.
        files: [
          "apps/web/src/lib/outcome.ts",
          "apps/web/src/routes/kontakt/avdeling/$id.tsx",
        ],
        rules: {
          "effect/no-untyped-throw": "off",
          "typescript/only-throw-error": "off",
        },
      },
      {
        // shadcn's `useSidebar` throws when it is used outside its provider: a React hook contract that only a thrown error (caught by the route's error boundary) can state.
        files: ["apps/web/src/components/ui/sidebar.tsx"],
        rules: { "effect/no-untyped-throw": "off" },
      },
      {
        // failureOf is a synchronous pure serialization boundary over an already typed error union.
        files: ["apps/web/src/server/errors.ts"],
        rules: { "effecttsgo/schema-sync": "off" },
      },
      {
        // Effect.promise takes a thunk. typescript/promise-function-async needs that thunk to be async, while effecttsgo/async-function rejects every async function, so the two rules cannot both hold at a Promise boundary. Test files only: they drive platform Promise surfaces (Response bodies, the SendEmail binding, AbortController, Playwright's browser API).
        files: [
          "apps/web/test/contact.test.ts",
          "apps/web/test/errors.test.ts",
          "apps/web/test/organisationPanel.test.ts",
          "apps/web/test/support/run.ts",
          "apps/web/test/site.test.ts",
          "apps/web/test/panel.test.ts",
          "apps/web/test/publicFiles.test.ts",
          "apps/web/test/redirects.test.ts",
          "apps/web/test/sandbox.test.ts",
          "tools/db-path-spike/test/support/localWorker.ts",
          "tools/db-path-spike/test/worker.postgres.test.ts",
          "tools/db-path-spike/test/pure.test.ts",
          "apps/web/e2e/journey.spec.ts",
          "apps/web/e2e/shell.spec.ts",
          "apps/web/e2e/support/panel.ts",
          "apps/web/e2e/public.spec.ts",
          "apps/web/e2e/support/editor.ts",
        ],
        rules: { "effecttsgo/async-function": "off" },
      },
      {
        // RULE-133 tests feed hostile addresses (a javascript: link) to the Portable Text view to prove it refuses them.
        files: ["apps/web/test/portableTextView.test.tsx"],
        rules: { "no-script-url": "off" },
      },
      {
        // Schema.TaggedError's class factory is the established Effect error constructor, not a thrown unconstructed error.
        files: [
          "apps/web/src/lib/outcome.ts",
          "apps/web/src/server/errors.ts",
          "apps/web/src/server/senders.ts",
        ],
        rules: { "unicorn/throw-new-error": "off" },
      },
      {
        // Effect Array.sort is pure; Unicorn misclassifies the namespace call as native Array#sort.
        files: ["tools/import/src/transform/plan.ts"],
        rules: {
          "unicorn/no-array-sort": "off",
        },
      },
      {
        // Deferred.succeed requires an explicit void payload; dropping it returns a curried function.
        files: [
          "packages/db/test/concurrency.postgres.test.ts",
          "packages/db/test/transactions.postgres.test.ts",
        ],
        rules: {
          "unicorn/no-useless-undefined": "off",
        },
      },
      {
        // shadcn/ui components are generated by `shadcn add`; they stay verbatim so future `shadcn add` upgrades apply cleanly.
        files: ["apps/web/src/components/ui/**"],
        rules: {
          "func-style": "off",
          "no-use-before-define": "off",
        },
      },
      {
        // TanStack Router derives route paths from file names (for example statisk-innhold.tsx and $slug.tsx); renaming would change URLs.
        files: ["apps/web/src/routes/**"],
        rules: {
          "unicorn/filename-case": "off",
        },
      },
      {
        // This test pins the JSON wire form of a failure. JSON.parse(JSON.stringify(...)) drops and coerces values that structuredClone keeps, so unicorn/prefer-structured-clone would replace the wire check with a weaker one.
        files: ["apps/web/test/errors.test.ts"],
        rules: { "unicorn/prefer-structured-clone": "off" },
      },
      {
        // Playwright actions on one page must run in order: every `fill` moves the focus, so filling fields concurrently types into the wrong ones, and a spec visits its pages one after another.
        files: [
          "apps/web/e2e/support/panel.ts",
          "apps/web/e2e/shell.spec.ts",
          "apps/web/e2e/public.spec.ts",
        ],
        rules: { "no-await-in-loop": "off" },
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
      // Preset contradiction: effecttsgo(prefer-effect-array) requires Effect's data-first Array module
      // (`Arr.map(xs, fn)`), which unicorn/no-array-method-this-argument misreads as a native
      // `.map(fn, thisArg)` call. Native array methods are already steered to Effect Array, so the rule
      // adds only false positives here. One global switch instead of a per-file list that drifts.
      "unicorn/no-array-method-this-argument": "off",
      "vite-plus/prefer-vite-plus-imports": "error",
    },
  },
  run: { cache: true },
  staged: { "*": "vp check --fix" },
});
