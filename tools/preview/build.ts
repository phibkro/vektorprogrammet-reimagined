import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Config, Effect, Redacted } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { readReceipt } from "./contracts.ts";

const program = Effect.gen(function* buildPreview() {
  const receipt = yield* readReceipt();
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const path = yield* Config.String("PATH");
  const home = yield* Config.String("HOME");

  const child = yield* spawner.spawn(
    ChildProcess.make("bunx", ["vp", "-C", "apps/web", "build"], {
      env: {
        HOME: home,
        PATH: path,
        SITE_URL: receipt.siteUrl,
        SUPABASE_PUBLISHABLE_KEY: Redacted.value(receipt.publishableKey),
        SUPABASE_URL: receipt.supabaseUrl,
      },
      extendEnv: false,
      stderr: "inherit",
      stdin: "ignore",
      stdout: "inherit",
    })
  );

  if ((yield* child.exitCode) !== ChildProcessSpawner.ExitCode(0)) {
    return yield* Effect.die("Preview build failed");
  }

  return yield* Effect.void;
}).pipe(Effect.scoped);

NodeRuntime.runMain(
  program.pipe(
    Effect.provide(NodeServices.layer),
    Effect.catchCause(() =>
      Effect.die("Preview build failed; inspect the private build log.")
    )
  )
);
