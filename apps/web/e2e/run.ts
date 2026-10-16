/**
 * `bun run e2e` (from `apps/web`): the browser tests, end to end. One scope owns everything the run starts and
 * releases it in reverse order, on success, failure and interruption alike:
 *
 *   disposable PostgreSQL database (migrated, seeded by the importer)
 *     →  the CMS (`astro dev` on the database's schema `emdash`, its default copy, the importer's fixture, twice)
 *     →  `vp dev` on a free port, reading that database and that CMS
 *     →  `playwright test`
 *
 * Playwright and its Chromium come from devenv (`PLAYWRIGHT_BROWSERS_PATH`); the specs read the database,
 * the CMS and the origin from the environment this program sets.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Random, Redacted, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { startCms, importFixtureTwice } from "./support/cms.ts";
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
  // Two ranges, so the two servers can never draw the same port.
  const cmsPort = yield* Random.nextIntBetween(30_000, 40_000);
  const cms = yield* startCms({ databaseUrl, port: cmsPort });
  yield* Effect.log(`the CMS answers on ${cms.origin}; importing the fixture`);
  yield* importFixtureTwice(cms);

  const port = yield* Random.nextIntBetween(40_000, 50_000);

  const origin = yield* startDevServer({
    cms,
    databaseUrl,
    port,
    webDirectory,
  });

  yield* Effect.log(`vp dev answers on ${origin}; starting the browser tests`);

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
          E2E_CMS_TOKEN: Redacted.value(cms.token),
          E2E_CMS_URL: cms.origin,
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
