/**
 * `bun run db:seed:local`: seeds the local people (`localSeed.ts`) into `SEED_TARGET_DATABASE_URL`, or `DATABASE_URL`
 * (the devenv database) when that is not set. The browser tests run it after the importer's fixture, against their
 * disposable database.
 */
import { NodeRuntime } from "@effect/platform-node";
import { Config, Console, Effect } from "effect";

import { DatabaseLive } from "../../src/databaseLive.ts";
import { seedLocal } from "./localSeed.ts";

const target = Config.Redacted("SEED_TARGET_DATABASE_URL").pipe(
  Config.orElse(() => Config.Redacted("DATABASE_URL"))
);

const program = Effect.gen(function* program() {
  const url = yield* target;

  const seeded = yield* seedLocal.pipe(
    Effect.provide(DatabaseLive({ maxConnections: 2, url }))
  );

  return yield* Console.log(
    `seeded ${seeded.people} people in ${seeded.department}`
  );
});

NodeRuntime.runMain(program);
