/**
 * The reconciliation report (architecture §6): rows in and out per table,
 * quarantined rows with reasons, collapsed semesters, missing files and broken
 * references. It is attached to pull requests and shared with the operator, so
 * it holds ids, counts, column names and upload areas only: no names, e-mail
 * addresses, file names or free text from the legacy data.
 *
 * It contains no timestamp either: the same source gives a byte-identical
 * report, which is how reruns are compared.
 *
 * The Schemas below are the report's contract: the plan builds values of these
 * types, and consumers decode `reconciliation.json` with `ReportFromJson`.
 */
import { TargetTable, Term } from "@vektorprogrammet/domain";
import { Array as Arr, Effect, Schema } from "effect";

import {
  ReportWriteError,
  markdownTable,
  writeReportFiles,
} from "./reportFiles.ts";
import { DROPPED_COLUMNS, TARGET_TABLES } from "./transform/plan.ts";
import type { ImportPlan } from "./transform/plan.ts";

export const QuarantinedRow = Schema.Struct({
  /** The legacy id (`articleId:departmentId` for tags, the row id for static content). */
  id: Schema.String,
  /** Column names and ids only, never values. */
  reasons: Schema.Array(Schema.String),
  table: TargetTable,
});

export type QuarantinedRow = typeof QuarantinedRow.Type;

export const CollapsedSemester = Schema.Struct({
  collapsedIds: Schema.Array(Schema.Int),
  keptId: Schema.Int,
  term: Term,
  year: Schema.Int,
});

export type CollapsedSemester = typeof CollapsedSemester.Type;

export const MissingFileReference = Schema.Struct({
  /** Upload directory, never the file name. */
  area: Schema.String,
  field: Schema.String,
  /** `missing-file-N`, numbered by sorted path, so references to one file group together. */
  file: Schema.String,
  id: Schema.String,
  table: TargetTable,
});

export type MissingFileReference = typeof MissingFileReference.Type;

export const BrokenReference = Schema.Struct({
  field: Schema.String,
  id: Schema.String,
  kind: Schema.Literals([
    "absent-row",
    "quarantined-row",
    "unmappable-file",
    "not-a-legacy-file",
  ]),
  table: TargetTable,
  /** The referenced table, or the upload area for files. */
  target: Schema.String,
  targetId: Schema.NullOr(Schema.String),
});

export type BrokenReference = typeof BrokenReference.Type;

export const Normalisation = Schema.Struct({
  change: Schema.String,
  field: Schema.String,
  id: Schema.String,
  table: TargetTable,
});

export type Normalisation = typeof Normalisation.Type;

export const FileSource = Schema.Literals(["directory", "none"]);

export type FileSource = typeof FileSource.Type;

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const ReconciliationReport = Schema.Struct({
  brokenReferences: Schema.Array(BrokenReference),
  collapsedSemesters: Schema.Array(CollapsedSemester),
  droppedColumns: Schema.Array(
    Schema.Struct({
      column: Schema.String,
      reason: Schema.String,
      table: Schema.String,
    })
  ),
  /** `none`: no legacy file copy was given, so every referenced file is missing. */
  fileSource: FileSource,
  files: Schema.Struct({ pathsSharingContent: Count, registered: Count }),
  formatVersion: Schema.Literal(2),
  missingFiles: Schema.Struct({
    distinctFiles: Count,
    references: Schema.Array(MissingFileReference),
  }),
  normalisations: Schema.Array(Normalisation),
  quarantine: Schema.Array(QuarantinedRow),
  tables: Schema.Array(
    Schema.Struct({
      quarantined: Count,
      rowsIn: Count,
      rowsOut: Count,
      source: Schema.String,
      table: TargetTable,
    })
  ),
});

export type ReconciliationReport = typeof ReconciliationReport.Type;

/** Decodes `reconciliation.json`. */
export const ReportFromJson = Schema.fromJsonString(ReconciliationReport);

const ReportJsonString = Schema.fromJsonString(ReconciliationReport, {
  space: 2,
});

