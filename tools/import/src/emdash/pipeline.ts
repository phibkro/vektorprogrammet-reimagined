import { Array as Arr, DateTime, Effect, Layer, Schema } from "effect";
import type { Redacted } from "effect";

/**
 * The CMS import program and the Layers it runs on. `cms.ts` (the CLI), `test/support/importFixtureCms.ts` and
 * the tests run the same `runCmsImport`.
 *
 *   LegacySource (MySQL snapshot)
 *     → planEmDashContent (pure)
 *     → writeContent (CmsClient: create → publish, rerunnable) + read-back
 *     → buildEmDashReport + writeEmDashReport (JSON + Markdown)
 *
 * It does not touch PostgreSQL: the two targets have their own lifecycles (the PostgreSQL import truncates and
 * reloads; this one only creates what the CMS lacks).
 */
import { ContentLive } from "../../../../apps/web/src/adapters/db/content.ts";
import { DatabaseLive } from "../../../../apps/web/src/adapters/db/databaseLive.ts";
import { LegacySource, legacyMysqlLayer } from "../legacy/source.ts";
import { planEmDashContent } from "./plan.ts";
import { buildEmDashReport, writeEmDashReport } from "./report.ts";
import { writeContent } from "./write.ts";

/** The CMS refused entries: the report says which collections and why, and the import is not complete. */
class CmsImportIncomplete extends Schema.TaggedError<
  CmsImportIncomplete,
  { readonly brand: unique symbol }
>()("CmsImportIncomplete", {
  refused: Schema.Int,
  report: Schema.String,
}) {}

export const runCmsImport = Effect.fn("runCmsImport")(function* runCmsImport(
  reportDirectory: string
) {
  const source = yield* LegacySource;
  const snapshot = yield* source.snapshot;
  const importedAt = yield* DateTime.now;
  const plan = planEmDashContent(snapshot, importedAt);
  const results = yield* writeContent(plan);
  const report = buildEmDashReport(plan, results);
  const written = yield* writeEmDashReport(reportDirectory, report);

  const refused = Arr.reduce(
    report.collections,
    0,
    (total, collection) => total + collection.rejected
  );

  if (refused > 0) {
    return yield* new CmsImportIncomplete({
      refused,
      report: written.markdown,
    });
  }

  return { report, written };
});

/** Legacy source and CMS client, from explicit connection settings. */
export const cmsImportLayer = (options: {
  readonly legacyMysqlUrl: Redacted.Redacted;
  readonly databaseUrl: Redacted.Redacted;
}) =>
  Layer.mergeAll(
    LegacySource.layer.pipe(
      Layer.provide(legacyMysqlLayer(options.legacyMysqlUrl))
    ),
    ContentLive.pipe(Layer.provide(DatabaseLive({ url: options.databaseUrl })))
  );
