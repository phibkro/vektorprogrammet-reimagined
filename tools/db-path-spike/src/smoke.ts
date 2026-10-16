/**
 * The smoke command of spec 0000: `bun src/smoke.ts --url https://<worker>` (or `SPIKE_URL`)
 * sends HTTP requests to the deployed spike Worker, prints one line per check (PASS or
 * FAIL, with evidence) and exits 0 only if every check passes. The same command becomes the
 * smoke test against a deployed preview.
 */
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Console, DateTime, Effect, Random, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import { FetchHttpClient } from "effect/http";

import { checks, runCheck } from "./smoke/checks.ts";
import type { Run } from "./smoke/checks.ts";
import { SpikeClient } from "./smoke/client.ts";
import { failedIds, renderLine, renderSummary } from "./smoke/report.ts";

/** At least one check failed; the lines above say which and why. */
class ChecksFailed extends Schema.TaggedError<
  ChecksFailed,
  { readonly brand: unique symbol }
>()("ChecksFailed", {
  failed: Schema.Array(Schema.String),
}) {}

/** A run id no earlier run shares, and a base year (an integer column) for its semester rows. */
const newRun = Effect.gen(function* newRun() {
  const high = yield* Random.nextIntBetween(0, 2 ** 31 - 1);
  const low = yield* Random.nextIntBetween(0, 2 ** 31 - 1);
  const year = yield* Random.nextIntBetween(1000, 2_000_000_000);

  return {
    id: `run-${high.toString(36)}${low.toString(36)}`,
    year,
  } satisfies Run;
});

const command = Command.make(
  "db-path-smoke",
  {
    url: Flag.String("url").pipe(
      Flag.withDescription("Base URL of the deployed spike Worker"),
      Flag.withFallbackConfig(Config.String("SPIKE_URL"))
    ),
  },
  Effect.fn(function* smoke({ url }) {
    const run = yield* newRun;
    const startedAt = yield* DateTime.now;

    yield* Console.log("slice 0000 database-path spike");
    yield* Console.log(
      `worker ${new URL(url).host} · run ${run.id} · ${DateTime.formatIso(startedAt)}`
    );

    const lines = yield* Effect.forEach(checks(run), (check) =>
      runCheck(check).pipe(Effect.tap((line) => Console.log(renderLine(line))))
    ).pipe(Effect.provide(SpikeClient.layer(url)));

    yield* Console.log(renderSummary(lines));

    const failed = failedIds(lines);

    return yield* failed.length === 0
      ? Effect.void
      : Effect.fail(new ChecksFailed({ failed }));
  })
).pipe(
  Command.withDescription(
    "Run the slice 0000 database-path checks against a deployed spike Worker"
  )
);

BunRuntime.runMain({ disableErrorReporting: true })(
  command.pipe(
    Command.run({ version: "0.0.0" }),
    Effect.provide([BunServices.layer, FetchHttpClient.layer])
  )
);
