/**
 * `bun test/support/importFixtureCms.ts`: imports the FAKE legacy fixture (`fixture.ts`) into the CMS named by
 * `IMPORT_CMS_URL`, with the same `runCmsImport` and `cmsImportLayer` that `cms.ts` runs. `LegacyTestDatabase`
 * loads the fixture into a throwaway MySQL database first and drops it afterwards, so nothing of the backup is
 * involved.
 *
 * `apps/web/e2e` and the Preview data setup (`apps/cms/README.md`) start their CMS content this way: the public
 * pages are checked on content that went through the importer, not on hand-made entries.
 */
import { Array as Arr, Console, Effect } from "effect";

import { CmsTargetConfig } from "../../src/emdash/config.ts";
import { cmsImportLayer, runCmsImport } from "../../src/emdash/pipeline.ts";
import { runOnFixture } from "./fixtureScript.ts";

runOnFixture(({ legacyMysqlUrl, reportDirectory }) =>
  Effect.gen(function* importFixture() {
    const target = yield* CmsTargetConfig;

    const { report } = yield* runCmsImport(reportDirectory).pipe(
      Effect.provide(cmsImportLayer({ ...target, legacyMysqlUrl }))
    );

    const counts = Arr.map(
      report.collections,
      ({ collection, rowsIn, drafted, published, unchanged }) =>
        `${collection} ${drafted + published} created, ${unchanged} already there, of ${rowsIn}`
    );

    yield* Console.log(
      `fixture imported into the CMS: ${Arr.join(counts, "; ")}`
    );
  })
);
