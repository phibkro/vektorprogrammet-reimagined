/** Run against the local Supabase instance configured by tools/prototype/with-env.sh. */
import { Config, Effect, Option, Redacted } from "effect";

import { startDevServer } from "./devServer.ts";
import { seedPublicFile } from "./publicFile.ts";

export const startStack = Effect.fn("startStack")(function* startStack(
  webDirectory: string
) {
  const disposable = yield* Config.String("E2E_DISPOSABLE");

  if (disposable !== "1") {
    return yield* Effect.die(
      new Error(
        "Browser tests mutate their target; set E2E_DISPOSABLE=1 only for an isolated synthetic stack"
      )
    );
  }

  const databaseUrl = yield* Config.Redacted("DATABASE_URL");
  const apiUrl = yield* Config.String("SUPABASE_URL");

  for (const address of [Redacted.value(databaseUrl), apiUrl]) {
    const parsed = new URL(address);

    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) ||
      parsed.search ||
      parsed.hash
    ) {
      return yield* Effect.die(
        new Error("Browser tests require direct local Supabase URLs")
      );
    }
  }

  const existingOrigin = yield* Config.option(Config.String("E2E_BASE_URL"));

  const origin = Option.isSome(existingOrigin)
    ? existingOrigin.value
    : yield* startDevServer({ databaseUrl, port: 3000, webDirectory });

  const target = new URL(origin);

  if (
    target.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) ||
    target.search ||
    target.hash
  ) {
    return yield* Effect.die(
      new Error("Browser tests require a direct local application URL")
    );
  }

  const publicFileKey = yield* seedPublicFile(databaseUrl);

  return { databaseUrl, origin, publicFileKey };
});
