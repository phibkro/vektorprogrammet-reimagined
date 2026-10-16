/**
 * Makes `require()` of a Node built-in in the Worker bundle an ESM import.
 *
 * Alchemy's Cloudflare target asks rolldown for that conversion (`builtin:esm-external-require`,
 * https://rolldown.rs/builtin-plugins/esm-external-require) when the Worker has `nodejs_compat`. Without it a
 * CommonJS dependency that the bundle inlines keeps rolldown's `__require` shim, which throws in an ES module
 * Worker (https://rolldown.rs/in-depth/bundling-cjs#require-external-modules). EmDash's Hyperdrive adapter inlines
 * `pg`, which requires `events`, `util`, `net`, `tls`, `crypto` and more, so the deployed CMS answered every request
 * with 500: `Calling `require` for "events" in an environment that doesn't expose the `require` function`.
 *
 * Why the conversion did not happen: rolldown recognises a builtin plugin by an `instanceof` check on the class of
 * the copy that runs the build, and treats an instance from another copy as a plugin without hooks. Bun installs
 * `vite-plus-core` (Vite and rolldown) twice here, because `astro` and `@alchemy.run/frontend-frameworks` are given
 * different `esbuild` peers: Alchemy built the plugin from the copy its runtime resolves, and Astro builds with
 * the other. Alchemy's own Worker bundler describes this failure and its cure (`Sources/Rolldown.ts`, alchemy-run
 * issue 880): rebuild the plugin from its options with the copy that builds. It does not do that on the Astro path,
 * so this plugin does, for every environment the Worker bundle comes from. `vite` here is the copy `astro` builds
 * with, because both are installed for this workspace. `scripts/checkBundle.ts` runs the bundle in workerd, so a
 * regrouped install that undoes this fails `bun run check:cms` instead of the deploy.
 */
import { Array as Arr, Schema } from "effect";
import { esmExternalRequirePlugin } from "vite";
import type { EnvironmentOptions, Plugin } from "vite";

const PLUGIN_NAME = "builtin:esm-external-require";

type RolldownPlugins = NonNullable<
  NonNullable<EnvironmentOptions["build"]>["rolldownOptions"]
>["plugins"];

/** A builtin plugin instance as rolldown keeps it: its name, and the options it was constructed with. */
const ExternalRequire = Schema.Struct({
  _options: Schema.Struct({
    external: Schema.Array(Schema.Union([Schema.String, Schema.instanceOf(RegExp)])),
    skipDuplicateCheck: Schema.optionalKey(Schema.Boolean),
  }),
  name: Schema.Literal(PLUGIN_NAME),
});

const isExternalRequire = Schema.is(ExternalRequire);

const fromThisCopy = (plugins: RolldownPlugins): RolldownPlugins => {
  if (Arr.isArray(plugins)) {
    return Arr.map(plugins, fromThisCopy);
  }

  if (!isExternalRequire(plugins)) {
    return plugins;
  }

  const { external, skipDuplicateCheck = false } = plugins._options;

  return esmExternalRequirePlugin({
    external: [...external],
    skipDuplicateCheck,
  });
};

export const ownExternalRequire = (): Plugin => ({
  configEnvironment(name, options) {
    const rolldownOptions = options.build?.rolldownOptions;

    // The browser build never gets the plugin; every other environment may.
    if (name !== "client" && rolldownOptions?.plugins !== undefined) {
      rolldownOptions.plugins = fromThisCopy(rolldownOptions.plugins);
    }
  },
  // After Alchemy's own plugin (`enforce: "pre"`) has added its instance.
  enforce: "post",
  name: "cms:own-esm-external-require",
});
