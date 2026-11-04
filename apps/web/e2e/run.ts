/**
 * Run against an isolated local Supabase project, configured with tools/prototype/with-env.sh.
 * Before running, migrate and import the synthetic organisation fixture into that same Supabase
 * database, run prototype:setup, seedExtra.ts and tools/prototype/seed.ts, then set
 * E2E_DISPOSABLE=1 and E2E_MAILPIT_URL. The CI workflow performs these steps.
 * E2E_BASE_URL optionally reuses an already-running local Worker instead of starting one.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Redacted, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { startStack } from "./support/stack.ts";

class BrowserTestsFailed extends Schema.TaggedError<
  BrowserTestsFailed,
  { readonly brand: unique symbol }
>()("BrowserTestsFailed", {
  exitCode: Schema.Int,
}) {}

const webDirectory = new URL("..", import.meta.url).pathname;

const main = Effect.gen(function* main() {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const { databaseUrl, origin, publicFileKey } =
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
          E2E_DATABASE_URL: Redacted.value(databaseUrl),
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

NodeRuntime.runMain(main.pipe(Effect.provide(NodeServices.layer)));
