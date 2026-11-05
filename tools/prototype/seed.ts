import { NodeRuntime } from "@effect/platform-node";
import { Config, Effect, Redacted } from "effect";

import { seedProvider } from "./seedProvider.ts";

const program = Effect.gen(function* program() {
  const url = yield* Config.String("SUPABASE_URL");
  const secret = yield* Config.Redacted("SUPABASE_SECRET_KEY");
  const publishable = yield* Config.Redacted("SUPABASE_PUBLISHABLE_KEY");
  const database = yield* Config.Redacted("DATABASE_URL");

  // Defence in depth for direct invocations that bypass with-env.sh.
  for (const value of [url, Redacted.value(database)]) {
    const parsed = new URL(value);

    if (
      !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
      parsed.search ||
      parsed.hash
    ) {
      return yield* Effect.die("Refusing non-local prototype target");
    }
  }

  return yield* seedProvider(url, secret, publishable, database);
});

NodeRuntime.runMain(program);
