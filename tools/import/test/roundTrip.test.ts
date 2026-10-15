/**
 * The legacy MySQL → PostgreSQL round trip, against real databases: a per-run
 * MySQL database loaded with the legacy table definitions and FAKE rows, read
 * through the SELECT-only `legacy_reader`, and a per-run PostgreSQL database
 * migrated with `packages/db`'s migrations. Both are dropped afterwards.
 *
 * The first scenario runs the CLI composition root (`bun src/main.ts`) as the
 * operator does; the others run the same `runImport` on the same `importLayer`.
 */
import { NodeServices } from "@effect/platform-node";
import { PgClient } from "@effect/sql-pg";
import { assert, layer } from "@effect/vitest";
import {
  Config,
  Crypto,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
  Schema,
  Stream,
} from "effect";
import { encode as hexEncode } from "effect/encoding/Hex";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { importLayer, runImport } from "../src/pipeline.ts";
import { type ReconciliationReport, ReportFromJson } from "../src/report.ts";
import { TARGET_TABLES, type TargetTable } from "../src/transform/plan.ts";
import { LegacyTestDatabase, TargetTestDatabase } from "./support/databases.ts";
import { ARTICLE_1_BODY, FAKE_FILES, PERSONAL_SENTINELS } from "./support/fixture.ts";

const IMPORT_DIR = new URL("..", import.meta.url);

const Databases = Layer.mergeAll(LegacyTestDatabase.layer, TargetTestDatabase.layer).pipe(
  Layer.provideMerge(NodeServices.layer),
);

/** Runs the import in-process; returns the report and the report files' text. */
const importOnce = Effect.fn("importOnce")(function* (legacyFilesDir: Option.Option<string>) {
  const fs = yield* FileSystem.FileSystem;
  const legacy = yield* LegacyTestDatabase;
  const target = yield* TargetTestDatabase;
  const reportDir = yield* fs.makeTempDirectoryScoped();
  const { report, written } = yield* runImport(reportDir).pipe(
    Effect.provide(
      importLayer({ legacyMysqlUrl: legacy.url, targetUrl: target.url, legacyFilesDir }),
    ),
  );
  return {
    report,
    json: yield* fs.readFileString(written.json),
    markdown: yield* fs.readFileString(written.markdown),
  };
});

/** Queries the target database. */
const queryTarget = <A>(query: (sql: PgClient.PgClient) => Effect.Effect<A, unknown>) =>
  Effect.gen(function* () {
    const target = yield* TargetTestDatabase;
    return yield* Effect.gen(function* () {
      return yield* query(yield* PgClient.PgClient);
    }).pipe(Effect.provide(PgClient.layer({ url: target.url, maxConnections: 1 })), Effect.orDie);
  });

/** Every imported table, ordered by key, plus the identity sequences: the whole target state. */
const dumpTarget = queryTarget((sql) =>
  Effect.all([
    Effect.forEach(TARGET_TABLES, ({ table }) =>
      sql.unsafe(`select * from "${table}" order by 1, 2`),
    ),
    sql`select sequencename, last_value::text from pg_sequences order by sequencename`,
  ]),
).pipe(Effect.map((dump) => JSON.stringify(dump)));

const rowsOf = (table: TargetTable) =>
  queryTarget((sql) =>
    sql.unsafe<Record<string, unknown>>(`select * from "${table}" order by 1, 2`),
  );

const counts = (report: ReconciliationReport) =>
  Object.fromEntries(
    report.tables.map((t) => [t.table, [t.rowsIn, t.rowsOut, t.quarantined]] as const),
  );

const reasonsOf = (report: ReconciliationReport, table: TargetTable, id: string) =>
  report.quarantine.find((row) => row.table === table && row.id === id)?.reasons;

/** A temporary legacy web root holding the fake files. */
const fakeFilesDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped();
  for (const file of FAKE_FILES) {
    const target = path.join(root, ...file.path.split("/"));
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    yield* fs.writeFile(target, file.bytes);
  }
  return root;
});

/** The content-addressed key the importer must give a fake file. */
const expectedKey = Effect.fn("expectedKey")(function* (legacyPath: string, extension: string) {
  const file = FAKE_FILES.find((f) => f.path === legacyPath);
  if (file === undefined) return yield* Effect.die(`no fake file ${legacyPath}`);
  const crypto = yield* Crypto.Crypto;
  const digest = yield* Effect.orDie(crypto.digest("SHA-256", file.bytes));
  return `${hexEncode(digest)}.${extension}`;
});

