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
import { Term } from "@vektorprogrammet/domain";
import { Effect, FileSystem, Path, Schema } from "effect";
import {
  DROPPED_COLUMNS,
  type ImportPlan,
  TARGET_TABLES,
  type TargetTable as TargetTableName,
} from "./transform/plan.ts";

export const TargetTable: Schema.Codec<TargetTableName> = Schema.Literals(
  TARGET_TABLES.map(({ table }) => table),
);

export const QuarantinedRow = Schema.Struct({
  table: TargetTable,
  /** The legacy id (`articleId:departmentId` for tags, the row id for static content). */
  id: Schema.String,
  /** Column names and ids only, never values. */
  reasons: Schema.Array(Schema.String),
});
export type QuarantinedRow = typeof QuarantinedRow.Type;

export const CollapsedSemester = Schema.Struct({
  term: Term,
  year: Schema.Int,
  keptId: Schema.Int,
  collapsedIds: Schema.Array(Schema.Int),
});
export type CollapsedSemester = typeof CollapsedSemester.Type;

export const MissingFileReference = Schema.Struct({
  table: TargetTable,
  id: Schema.String,
  field: Schema.String,
  /** Upload directory, never the file name. */
  area: Schema.String,
  /** `missing-file-N`, numbered by sorted path, so references to one file group together. */
  file: Schema.String,
});
export type MissingFileReference = typeof MissingFileReference.Type;

export const BrokenReference = Schema.Struct({
  table: TargetTable,
  id: Schema.String,
  field: Schema.String,
  kind: Schema.Literals(["absent-row", "quarantined-row", "unmappable-file", "not-a-legacy-file"]),
  /** The referenced table, or the upload area for files. */
  target: Schema.String,
  targetId: Schema.NullOr(Schema.String),
});
export type BrokenReference = typeof BrokenReference.Type;

export const Normalisation = Schema.Struct({
  table: TargetTable,
  id: Schema.String,
  field: Schema.String,
  change: Schema.String,
});
export type Normalisation = typeof Normalisation.Type;

export const RowRef = Schema.Struct({ table: TargetTable, id: Schema.String });
export type RowRef = typeof RowRef.Type;

export const FileSource = Schema.Literals(["directory", "none"]);
export type FileSource = typeof FileSource.Type;

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const ReconciliationReport = Schema.Struct({
  formatVersion: Schema.Literal(1),
  /** `none`: no legacy file copy was given, so every referenced file is missing. */
  fileSource: FileSource,
  tables: Schema.Array(
    Schema.Struct({
      table: TargetTable,
      source: Schema.String,
      rowsIn: Count,
      rowsOut: Count,
      quarantined: Count,
    }),
  ),
  quarantine: Schema.Array(QuarantinedRow),
  collapsedSemesters: Schema.Array(CollapsedSemester),
  missingFiles: Schema.Struct({
    distinctFiles: Count,
    references: Schema.Array(MissingFileReference),
  }),
  brokenReferences: Schema.Array(BrokenReference),
  richText: Schema.Struct({
    /** Rows whose markup the sanitizer changed (RULE-133 replacement). */
    sanitizedRows: Schema.Array(RowRef),
    rewrittenReferences: Count,
  }),
  files: Schema.Struct({ registered: Count, pathsSharingContent: Count }),
  normalisations: Schema.Array(Normalisation),
  droppedColumns: Schema.Array(
    Schema.Struct({ table: Schema.String, column: Schema.String, reason: Schema.String }),
  ),
});
export type ReconciliationReport = typeof ReconciliationReport.Type;

/** Decodes `reconciliation.json`. */
export const ReportFromJson = Schema.fromJsonString(ReconciliationReport);

