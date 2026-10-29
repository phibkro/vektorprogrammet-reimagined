/**
 * `bun run e2e` (from `apps/web`): the browser tests, end to end. One scope owns everything the run starts and
 * releases it in reverse order, on success, failure and interruption alike: the stack of `support/stack.ts`
 * (disposable PostgreSQL database, the CMS, `vp dev`), then `playwright test` on top of it.
 *
 * Playwright and its Chromium come from devenv (`PLAYWRIGHT_BROWSERS_PATH`); the specs read the database,
 * the CMS and the origin from the environment this program sets.
 */
import { NodeRuntime } from "@effect/platform-node";
import { Effect, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { stackServices, startStack } from "./support/stack.ts";

class BrowserTestsFailed extends Schema.TaggedError<
  BrowserTestsFailed,
  { readonly brand: unique symbol }
>()("BrowserTestsFailed", {
  exitCode: Schema.Int,
}) {}

const webDirectory = new URL("..", import.meta.url).pathname;

const main = Effect.gen(function* main() {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const { cms, databaseUrl, origin, publicFileKey } =
    yield* startStack(webDirectory);

  yield* Effect.log("starting the browser tests");

  const playwright = yield* spawner.spawn(
    ChildProcess.make(
      "bunx",
      [
        "playwright",
        "test",
        "--config",
        "e2e/playwright.config.ts",
        ...process.argv.slice(2),
      ],
      {
        cwd: webDirectory,
        env: {
          E2E_BASE_URL: origin,
          E2E_CMS_TOKEN: cms.token,
          E2E_CMS_URL: cms.origin,
          E2E_DATABASE_URL: databaseUrl,
          E2E_PUBLIC_FILE_KEY: publicFileKey,
        },
        extendEnv: true,
        stderr: "inherit",
        stdin: "ignore",
        stdout: "inherit",
      }
    )
  );

  const exitCode = yield* playwright.exitCode;

  if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
    return yield* new BrowserTestsFailed({ exitCode });
  }

  return yield* Effect.void;
}).pipe(Effect.scoped);

NodeRuntime.runMain(main.pipe(Effect.provide(stackServices)));