/** Assembles the report from the plan and the row counts read back from the target. */
export const buildReport = (
  plan: ImportPlan,
  rowsOut: Readonly<Record<TargetTable, number>>,
  fileSource: FileSource
): ReconciliationReport => ({
  brokenReferences: plan.brokenReferences,
  collapsedSemesters: plan.collapsedSemesters,
  droppedColumns: DROPPED_COLUMNS,
  fileSource,
  files: {
    pathsSharingContent: plan.pathsSharingContent,
    registered: plan.rows.public_file.length,
  },
  formatVersion: 2,
  missingFiles: {
    distinctFiles: new Set(
      Arr.map(plan.missingFiles, (reference) => reference.file)
    ).size,
    references: plan.missingFiles,
  },
  normalisations: plan.normalisations,
  quarantine: plan.quarantine,
  tables: Arr.map(TARGET_TABLES, ({ table, source }) => ({
    quarantined: Arr.filter(plan.quarantine, (row) => row.table === table)
      .length,
    rowsIn: plan.rowsIn[table],
    rowsOut: rowsOut[table],
    source,
    table,
  })),
});

const renderMarkdown = (report: ReconciliationReport): string =>
  Arr.join(
    [
      "# Legacy import: reconciliation report",
      "",
      `File source: **${report.fileSource}**${
        report.fileSource === "none"
          ? " (no legacy file copy was given; every referenced file is reported missing)"
          : ""
      }. Ids are legacy ids. This report holds no personal data.`,
      "",
      "## Rows per table",
      "",
      markdownTable(
        ["Target table", "Legacy source", "Rows in", "Rows out", "Quarantined"],
        Arr.map(report.tables, (t) => [
          t.table,
          t.source,
          t.rowsIn,
          t.rowsOut,
          t.quarantined,
        ])
      ),
      "## Quarantined rows",
      "",
      markdownTable(
        ["Table", "Id", "Reasons"],
        Arr.map(report.quarantine, (row) => [
          row.table,
          row.id,
          Arr.join(row.reasons, "; "),
        ])
      ),
      "## Collapsed semesters",
      "",
      markdownTable(
        ["Term", "Year", "Kept id", "Collapsed ids"],
        Arr.map(report.collapsedSemesters, (s) => [
          s.term,
          s.year,
          s.keptId,
          Arr.join(Arr.map(s.collapsedIds, String), ", "),
        ])
      ),
      `## Missing files (${report.missingFiles.distinctFiles} distinct)`,
      "",
      markdownTable(
        ["File", "Area", "Table", "Id", "Field"],
        Arr.map(report.missingFiles.references, (m) => [
          m.file,
          m.area,
          m.table,
          m.id,
          m.field,
        ])
      ),
      "## Broken references",
      "",
      markdownTable(
        ["Table", "Id", "Field", "Kind", "Target", "Target id"],
        Arr.map(report.brokenReferences, (b) => [
          b.table,
          b.id,
          b.field,
          b.kind,
          b.target,
          b.targetId ?? "",
        ])
      ),
      "## Files",
      "",
      `Registered public files: ${report.files.registered}. Legacy paths whose bytes equal an earlier path (no redirect row of their own): ${report.files.pathsSharingContent}.`,
      "",
      "## Normalisations",
      "",
      markdownTable(
        ["Table", "Id", "Field", "Change"],
        Arr.map(report.normalisations, (n) => [
          n.table,
          n.id,
          n.field,
          n.change,
        ])
      ),
      "## Dropped legacy columns",
      "",
      markdownTable(
        ["Legacy table", "Column", "Reason"],
        Arr.map(report.droppedColumns, (d) => [d.table, d.column, d.reason])
      ),
    ],
    "\n"
  );

const encodeReportJson = Schema.encodeEffect(ReportJsonString);

/** Writes `reconciliation.json` and `reconciliation.md` into `directory` (created if needed). */
export const writeReport = Effect.fn("writeReport")(function* writeReport(
  directory: string,
  report: ReconciliationReport
) {
  const json = yield* encodeReportJson(report).pipe(
    Effect.mapError((cause) => new ReportWriteError({ cause }))
  );

  return yield* writeReportFiles(directory, "reconciliation", {
    json,
    markdown: renderMarkdown(report),
  });
});
