/**
 * `bun test/support/importFixtureCms.ts`: imports the FAKE legacy fixture (`fixture.ts`) into the CMS named by
 * `IMPORT_CMS_URL`, with the same `runCmsImport` and `cmsImportLayer` that `cms.ts` runs. `LegacyTestDatabase`
 * loads the fixture into a throwaway MySQL database first and drops it afterwards, so nothing of the backup is
 * involved.
 *
 * `apps/web/e2e` and the Preview data setup (`apps/cms/README.md`) start their CMS content this way: the public
 * pages are checked on content that went through the importer, not on hand-made entries.
 */
import { NodeRuntime } from "@effect/platform-node";
import { Array as Arr, Console, Effect, FileSystem, Layer } from "effect";

import { CmsTargetConfig } from "../../src/emdash/config.ts";
import { cmsImportLayer, runCmsImport } from "../../src/emdash/pipeline.ts";
import { nodeServicesLayer } from "../../src/nodeServices.ts";
import { LegacyTestDatabase } from "./databases.ts";

const importFixture = Effect.gen(function* importFixture() {
  const fs = yield* FileSystem.FileSystem;
  const legacy = yield* LegacyTestDatabase;
  const target = yield* CmsTargetConfig;
  const reportDirectory = yield* fs.makeTempDirectoryScoped();

  const { report } = yield* runCmsImport(reportDirectory).pipe(
    Effect.provide(cmsImportLayer({ ...target, legacyMysqlUrl: legacy.url }))
  );

  const counts = Arr.map(
    report.collections,
    ({ collection, rowsIn, drafted, published, unchanged }) =>
      `${collection} ${drafted + published} created, ${unchanged} already there, of ${rowsIn}`
  );

  yield* Console.log(
    `fixture imported into the CMS: ${Arr.join(counts, "; ")}`
  );

  return yield* Effect.void;
}).pipe(
  Effect.scoped,
  Effect.provide(
    LegacyTestDatabase.layer.pipe(Layer.provideMerge(nodeServicesLayer))
  )
);

NodeRuntime.runMain(importFixture);
