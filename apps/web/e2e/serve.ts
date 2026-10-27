/**
 * `bun e2e/serve.ts` (from `apps/web`): the browser-test stack of `support/stack.ts`, kept alive for someone to
 * drive by hand (the verification skill, `.agents/skills/verify-vektorprogrammet`). It is `run.ts` without
 * Playwright: one scope owns the disposable database, the CMS and `vp dev`, and releases them in reverse order when
 * the process is interrupted (SIGINT or SIGTERM, which `runMain` turns into interruption).
 *
 * `VERIFY_RUN_DIR` names a directory the run owns. Once the stack answers, this program writes there
 *  - `state.env`, what a reader needs to find the instance (origins, database URL, pid, public-file key), free of secrets, and
 *  - `secrets.env` (mode 0600), the CMS token that the specs read as `E2E_CMS_TOKEN`,
 * and then prints one `VERIFY READY` line, the marker a supervisor waits for.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import {
  Array as Arr,
  Config,
  Console,
  Effect,
  FileSystem,
  Path,
  Redacted,
} from "effect";

import { startStack } from "./support/stack.ts";

const webDirectory = new URL("..", import.meta.url).pathname;

const main = Effect.gen(function* main() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runDirectory = yield* Config.String("VERIFY_RUN_DIR");

  const { cms, databaseUrl, origin, publicFileKey } =
    yield* startStack(webDirectory);

  yield* fs.makeDirectory(runDirectory, { recursive: true });
  yield* fs.writeFileString(
    path.join(runDirectory, "secrets.env"),
    `E2E_CMS_TOKEN=${Redacted.value(cms.token)}\n`,
    { mode: 0o600 }
  );
  yield* fs.writeFileString(
    path.join(runDirectory, "state.env"),
    Arr.join(
      [
        `VERIFY_PID=${process.pid}`,
        `E2E_BASE_URL=${origin}`,
        `E2E_CMS_URL=${cms.origin}`,
        `E2E_DATABASE_URL=${Redacted.value(databaseUrl)}`,
        `E2E_PUBLIC_FILE_KEY=${publicFileKey}`,
        "",
      ],
      "\n"
    )
  );

  yield* Console.log(`VERIFY READY origin=${origin} cms=${cms.origin}`);

  return yield* Effect.never;
}).pipe(Effect.scoped);

NodeRuntime.runMain(main.pipe(Effect.provide(NodeServices.layer)));
