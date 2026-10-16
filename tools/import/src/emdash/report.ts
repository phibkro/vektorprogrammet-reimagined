/**
 * The CMS reconciliation report (spec 0005, falsifier 4): per collection, the legacy rows in, the rows the plan
 * quarantined, what the run created, published and left alone, what the CMS refused, and the collection's
 * published and draft counts read back from the CMS. It is attached to pull requests, so like the PostgreSQL
 * report it holds counts, legacy ids, column names and CMS error codes only: no titles, names, URLs or text.
 *
 * It has no timestamp and no CMS address, so the same outcome gives a byte-identical report. A rerun of the
 * same import differs in exactly the counts that show it changed nothing: `created` 0, `unchanged` all.
 */
import { Array as Arr, Effect, Schema } from "effect";

import {
  ReportWriteError,
  markdownTable,
  writeReportFiles,
} from "../reportFiles.ts";
import { CMS_COLLECTIONS } from "./plan.ts";
import type { EmDashPlan } from "./plan.ts";
import type { WrittenContent } from "./write.ts";

const Collection = Schema.Literals(
  Arr.map(CMS_COLLECTIONS, ({ collection }) => collection)
);

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const EmDashReport = Schema.Struct({
  collections: Schema.Array(
    Schema.Struct({
      collection: Collection,
      /** Created and left as drafts (legacy drafts). */
      drafted: Count,
      /** After the run, read back from the CMS. */
      inCms: Schema.Struct({ draft: Count, published: Count }),
      /** Created and published. */
      published: Count,
      quarantined: Count,
      rejected: Count,
      rowsIn: Count,
      source: Schema.String,
      /** The slug existed already, so the entry was left as it is. */
      unchanged: Count,
    })
  ),
  danglingDepartmentTags: Count,
  /** Department cities that were not yet options of `news.departments` and now are. */
  departmentOptionsAdded: Count,
  /** Images the CMS does not get: the legacy files are not copied. */
  droppedImages: Schema.Struct({
    articles: Count,
    richText: Count,
    sponsors: Count,
  }),
  formatVersion: Schema.Literal(1),
  quarantine: Schema.Array(
    Schema.Struct({
      collection: Collection,
      id: Schema.String,
      reasons: Schema.Array(Schema.String),
    })
  ),
  rejections: Schema.Array(
    Schema.Struct({
      code: Schema.String,
      collection: Collection,
      id: Schema.String,
      operation: Schema.Literals(["create", "publish"]),
    })
  ),
});

export type EmDashReport = typeof EmDashReport.Type;

export const EmDashReportFromJson = Schema.fromJsonString(EmDashReport);

const encodeReportJson = Schema.encodeEffect(
  Schema.fromJsonString(EmDashReport, { space: 2 })
);

/** Assembles the report from the plan and what the writer did. */
export const buildEmDashReport = (
  plan: EmDashPlan,
  { collections, departmentOptionsAdded }: WrittenContent
): EmDashReport => ({
  collections: Arr.map(CMS_COLLECTIONS, ({ collection, source }) => ({
    collection,
    drafted: collections[collection].drafted,
    inCms: collections[collection].inCms,
    published: collections[collection].published,
    quarantined: Arr.filter(
      plan.quarantine,
      (row) => row.collection === collection
    ).length,
    rejected: collections[collection].rejections.length,
    rowsIn: plan.rowsIn[collection],
    source,
    unchanged: collections[collection].unchanged,
  })),
  danglingDepartmentTags: plan.danglingDepartmentTags,
  departmentOptionsAdded,
  droppedImages: plan.droppedImages,
  formatVersion: 1,
  quarantine: plan.quarantine,
  rejections: Arr.flatMap(
    CMS_COLLECTIONS,
    ({ collection }) => collections[collection].rejections
  ),
});

const renderMarkdown = (report: EmDashReport): string =>
  Arr.join(
    [
      "# Legacy import into the CMS: reconciliation report",
      "",
      "Ids are legacy ids. This report holds no personal data: counts, ids, column names and CMS error codes only.",
      "",
      "## Entries per collection",
      "",
      markdownTable(
        [
          "Collection",
          "Legacy source",
          "Rows in",
          "Quarantined",
          "Created as drafts",
          "Created and published",
          "Already there",
          "Refused by the CMS",
          "In the CMS: published",
          "In the CMS: drafts",
        ],
        Arr.map(report.collections, (c) => [
          c.collection,
          c.source,
          c.rowsIn,
          c.quarantined,
          c.drafted,
          c.published,
          c.unchanged,
          c.rejected,
          c.inCms.published,
          c.inCms.draft,
        ])
      ),
      "## Quarantined rows",
      "",
      markdownTable(
        ["Collection", "Id", "Reasons"],
        Arr.map(report.quarantine, (row) => [
          row.collection,
          row.id,
          Arr.join(row.reasons, "; "),
        ])
      ),
      "## Refused by the CMS",
      "",
      markdownTable(
        ["Collection", "Id", "Operation", "CMS error code"],
        Arr.map(report.rejections, (r) => [
          r.collection,
          r.id,
          r.operation,
          r.code,
        ])
      ),
      "## Images not imported",
      "",
      `The legacy files are not copied, so images are left out. Articles with an image: ${report.droppedImages.articles}; images in rich text: ${report.droppedImages.richText}; sponsors with a logo: ${report.droppedImages.sponsors}.`,
      "",
      "## Department tags",
      "",
      `Tags that name a department the legacy data does not have: ${report.danglingDepartmentTags}. Department cities added as options of the \`departments\` field of \`news\`: ${report.departmentOptionsAdded}.`,
      "",
    ],
    "\n"
  );

/** Writes `emdash-reconciliation.json` and `emdash-reconciliation.md` into `directory`. */
export const writeEmDashReport = Effect.fn("writeEmDashReport")(
  function* writeEmDashReport(directory: string, report: EmDashReport) {
    const json = yield* encodeReportJson(report).pipe(
      Effect.mapError((cause) => new ReportWriteError({ cause }))
    );

    return yield* writeReportFiles(directory, "emdash-reconciliation", {
      json,
      markdown: renderMarkdown(report),
    });
  }
);
