/**
 * What the two reconciliation reports (`report.ts` for PostgreSQL, `emdash/report.ts` for the CMS) share: the
 * Markdown table and the writer that puts a report's JSON and Markdown into the report directory.
 */
import { Array as Arr, Effect, FileSystem, Path, Schema } from "effect";

export const markdownTable = (
  header: readonly string[],
  rows: readonly (readonly (string | number)[])[]
): string =>
  rows.length === 0
    ? "None.\n"
    : `${Arr.join(
        [
          `| ${Arr.join(header, " | ")} |`,
          `| ${Arr.join(
            Arr.map(header, () => "---"),
            " | "
          )} |`,
          ...Arr.map(
            rows,
            (row) => `| ${Arr.join(Arr.map(row, String), " | ")} |`
          ),
        ],
        "\n"
      )}\n`;

export class ReportWriteError extends Schema.TaggedError<
  ReportWriteError,
  { readonly brand: unique symbol }
>()("ReportWriteError", {
  cause: Schema.Defect(),
}) {}

/** Writes `<name>.json` and `<name>.md` into `directory` (created if needed). */
export const writeReportFiles = Effect.fn("writeReportFiles")(
  function* writeReportFiles(
    directory: string,
    name: string,
    contents: { readonly json: string; readonly markdown: string }
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const files = {
      json: path.join(directory, `${name}.json`),
      markdown: path.join(directory, `${name}.md`),
    };

    yield* Effect.all([
      fs.makeDirectory(directory, { recursive: true }),
      fs.writeFileString(files.json, `${contents.json}\n`),
      fs.writeFileString(files.markdown, contents.markdown),
    ]).pipe(Effect.mapError((cause) => new ReportWriteError({ cause })));

    return files;
  }
);