/** Runs `bun src/main.ts` with an explicit environment (nothing inherited but PATH, USER and HOME). */
const runCli = Effect.fn("runCli")(function* (
  args: ReadonlyArray<string>,
  env: Record<string, string>,
) {
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const cwd = yield* path.fromFileUrl(IMPORT_DIR);
  // PATH finds bun; USER is the PostgreSQL user when a URL names none (devenv's trust auth).
  const inherited = {
    PATH: yield* Config.String("PATH"),
    USER: yield* Config.String("USER"),
    HOME: yield* Config.String("HOME").pipe(Config.withDefault("/tmp")),
  };
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make("bun", ["src/main.ts", ...args], { cwd, env: { ...inherited, ...env } }),
      );
      return yield* Effect.all(
        {
          stdout: handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
          stderr: handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
          exitCode: handle.exitCode,
        },
        { concurrency: "unbounded" },
      );
    }),
  );
});

layer(Databases, { timeout: "120 seconds", excludeTestServices: true })(
  "legacy MySQL → PostgreSQL round trip",
  (it) => {
    it.effect(
      "spec 0001 rehearsal through the CLI, without LEGACY_FILES_DIR: counts, quarantine, collapses, missing files (RULE-050, RULE-144, RULE-237)",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const legacy = yield* LegacyTestDatabase;
          const target = yield* TargetTestDatabase;
          const reportDir = yield* fs.makeTempDirectoryScoped();
          const cli = yield* runCli(["--report-dir", reportDir], {
            LEGACY_MYSQL_URL: Redacted.value(legacy.url),
            IMPORT_TARGET_DATABASE_URL: Redacted.value(target.url),
          });
          assert.strictEqual(
            cli.exitCode,
            ChildProcessSpawner.ExitCode(0),
            `${cli.stdout}\n${cli.stderr}`,
          );
          // The JSON file is decoded against the report's Schema (its published contract).
          const report = yield* Schema.decodeUnknownEffect(ReportFromJson)(
            yield* fs.readFileString(path.join(reportDir, "reconciliation.json")),
          );

          assert.strictEqual(report.fileSource, "none");
          // [rows in, rows out, quarantined]
          assert.deepStrictEqual(counts(report), {
            public_file: [9, 0, 0],
            department: [3, 2, 1],
            semester: [7, 2, 2],
            field_of_study: [5, 2, 3],
            admission_period: [2, 1, 1],
            article: [3, 0, 3],
            article_department: [4, 0, 4],
            static_content: [3, 2, 1],
            sponsor: [3, 1, 2],
            social_event: [4, 1, 3],
          });

          // RULE-144/237: (term, year) is unique in the target, so duplicates collapse into the lowest id.
          assert.deepStrictEqual(report.collapsedSemesters, [
            { term: "VAR", year: 2024, keptId: 1, collapsedIds: [3] },
            { term: "HOST", year: 2024, keptId: 2, collapsedIds: [4, 5] },
          ]);
          // RULE-050: the year is an integer column; a non-numeric year is quarantined, not guessed.
          assert.deepStrictEqual(yield* rowsOf("semester"), [
            { id: 1, term: "VAR", year: 2024 },
            { id: 2, term: "HOST", year: 2024 },
          ]);
          assert.deepStrictEqual(reasonsOf(report, "semester", "6"), [
            "semesterTime is neither 'Vår' nor 'Høst'",
          ]);
          assert.deepStrictEqual(reasonsOf(report, "semester", "7"), [
            "year is not a four-digit year between 1900 and 9999",
          ]);
          // References to collapsed semesters are remapped to the kept row.
          const [period] = yield* rowsOf("admission_period");
          assert.strictEqual(period?.["semester_id"], 1);
          const [event] = yield* rowsOf("social_event");
          assert.strictEqual(event?.["semester_id"], 2);

          // Orphans and broken references are quarantined with reasons.
          assert.deepStrictEqual(reasonsOf(report, "field_of_study", "3"), [
            "department_id is NULL",
          ]);
          assert.deepStrictEqual(reasonsOf(report, "field_of_study", "4"), [
            "department_id references absent department 99",
          ]);
          assert.deepStrictEqual(reasonsOf(report, "field_of_study", "5"), [
            "department_id references quarantined department 3",
          ]);
          assert.deepStrictEqual(reasonsOf(report, "department", "3"), [
            "email is not a valid e-mail address",
          ]);
          assert.deepStrictEqual(reasonsOf(report, "static_content", "2"), [
            "html_id duplicates static_content 1",
          ]);
          assert.deepStrictEqual(reasonsOf(report, "sponsor", "2"), [
            "url is not an absolute http(s) URL",
          ]);
          assert.deepStrictEqual(reasonsOf(report, "social_event", "3"), [
            "endTime is not after startTime",
          ]);
          assert.deepStrictEqual(reasonsOf(report, "admission_period", "2"), [
            "end_date is not after start_date",
          ]);
          // Without a file copy, every article lacks its required images.
          assert.deepStrictEqual(reasonsOf(report, "article", "1"), [
            "imageLarge has no registered file",
            "imageSmall has no registered file",
          ]);
          assert.isTrue(
            report.brokenReferences.some(
              (b) =>
                b.table === "field_of_study" &&
                b.id === "4" &&
                b.kind === "absent-row" &&
                b.targetId === "99",
            ),
          );

          // Every referenced file is missing; references are grouped by file, never named.
          assert.strictEqual(report.missingFiles.distinctFiles, 9);
          assert.deepStrictEqual(
            report.missingFiles.references
              .filter((m) => m.table === "department")
              .map(({ id, field, area }) => ({ id, field, area })),
            [{ id: "1", field: "logo_path", area: "images/Logo images" }],
          );
          const [alfa] = yield* rowsOf("department");
          assert.strictEqual(alfa?.["logo_key"], null);
        }),
    );

    it.effect(
      "RULE-133: rich text is sanitised; without files, legacy references are kept and listed as missing",
      () =>
        Effect.gen(function* () {
          const { report } = yield* importOnce(Option.none());
          const blocks = yield* rowsOf("static_content");
          const about = blocks.find((block) => block["key"] === "about-intro");
          const html = String(about?.["html"]);
          assert.notInclude(html, "onclick");
          assert.include(html, "Om oss");
          assert.include(
            html,
            'src="https://vektorprogrammet.no/images/article_images/bilde-1.jpg"',
          );
          assert.isTrue(
            report.missingFiles.references.some(
              (m) =>
                m.table === "static_content" && m.id === "1" && m.area === "images/article_images",
            ),
          );
          assert.deepStrictEqual(
            report.richText.sanitizedRows.filter((row) => row.table === "static_content"),
            [{ table: "static_content", id: "1" }],
          );
          assert.strictEqual(report.richText.rewrittenReferences, 0);
        }),
    );

    it.effect("a second run gives an identical target and report (determinism)", () =>
      Effect.gen(function* () {
        const first = yield* importOnce(Option.none());
        const firstTarget = yield* dumpTarget;
        const second = yield* importOnce(Option.none());
        assert.strictEqual(second.json, first.json);
        assert.strictEqual(second.markdown, first.markdown);
        assert.strictEqual(yield* dumpTarget, firstTarget);

        const filesDir = yield* fakeFilesDir;
        const withFiles = yield* importOnce(Option.some(filesDir));
        const withFilesTarget = yield* dumpTarget;
        const again = yield* importOnce(Option.some(filesDir));
        assert.strictEqual(again.json, withFiles.json);
        assert.strictEqual(yield* dumpTarget, withFilesTarget);
        // The rerun starts from scratch: the files run replaced the no-files target.
        assert.notStrictEqual(withFilesTarget, firstTarget);
      }),
    );

    it.effect(
      "RULE-290 / RULE-133 / RULE-130: with LEGACY_FILES_DIR, files are registered with legacy_path and references are rewritten to /filer/{key}",
      () =>
        Effect.gen(function* () {
          const filesDir = yield* fakeFilesDir;
          const { report } = yield* importOnce(Option.some(filesDir));
          const imageKey = yield* expectedKey("images/article_images/bilde-1.jpg", "jpg");
          const pdfKey = yield* expectedKey("Offentlige filer/Dokumenter/info.pdf", "pdf");
          const logoKey = yield* expectedKey("images/Logo images/alfa-logo.png", "png");

          assert.strictEqual(report.fileSource, "directory");
          assert.deepStrictEqual(counts(report)["public_file"], [9, 7, 0]);
          assert.deepStrictEqual(counts(report)["article"], [3, 3, 0]);
          assert.deepStrictEqual(counts(report)["article_department"], [4, 2, 2]);
          assert.strictEqual(report.files.pathsSharingContent, 1);
          assert.strictEqual(report.missingFiles.distinctFiles, 1);
          assert.deepStrictEqual(
            report.missingFiles.references.map(({ table, id, field, area }) => ({
              table,
              id,
              field,
              area,
            })),
            [{ table: "article", id: "1", field: "article", area: "images/article_images" }],
          );

          // RULE-290: registered files, keyed by content, with the legacy path for the 301.
          const files = yield* rowsOf("public_file");
          const byPath = new Map(files.map((file) => [file["legacy_path"], file]));
          assert.strictEqual(byPath.get("Offentlige filer/Dokumenter/info.pdf")?.["key"], pdfKey);
          assert.strictEqual(byPath.get("images/article_images/bilde-1.jpg")?.["key"], imageKey);
          // RULE-130: the stored type comes from the bytes.
          assert.strictEqual(
            byPath.get("Offentlige filer/Dokumenter/info.pdf")?.["content_type"],
            "application/pdf",
          );
          assert.strictEqual(
            byPath.get("images/Logo images/alfa-logo.png")?.["content_type"],
            "image/png",
          );
          assert.isFalse(byPath.has("images/Logo images/sponsor-en.png"));

          // RULE-133 + rewrite: the script is gone, legacy references point at /filer/{key}.
          const articles = yield* rowsOf("article");
          const body = String(articles.find((a) => a["id"] === 1)?.["body"]);
          assert.notInclude(body, "<script");
          assert.notInclude(body, "alert(1)");
          assert.include(body, `src="/filer/${imageKey}"`);
          assert.include(body, `href="/filer/${pdfKey}"`);
          // A missing upload keeps its original reference; an unmapped asset is left alone.
          assert.include(body, 'src="/images/article_images/finnes-ikke.jpg"');
          assert.include(body, 'src="/images/team_images/x.png"');
          assert.notStrictEqual(body, ARTICLE_1_BODY);
          const about = (yield* rowsOf("static_content")).find((b) => b["key"] === "about-intro");
          assert.include(String(about?.["html"]), `src="/filer/${imageKey}"`);
          assert.strictEqual(report.richText.rewrittenReferences, 3);

          // Logos: the same bytes give one key for both the department and the sponsor.
          const [alfa] = yield* rowsOf("department");
          assert.strictEqual(alfa?.["logo_key"], logoKey);
          const [sponsor] = yield* rowsOf("sponsor");
          assert.strictEqual(sponsor?.["logo_key"], logoKey);
        }),
    );

    it.effect("RULE-267: drafts stay drafts, and a NULL published flag is a draft", () =>
      Effect.gen(function* () {
        const { report } = yield* importOnce(Option.some(yield* fakeFilesDir));
        const published = (yield* rowsOf("article")).map((a) => [a["id"], a["published"]]);
        assert.deepStrictEqual(published, [
          [1, true],
          [2, false],
          [3, false],
        ]);
        assert.deepStrictEqual(
          report.normalisations.filter((n) => n.table === "article"),
          [
            {
              table: "article",
              id: "3",
              field: "published",
              change: "NULL stored as false (draft)",
            },
          ],
        );
      }),
    );

    it.effect("RULE-188: social events are imported without the never-enforced role_id", () =>
      Effect.gen(function* () {
        const { report } = yield* importOnce(Option.none());
        const columns = yield* queryTarget(
          (sql) =>
            sql<{ column_name: string }>`select column_name from information_schema.columns
                where table_name = 'social_event' order by column_name`,
        );
        assert.isFalse(columns.some((c) => c.column_name.includes("role")));
        const events = yield* rowsOf("social_event");
        assert.deepStrictEqual(
          events.map((e) => e["id"]),
          [1],
        );
        assert.deepStrictEqual(reasonsOf(report, "social_event", "2"), ["title is empty"]);
        assert.isTrue(
          report.droppedColumns.some((d) => d.table === "event" && d.column === "role_id"),
        );
      }),
    );

    it.effect("the report holds ids and counts only: no names, e-mails, titles or file names", () =>
      Effect.gen(function* () {
        const withoutFiles = yield* importOnce(Option.none());
        const withFiles = yield* importOnce(Option.some(yield* fakeFilesDir));
        for (const text of [
          withoutFiles.json,
          withoutFiles.markdown,
          withFiles.json,
          withFiles.markdown,
        ]) {
          for (const sentinel of PERSONAL_SENTINELS) assert.notInclude(text, sentinel);
        }
      }),
    );

    it.effect("the CLI refuses the development database without --allow-dev-database", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const legacy = yield* LegacyTestDatabase;
        const developmentUrl = yield* Config.Redacted("DATABASE_URL");
        const reportDir = yield* fs.makeTempDirectoryScoped();
        const cli = yield* runCli(["--report-dir", reportDir], {
          LEGACY_MYSQL_URL: Redacted.value(legacy.url),
          IMPORT_TARGET_DATABASE_URL: Redacted.value(developmentUrl),
          DATABASE_URL: Redacted.value(developmentUrl),
        });
        assert.notStrictEqual(cli.exitCode, ChildProcessSpawner.ExitCode(0));
        assert.include(`${cli.stdout}${cli.stderr}`, "--allow-dev-database");
        assert.isFalse(yield* fs.exists(`${reportDir}/reconciliation.json`));
      }),
    );
  },
);
