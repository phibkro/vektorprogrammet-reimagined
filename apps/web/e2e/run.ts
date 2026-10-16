/**
 * `bun run e2e` (from `apps/web`): the browser tests, end to end. One scope owns everything the run starts and
 * releases it in reverse order, on success, failure and interruption alike:
 *
 *   disposable PostgreSQL database (migrated, seeded)  →  `vp dev` on a free port  →  `playwright test`
 *
 * Playwright and its Chromium come from devenv (`PLAYWRIGHT_BROWSERS_PATH`); the specs read the database
 * and the origin from the environment this program sets.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Random, Redacted, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { disposableDatabase } from "./support/database.ts";
import { startDevServer } from "./support/devServer.ts";

class BrowserTestsFailed extends Schema.TaggedError<
  BrowserTestsFailed,
  { readonly brand: unique symbol }
>()("BrowserTestsFailed", {
  exitCode: Schema.Int,
}) {}

const webDirectory = new URL("..", import.meta.url).pathname;

const main = Effect.gen(function* main() {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const databaseUrl = yield* disposableDatabase;
  const port = yield* Random.nextIntBetween(30_000, 50_000);
  const origin = yield* startDevServer({ databaseUrl, port, webDirectory });
  yield* Effect.log(`vp dev answers on ${origin}; starting the browser tests`);

  const playwright = yield* spawner.spawn(
    ChildProcess.make(
      "bunx",
      ["playwright", "test", "--config", "e2e/playwright.config.ts"],
      {
        cwd: webDirectory,
        env: {
          E2E_BASE_URL: origin,
          E2E_DATABASE_URL: Redacted.value(databaseUrl),
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

NodeRuntime.runMain(main.pipe(Effect.provide(NodeServices.layer)));
