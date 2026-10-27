import { NodeRuntime } from "@effect/platform-node";
import { TestDatabaseUrl, migratedTestDatabase, withClient } from "@vektorprogrammet/db/testing";
import { ReadOnlyDatabaseUrl, readOnlyRole } from "@vektorprogrammet/db/testing/read-only-role";
import { Console, Effect } from "effect";

import { adminGrantsAndErrors, filters, readOnlyProbe, singleHandle, transactions } from "./behaviour.ts";
import { report, strategies } from "./compare.ts";
import { pgliteEnvironment, postgresEnvironment } from "./harness.ts";
import { seedProductionVolume } from "./seed.ts";

const target = process.env["SPIKE_TARGET"] ?? "pglite";
const scenario = process.env["SPIKE_SCENARIO"] ?? "report";

const run = (explain: boolean, outside: Parameters<typeof transactions>[0]) =>
  Effect.gen(function* run() {
    yield* Console.log(`target=${target} scenario=${scenario}`);
    yield* Console.log(yield* seedProductionVolume);
    if (scenario === "report") {
      yield* report(explain);
    } else if (scenario === "behaviour") {
      yield* Console.log("== transactions");
      yield* transactions(outside);
      yield* Console.log("== filters");
      yield* filters;
      yield* Console.log("== admin grants (timestamps, aliases) and the error channel");
      yield* adminGrantsAndErrors;
      yield* Console.log("== one handle for everything");
      yield* singleHandle;
    } else if (scenario === "strategy") {
      yield* strategies(explain);
    }
  });

const program =
  target === "pglite"
    ? run(false, undefined).pipe(Effect.provide(pgliteEnvironment))
    : Effect.gen(function* postgresProgram() {
        const url = yield* TestDatabaseUrl;
        const outside = (name: string) =>
          withClient(url, (client) =>
            client.unsafe<{ n: number }>(`select count(*)::int as n from team where name = '${name}'`)
          ).pipe(Effect.map((rows) => rows[0]?.n ?? -1), Effect.orDie);
        yield* run(true, outside).pipe(Effect.provide(postgresEnvironment(url)));
        if (scenario === "readonly") {
          const readOnly = yield* ReadOnlyDatabaseUrl;
          yield* Console.log("== reads through the SELECT-only role");
          yield* Effect.gen(function* asReader() {
            yield* report(false);
            yield* readOnlyProbe;
          }).pipe(Effect.provide(postgresEnvironment(readOnly)));
        }
      }).pipe(Effect.provide(readOnlyRole), Effect.provide(migratedTestDatabase));

NodeRuntime.runMain(Effect.scoped(program));
