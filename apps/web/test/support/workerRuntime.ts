/** Bundle a test Worker and own its Miniflare process for the test scope. */
import { builtinModules } from "node:module";

import { Effect } from "effect";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

import { COMPATIBILITY_DATE, COMPATIBILITY_FLAGS } from "../../worker.config";

/** What a test Worker may be given beyond plain bindings: a database, and the queues that Miniflare runs for real (spec 0008b). */
export interface WorkerOptions {
  readonly hyperdrives?: Readonly<Record<string, string>>;
  readonly queueConsumers?: Readonly<
    Record<
      string,
      {
        readonly deadLetterQueue?: string;
        readonly maxBatchSize?: number;
        readonly maxBatchTimeout?: number;
        readonly maxRetries?: number;
        readonly retryDelay?: number;
      }
    >
  >;
  readonly queueProducers?: Readonly<Record<string, string>>;
}

/**
 * A dependency such as `pg` imports Node's built-ins by their bare names, and the Workers runtime has them (with
 * `nodejs_compat`), so they stay external, as the real Worker's bundler (Vite) leaves them. `pg-native` is the optional
 * native driver that `pg` looks for in a `try`.
 */
const EXTERNAL = ["cloudflare:*", "node:*", "pg-native", ...builtinModules];

/**
 * Some of a Worker's dependencies are CommonJS and `require` a built-in at load (`postcss`, which `sanitize-html` loads, in
 * the domain's barrel). esbuild's ESM output turns that into a throwing shim unless a `require` is in scope, and the
 * Workers runtime's own is `createRequire`. The real Worker's bundler does the same job (`apps/cms/build/ownExternalRequire.ts`).
 */
const REQUIRE_BANNER = `import { createRequire } from "node:module"; const require = createRequire("file:///bundle/worker.mjs");`;

export const testWorker = Effect.fn("testWorker")(function* testWorker(
  source: string,
  bindings: Readonly<Record<string, string>> = {},
  options: WorkerOptions = {}
) {
  const bundle = yield* Effect.tryPromise(() =>
    build({
      banner: { js: REQUIRE_BANNER },
      bundle: true,
      conditions: ["workerd", "worker", "browser"],
      entryPoints: [new URL(source, import.meta.url).pathname],
      external: EXTERNAL,
      format: "esm",
      platform: "browser",
      target: "es2022",
      write: false,
    })
  ).pipe(Effect.orDie);

  const [entry] = bundle.outputFiles;

  if (entry === undefined) {
    return yield* Effect.die("the test Worker bundle has no entry");
  }

  return yield* Effect.acquireRelease(
    Effect.sync(
      () =>
        new Miniflare(
          convertV4MiniflareOptions({
            workers: [
              {
                bindings,
                compatibilityDate: COMPATIBILITY_DATE,
                compatibilityFlags: [
                  ...COMPATIBILITY_FLAGS,
                  "new_module_registry",
                ],
                modules: [
                  {
                    contents: entry.text,
                    path: "/test/worker.mjs",
                    type: "ESModule",
                  },
                ],
                modulesRoot: "/test",
                name: "test-worker",
                ...options,
              },
            ],
          })
        )
    ),
    (worker) => Effect.promise(() => worker.dispose())
  );
});
