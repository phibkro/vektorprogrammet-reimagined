/**
 * The legacy MySQL → CMS round trip: the FAKE fixture rows are read through the SELECT-only `legacy_reader`
 * from a per-run MySQL database, planned, and written through `runCmsImport` to an in-memory CMS
 * (`support/fakeCms.ts`). The real EmDash is exercised by the browser tests in `apps/web/e2e`, which run the
 * same program on the same fixture.
 */
import { assert, layer } from "@effect/vitest";
import { Array as Arr, Effect, FileSystem, Layer, Schema } from "effect";

import { runCmsImport } from "../src/emdash/pipeline.ts";
import { EmDashReportFromJson } from "../src/emdash/report.ts";
import { LegacySource, legacyMysqlLayer } from "../src/legacy/source.ts";
import { nodeServicesLayer } from "../src/nodeServices.ts";
import { LegacyTestDatabase } from "./support/databases.ts";
import { makeFakeCms } from "./support/fakeCms.ts";
import { PERSONAL_SENTINELS } from "./support/fixture.ts";

const Database = LegacyTestDatabase.layer.pipe(
  Layer.provideMerge(nodeServicesLayer)
);

/** Runs the import once against `cms`; returns the report and the report files' text. */
const importOnce = Effect.fn("importOnce")(function* importOnce(
  cms: ReturnType<typeof makeFakeCms>
) {
  const fs = yield* FileSystem.FileSystem;
  const legacy = yield* LegacyTestDatabase;
  const reportDir = yield* fs.makeTempDirectoryScoped();

  const { report, written } = yield* runCmsImport(reportDir).pipe(
    Effect.provide(
      Layer.mergeAll(
        LegacySource.layer.pipe(Layer.provide(legacyMysqlLayer(legacy.url))),
        cms.layer
      )
    )
  );

  return {
    json: yield* fs.readFileString(written.json),
    markdown: yield* fs.readFileString(written.markdown),
    report,
  };
});

layer(Database, { excludeTestServices: true, timeout: "120 seconds" })(
  "legacy MySQL → CMS round trip",
  (it) => {
    it.effect(
      "moves the fixture's articles, texts and sponsors into the CMS, quarantining what breaks a rule (D5)",
      () =>
        Effect.gen(function* movesContent() {
          const cms = makeFakeCms();
          const { report } = yield* importOnce(cms);

          assert.deepStrictEqual(
            Arr.map(report.collections, (c) => [
              c.collection,
              c.rowsIn,
              c.quarantined,
              c.drafted,
              c.published,
              c.unchanged,
              c.rejected,
            ]),
            [
              ["news", 3, 0, 2, 1, 0, 0],
              ["texts", 3, 1, 0, 2, 0, 0],
              ["sponsors", 3, 2, 0, 1, 0, 0],
            ]
          );
          assert.deepStrictEqual(
            Arr.map(report.quarantine, ({ collection, id }) => [
              collection,
              id,
            ]),
            [
              ["texts", "2"],
              ["sponsors", "2"],
              ["sponsors", "3"],
            ]
          );
          assert.deepStrictEqual(report.droppedImages, {
            articles: 3,
            richText: 4,
            sponsors: 1,
          });
          assert.strictEqual(report.danglingDepartmentTags, 1);
          assert.strictEqual(report.departmentOptionsAdded, 2);
        }).pipe(Effect.scoped)
    );

    it.effect(
      "RULE-267: the live article is published and the drafts are not, and the original date is kept",
      () =>
        Effect.gen(function* keepsStatusAndDate() {
          const cms = makeFakeCms();
          yield* importOnce(cms);

          assert.deepStrictEqual(
            Arr.map(Arr.fromIterable(cms.news.stored), ([slug, { status }]) => [
              slug,
              status,
            ]),
            [
              ["opptak-apner", "published"],
              ["kladd", "draft"],
              ["uten-status", "draft"],
            ]
          );
        }).pipe(Effect.scoped)
    );

    it.effect(
      "a second run against the same CMS creates nothing (falsifier 4)",
      () =>
        Effect.gen(function* rerunsSafely() {
          const cms = makeFakeCms();
          const first = yield* importOnce(cms);
          const second = yield* importOnce(cms);

          assert.deepStrictEqual(
            [
              first.report.departmentOptionsAdded,
              second.report.departmentOptionsAdded,
            ],
            [2, 0]
          );

          assert.deepStrictEqual(
            Arr.map(second.report.collections, (c) => [
              c.collection,
              c.drafted + c.published,
              c.unchanged,
              c.inCms,
            ]),
            Arr.map(first.report.collections, (c) => [
              c.collection,
              0,
              c.drafted + c.published,
              c.inCms,
            ])
          );
        }).pipe(Effect.scoped)
    );

    it.effect(
      "the report holds ids and counts only: no names, titles, e-mails or file names",
      () =>
        Effect.gen(function* reportsNoPersonalData() {
          const { json, markdown, report } = yield* importOnce(makeFakeCms());

          for (const text of [json, markdown]) {
            for (const sentinel of PERSONAL_SENTINELS) {
              assert.notInclude(text, sentinel);
            }
          }

          assert.deepStrictEqual(
            yield* Schema.decodeEffect(EmDashReportFromJson)(json),
            report
          );
        }).pipe(Effect.scoped)
    );
  }
);
