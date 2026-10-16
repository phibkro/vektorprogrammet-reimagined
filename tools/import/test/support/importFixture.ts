/**
 * `bun test/support/importFixture.ts`: imports the FAKE legacy fixture (`fixture.ts`) into the migrated
 * PostgreSQL database named by `IMPORT_TARGET_DATABASE_URL`, with the same `runImport` and `importLayer` that
 * `main.ts` runs. `LegacyTestDatabase` loads the fixture into a throwaway MySQL database first and drops it
 * afterwards, so nothing of the backup is involved and `legacy` is never touched.
 *
 * `apps/web/e2e` starts its disposable database this way: the browser tests run on migrated data, whose
 * quirks (collapsed duplicate semesters, quarantined rows, legacy ids) are the importer's own.
 */
import { NodeRuntime } from "@effect/platform-node";
import {
  Array as Arr,
  Console,
  Effect,
  FileSystem,
  Layer,
  Option,
} from "effect";

import { ImportConfig, checkTarget } from "../../src/config.ts";
import { nodeServicesLayer } from "../../src/nodeServices.ts";
import { importLayer, runImport } from "../../src/pipeline.ts";
import { LegacyTestDatabase } from "./databases.ts";

const importFixture = Effect.gen(function* importFixture() {
  const fs = yield* FileSystem.FileSystem;
  const legacy = yield* LegacyTestDatabase;
  const config = yield* ImportConfig;
  const refused = checkTarget(config, false);

  if (Option.isSome(refused)) {
    return yield* refused.value;
  }

  const reportDirectory = yield* fs.makeTempDirectoryScoped();

  const { report } = yield* runImport(reportDirectory).pipe(
    Effect.provide(
      importLayer({
        legacyFilesDir: Option.none(),
        legacyMysqlUrl: legacy.url,
        targetUrl: config.targetUrl,
      })
    )
  );

  const counts = Arr.map(
    report.tables,
    ({ table, rowsIn, rowsOut }) => `${table} ${rowsOut}/${rowsIn}`
  );

  yield* Console.log(
    `fixture imported (rows out/in): ${Arr.join(counts, ", ")}`
  );

  return yield* Effect.void;
}).pipe(
  Effect.scoped,
  Effect.provide(
    LegacyTestDatabase.layer.pipe(Layer.provideMerge(nodeServicesLayer))
  )
);

NodeRuntime.runMain(importFixture);