/** Assembles the report from the plan and the row counts read back from the target. */
export const buildReport = (
  plan: ImportPlan,
  rowsOut: Readonly<Record<TargetTableName, number>>,
  fileSource: FileSource,
): ReconciliationReport => ({
  formatVersion: 1,
  fileSource,
  tables: TARGET_TABLES.map(({ table, source }) => ({
    table,
    source,
    rowsIn: plan.rowsIn[table],
    rowsOut: rowsOut[table],
    quarantined: plan.quarantine.filter((row) => row.table === table).length,
  })),
  quarantine: plan.quarantine,
  collapsedSemesters: plan.collapsedSemesters,
  missingFiles: {
    distinctFiles: new Set(plan.missingFiles.map((reference) => reference.file)).size,
    references: plan.missingFiles,
  },
  brokenReferences: plan.brokenReferences,
  richText: { sanitizedRows: plan.sanitized, rewrittenReferences: plan.rewrittenReferences },
  files: {
    registered: plan.rows.public_file.length,
    pathsSharingContent: plan.pathsSharingContent,
  },
  normalisations: plan.normalisations,
  droppedColumns: DROPPED_COLUMNS,
});

const markdownTable = (
  header: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string | number>>,
): string =>
  rows.length === 0
    ? "None.\n"
    : [
        `| ${header.join(" | ")} |`,
        `| ${header.map(() => "---").join(" | ")} |`,
        ...rows.map((row) => `| ${row.join(" | ")} |`),
      ].join("\n") + "\n";

export const renderMarkdown = (report: ReconciliationReport): string =>
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
      report.tables.map((t) => [t.table, t.source, t.rowsIn, t.rowsOut, t.quarantined]),
    ),
    "## Quarantined rows",
    "",
    markdownTable(
      ["Table", "Id", "Reasons"],
      report.quarantine.map((row) => [row.table, row.id, row.reasons.join("; ")]),
    ),
    "## Collapsed semesters",
    "",
    markdownTable(
      ["Term", "Year", "Kept id", "Collapsed ids"],
      report.collapsedSemesters.map((s) => [s.term, s.year, s.keptId, s.collapsedIds.join(", ")]),
    ),
    `## Missing files (${report.missingFiles.distinctFiles} distinct)`,
    "",
    markdownTable(
      ["File", "Area", "Table", "Id", "Field"],
      report.missingFiles.references.map((m) => [m.file, m.area, m.table, m.id, m.field]),
    ),
    "## Broken references",
    "",
    markdownTable(
      ["Table", "Id", "Field", "Kind", "Target", "Target id"],
      report.brokenReferences.map((b) => [
        b.table,
        b.id,
        b.field,
        b.kind,
        b.target,
        b.targetId ?? "",
      ]),
    ),
    "## Rich text",
    "",
    `References rewritten to \`/filer/{key}\`: ${report.richText.rewrittenReferences}.`,
    "",
    "Rows whose markup the sanitizer changed (RULE-133 replacement):",
    "",
    markdownTable(
      ["Table", "Id"],
      report.richText.sanitizedRows.map((row) => [row.table, row.id]),
    ),
    "## Files",
    "",
    `Registered public files: ${report.files.registered}. Legacy paths whose bytes equal an earlier path (no redirect row of their own): ${report.files.pathsSharingContent}.`,
    "",
    "## Normalisations",
    "",
    markdownTable(
      ["Table", "Id", "Field", "Change"],
      report.normalisations.map((n) => [n.table, n.id, n.field, n.change]),
    ),
    "## Dropped legacy columns",
    "",
    markdownTable(
      ["Legacy table", "Column", "Reason"],
      report.droppedColumns.map((d) => [d.table, d.column, d.reason]),
    ),
  ].join("\n");

export class ReportWriteError extends Schema.TaggedError<ReportWriteError>()("ReportWriteError", {
  cause: Schema.Defect(),
}) {}

/** Writes `reconciliation.json` and `reconciliation.md` into `directory` (created if needed). */
export const writeReport = Effect.fn("writeReport")(function* (
  directory: string,
  report: ReconciliationReport,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files = {
    json: path.join(directory, "reconciliation.json"),
    markdown: path.join(directory, "reconciliation.md"),
  };
  yield* Effect.all([
    fs.makeDirectory(directory, { recursive: true }),
    fs.writeFileString(files.json, `${JSON.stringify(report, null, 2)}\n`),
    fs.writeFileString(files.markdown, renderMarkdown(report)),
  ]).pipe(Effect.mapError((cause) => new ReportWriteError({ cause })));
  return files;
});
