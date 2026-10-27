/** Bundle a test Worker and own its Miniflare process for the test scope. */
import { Effect } from "effect";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

import { COMPATIBILITY_DATE, COMPATIBILITY_FLAGS } from "../../worker.config";

export const testWorker = Effect.fn("testWorker")(function* testWorker(
  source: string,
  bindings: Readonly<Record<string, string>> = {}
) {
  const bundle = yield* Effect.tryPromise(() =>
    build({
      bundle: true,
      conditions: ["workerd", "worker", "browser"],
      entryPoints: [new URL(source, import.meta.url).pathname],
      external: ["node:*", "cloudflare:*"],
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
              },
            ],
          })
        )
    ),
    (worker) => Effect.promise(() => worker.dispose())
  );
});
