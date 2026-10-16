/**
 * The import program and the Layers it runs on. `main.ts` (the CLI) and the
 * round-trip test run the same `runImport` on the same `importLayer`, so the
 * test exercises the operator's code path against real MySQL and PostgreSQL.
 *
 *   LegacySource (MySQL snapshot)
 *     → resolveLegacyFiles (LegacyFiles + SHA-256)
 *     → planImport (pure)
 *     → ImportTarget.replaceAll (one PostgreSQL transaction)
 *     → buildReport + writeReport (JSON + Markdown)
 */
import { Effect, Layer, Option } from "effect";
import type { Redacted } from "effect";

import { LegacyFiles, resolveLegacyFiles } from "./files.ts";
import { LegacySource, legacyMysqlLayer } from "./legacy/source.ts";
import { buildReport, writeReport } from "./report.ts";
import { ImportTarget, targetPgLayer } from "./target.ts";
import { planImport, referencedFilePaths } from "./transform/plan.ts";

export const runImport = Effect.fn("runImport")(function* runImport(
  reportDirectory: string
) {
  const source = yield* LegacySource;
  const files = yield* LegacyFiles;
  const target = yield* ImportTarget;

  const snapshot = yield* source.snapshot;
  const index = yield* resolveLegacyFiles(referencedFilePaths(snapshot));
  const plan = planImport(snapshot, index);
  const rowsOut = yield* target.replaceAll(plan.rows);
  const report = buildReport(plan, rowsOut, files.source);
  const written = yield* writeReport(reportDirectory, report);

  return { report, written };
});

/** Source, file source and target, from explicit connection settings. */
export const importLayer = (options: {
  readonly legacyMysqlUrl: Redacted.Redacted;
  readonly targetUrl: Redacted.Redacted;
  readonly legacyFilesDir: Option.Option<string>;
}) =>
  Layer.mergeAll(
    LegacySource.layer.pipe(
      Layer.provide(legacyMysqlLayer(options.legacyMysqlUrl))
    ),
    ImportTarget.layer.pipe(Layer.provide(targetPgLayer(options.targetUrl))),
    Option.match(options.legacyFilesDir, {
      onNone: () => LegacyFiles.none,
      onSome: LegacyFiles.fromDirectory,
    })
  );
