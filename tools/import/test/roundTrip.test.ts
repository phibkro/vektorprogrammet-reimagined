/**
 * The legacy MySQL → PostgreSQL round trip, against real databases: a per-run
 * MySQL database loaded with the legacy table definitions and FAKE rows, read
 * through the SELECT-only `legacy_reader`, and a per-run PostgreSQL database
 * migrated with `packages/db`'s migrations. Both are dropped afterwards.
 *
 * The first scenario runs the CLI composition root (`bun src/main.ts`) as the
 * operator does; the others run the same `runImport` on the same `importLayer`.
 */
import { PgClient } from "@effect/sql-pg";
import { assert, layer } from "@effect/vitest";
import {
  TestDatabaseUrl,
  migratedTestDatabase,
} from "@vektorprogrammet/db/testing";
import type { TargetTable } from "@vektorprogrammet/domain";
import type { Redacted } from "effect";
import {
  Array as Arr,
  Config,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Record as Rec,
  Schema,
  Stream,
  String as Str,
} from "effect";
import { Digest } from "effect/crypto";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { SqlError } from "effect/sql/SqlError";

import { nodeServicesLayer } from "../src/nodeServices.ts";
import { importLayer, runImport } from "../src/pipeline.ts";
import { ReportFromJson } from "../src/report.ts";
import type { ReconciliationReport } from "../src/report.ts";
import { TARGET_TABLES } from "../src/transform/plan.ts";
import { LegacyTestDatabase } from "./support/databases.ts";
import { FAKE_FILES, PERSONAL_SENTINELS } from "./support/fixture.ts";

const IMPORT_DIR = new URL("..", import.meta.url);

const Databases = Layer.mergeAll(
  LegacyTestDatabase.layer,
  migratedTestDatabase
).pipe(Layer.provideMerge(nodeServicesLayer));

/** Runs the import in-process; returns the report and the report files' text. */
const importOnce = Effect.fn("importOnce")(function* importOnce(
  legacyFilesDir: Option.Option<string>
) {
  const fs = yield* FileSystem.FileSystem;
  const legacy = yield* LegacyTestDatabase;
  const targetUrl = yield* TestDatabaseUrl;
  const reportDir = yield* fs.makeTempDirectoryScoped();

  const { report, written } = yield* runImport(reportDir).pipe(
    Effect.provide(
      importLayer({
        legacyFilesDir,
        legacyMysqlUrl: legacy.url,
        targetUrl,
      })
    )
  );

  return {
    json: yield* fs.readFileString(written.json),
    markdown: yield* fs.readFileString(written.markdown),
    report,
  };
});

interface DatabaseRecord {
  readonly [column: string]: DatabaseValue;
}

type DatabaseValue =
  | boolean
  | Date
  | null
  | number
  | string
  | Uint8Array
  | readonly DatabaseValue[]
  | DatabaseRecord;

type DatabaseRow = DatabaseRecord;

/** Queries the target database. */
const queryTarget = <A>(
  query: (sql: PgClient.PgClient) => Effect.Effect<A, SqlError>
) =>
  Effect.gen(function* queryTargetProgram() {
    const targetUrl = yield* TestDatabaseUrl;

    return yield* Effect.gen(function* runTargetQuery() {
      return yield* query(yield* PgClient.PgClient);
    }).pipe(
      Effect.provide(PgClient.layer({ maxConnections: 1, url: targetUrl })),
      Effect.orDie
    );
  });

/** Every imported table, ordered by key, plus the identity sequences: the whole target state. */
const dumpTarget = queryTarget((sql) =>
  Effect.all([
    Effect.forEach(TARGET_TABLES, ({ table }) =>
      sql.unsafe(`select * from "${table}" order by 1, 2`)
    ),
    sql`select sequencename, last_value::text from pg_sequences order by sequencename`,
  ])
).pipe(Effect.map((dump) => JSON.stringify(dump)));

const rowsOf = (table: TargetTable) =>
  queryTarget<readonly DatabaseRow[]>((sql) =>
    sql.unsafe<DatabaseRow>(`select * from "${table}" order by 1, 2`)
  );

const counts = (report: ReconciliationReport) =>
  Rec.fromEntries(
    Arr.map(
      report.tables,
      (t) => [t.table, [t.rowsIn, t.rowsOut, t.quarantined]] as const
    )
  );

const reasonsOf = (
  report: ReconciliationReport,
  table: TargetTable,
  id: string
) =>
  Option.getOrUndefined(
    Arr.findFirst(
      report.quarantine,
      (row) => row.table === table && row.id === id
    )
  )?.reasons;

/** A temporary legacy web root holding the fake files. */
const fakeFilesDir = Effect.gen(function* fakeFilesDir() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped();

  for (const file of FAKE_FILES) {
    const target = path.join(root, ...Str.split(file.path, "/"));
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    yield* fs.writeFile(target, file.bytes);
  }

  return root;
});

/** The content-addressed key the importer must give a fake file. */
const expectedKey = Effect.fn("expectedKey")(function* expectedKey(
  legacyPath: string,
  extension: string
) {
  const file = Option.getOrUndefined(
    Arr.findFirst(FAKE_FILES, (f) => f.path === legacyPath)
  );

  if (file === undefined) {
    return yield* Effect.die(`no fake file ${legacyPath}`);
  }

  const digests = yield* Digest.Digest;

  return `${yield* digests.digestHex(Digest.sha256, file.bytes)}.${extension}`;
});

/** Runs `bun src/main.ts` with an explicit environment (nothing inherited but PATH, USER and HOME). */
const runCli = Effect.fn("runCli")(function* runCli(
  args: readonly string[],
  env: Record<string, string | Redacted.Redacted>
) {
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const cwd = yield* path.fromFileUrl(IMPORT_DIR);

  // PATH finds bun; USER is the PostgreSQL user when a URL names none (devenv's trust auth).
  const inherited = {
    HOME: yield* Config.String("HOME").pipe(Config.withDefault("/tmp")),
    PATH: yield* Config.String("PATH"),
    USER: yield* Config.String("USER"),
  };

  return yield* Effect.scoped(
    Effect.gen(function* runCliChild() {
      const handle = yield* spawner.spawn(
        ChildProcess.make("bun", ["src/main.ts", ...args], {
          cwd,
          env: { ...inherited, ...env },
        })
      );

      return yield* Effect.all(
        {
          exitCode: handle.exitCode,
          stderr: handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
          stdout: handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
        },
        { concurrency: "unbounded" }
      );
    })
  );
});

layer(Databases, { excludeTestServices: true, timeout: "120 seconds" })(
  "legacy MySQL → PostgreSQL round trip",
  (it) => {
    it.effect(
      "spec 0001 rehearsal through the CLI, without LEGACY_FILES_DIR: counts, quarantine, collapses, missing files (RULE-050, RULE-144, RULE-237)",
      () =>
        Effect.gen(function* effectProgram() {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const legacy = yield* LegacyTestDatabase;
          const targetUrl = yield* TestDatabaseUrl;
          const reportDir = yield* fs.makeTempDirectoryScoped();

          const cli = yield* runCli(["--report-dir", reportDir], {
            IMPORT_TARGET_DATABASE_URL: targetUrl,
            LEGACY_MYSQL_URL: legacy.url,
          });

          assert.strictEqual(
            cli.exitCode,
            ChildProcessSpawner.ExitCode(0),
            `${cli.stdout}\n${cli.stderr}`
          );

          // The JSON file is decoded against the report's Schema (its published contract).
          const report = yield* Schema.decodeEffect(ReportFromJson)(
            yield* fs.readFileString(
              path.join(reportDir, "reconciliation.json")
            )
          );

          assert.strictEqual(report.fileSource, "none");
          // [rows in, rows out, quarantined]
          assert.deepStrictEqual(counts(report), {
            admission_period: [2, 1, 1],
            department: [3, 2, 1],
            field_of_study: [5, 2, 3],
            public_file: [1, 0, 0],
            semester: [7, 2, 2],
            social_event: [4, 1, 3],
          });

          // RULE-144/237: (term, year) is unique in the target, so duplicates collapse into the lowest id.
          assert.deepStrictEqual(report.collapsedSemesters, [
            { collapsedIds: [3], keptId: 1, term: "VAR", year: 2024 },
            { collapsedIds: [4, 5], keptId: 2, term: "HOST", year: 2024 },
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
          assert.strictEqual(period?.semester_id, 1);
          const [event] = yield* rowsOf("social_event");
          assert.strictEqual(event?.semester_id, 2);

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
          assert.deepStrictEqual(reasonsOf(report, "social_event", "3"), [
            "endTime is not after startTime",
          ]);
          assert.deepStrictEqual(reasonsOf(report, "admission_period", "2"), [
            "end_date is not after start_date",
          ]);
          assert.isTrue(
            Arr.some(
              report.brokenReferences,
              (b) =>
                b.table === "field_of_study" &&
                b.id === "4" &&
                b.kind === "absent-row" &&
                b.targetId === "99"
            )
          );

          // Every referenced file is missing; references are grouped by file, never named.
          assert.strictEqual(report.missingFiles.distinctFiles, 1);
          assert.deepStrictEqual(
            Arr.map(
              Arr.filter(
                report.missingFiles.references,
                (m) => m.table === "department"
              ),
              ({ id, field, area }) => ({ area, field, id })
            ),
            [{ area: "images/Logo images", field: "logo_path", id: "1" }]
          );
          const [alfa] = yield* rowsOf("department");
          assert.strictEqual(alfa?.logo_key, null);
        })
    );

    it.effect(
      "a second run gives an identical target and report (determinism)",
      () =>
        Effect.gen(function* effectProgram() {
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
        })
    );

    it.effect(
      "RULE-290 / RULE-130: with LEGACY_FILES_DIR, the department logo is registered with its legacy_path and the department points at it",
      () =>
        Effect.gen(function* effectProgram() {
          const filesDir = yield* fakeFilesDir;
          const { report } = yield* importOnce(Option.some(filesDir));

          const logoKey = yield* expectedKey(
            "images/Logo images/alfa-logo.png",
            "png"
          );

          assert.strictEqual(report.fileSource, "directory");
          assert.deepStrictEqual(counts(report).public_file, [1, 1, 0]);
          assert.strictEqual(report.files.pathsSharingContent, 0);
          assert.strictEqual(report.missingFiles.distinctFiles, 0);

          // RULE-290: a registered file, keyed by its content, with the legacy path for the 301.
          const [file] = yield* rowsOf("public_file");
          assert.strictEqual(file?.key, logoKey);
          assert.strictEqual(
            file?.legacy_path,
            "images/Logo images/alfa-logo.png"
          );
          // RULE-130: the stored type comes from the bytes.
          assert.strictEqual(file?.content_type, "image/png");

          const [alfa] = yield* rowsOf("department");
          assert.strictEqual(alfa?.logo_key, logoKey);
        })
    );

    it.effect(
      "RULE-188: social events are imported without the never-enforced role_id",
      () =>
        Effect.gen(function* effectProgram() {
          const { report } = yield* importOnce(Option.none());

          const columns = yield* queryTarget(
            (sql) =>
              sql<{
                column_name: string;
              }>`select column_name from information_schema.columns
              where table_name = 'social_event' order by column_name`
          );

          assert.isFalse(
            Arr.some(columns, (c) => Str.includes("role")(c.column_name))
          );
          const events = yield* rowsOf("social_event");
          assert.deepStrictEqual(
            Arr.map(events, (e) => e.id),
            [1]
          );
          assert.deepStrictEqual(reasonsOf(report, "social_event", "2"), [
            "title is empty",
          ]);
          assert.isTrue(
            Arr.some(
              report.droppedColumns,
              (d) => d.table === "event" && d.column === "role_id"
            )
          );
        })
    );

    it.effect(
      "the report holds ids and counts only: no names, e-mails, titles or file names",
      () =>
        Effect.gen(function* effectProgram() {
          const withoutFiles = yield* importOnce(Option.none());
          const withFiles = yield* importOnce(Option.some(yield* fakeFilesDir));

          for (const text of [
            withoutFiles.json,
            withoutFiles.markdown,
            withFiles.json,
            withFiles.markdown,
          ]) {
            for (const sentinel of PERSONAL_SENTINELS) {
              assert.notInclude(text, sentinel);
            }
          }
        })
    );

    it.effect(
      "the CLI refuses the development database without --allow-dev-database",
      () =>
        Effect.gen(function* effectProgram() {
          const fs = yield* FileSystem.FileSystem;
          const legacy = yield* LegacyTestDatabase;
          const developmentUrl = yield* Config.Redacted("DATABASE_URL");
          const reportDir = yield* fs.makeTempDirectoryScoped();

          const cli = yield* runCli(["--report-dir", reportDir], {
            DATABASE_URL: developmentUrl,
            IMPORT_TARGET_DATABASE_URL: developmentUrl,
            LEGACY_MYSQL_URL: legacy.url,
          });

          assert.notStrictEqual(cli.exitCode, ChildProcessSpawner.ExitCode(0));
          assert.include(`${cli.stdout}${cli.stderr}`, "--allow-dev-database");
          assert.isFalse(yield* fs.exists(`${reportDir}/reconciliation.json`));
        })
    );

    type Statement<A> = (sql: PgClient.PgClient) => Effect.Effect<A, SqlError>;

    /** What a replacement must refuse to destroy, because the importer cannot restore it: how to make it, read it, drop it. */
    const unrestorable: readonly {
      readonly held: string;
      readonly make: Statement<unknown>;
      readonly read: Statement<readonly unknown[]>;
      readonly drop: Statement<unknown>;
    }[] = [
      {
        drop: (sql) =>
          sql`delete from account where person_id in (select id from person where email = 'protected@example.org')`,
        held: "an account",
        make: (sql) =>
          sql`insert into account (person_id, state) select id, 'Active' from person where email = 'protected@example.org'`,
        read: (sql) =>
          sql`select p.email, a.state from person p join account a on a.person_id = p.id where p.email = 'protected@example.org'`,
      },
      {
        drop: (sql) =>
          sql`delete from consent where person_id in (select id from person where email = 'protected@example.org')`,
        held: "a consent",
        make: (sql) =>
          sql`insert into consent (given_at, kind, person_id, text_version) select now(), 'news', id, 1 from person where email = 'protected@example.org'`,
        read: (sql) =>
          sql`select p.email, c.kind from person p join consent c on c.person_id = p.id where p.email = 'protected@example.org'`,
      },
      {
        drop: (sql) =>
          sql`delete from welcome_ledger where person_id in (select id from person where email = 'protected@example.org')`,
        held: "a first-membership welcome claim",
        make: (sql) =>
          sql`insert into welcome_ledger (person_id, recorded_at) select id, now() from person where email = 'protected@example.org'`,
        read: (sql) =>
          sql`select p.email from person p join welcome_ledger w on w.person_id = p.id where p.email = 'protected@example.org'`,
      },
      {
        drop: (sql) => sql`delete from job_run where period = 'test:import'`,
        held: "a job run",
        make: (sql) =>
          sql`insert into job_run (job, period, lease_until, outcome) values ('semesters', 'test:import', now(), 'partial')`,
        read: (sql) =>
          sql`select period from job_run where period = 'test:import'`,
      },
      {
        drop: (sql) =>
          sql`delete from workspace_report where period = 'test:import'`,
        held: "a Workspace report",
        make: (sql) =>
          sql`insert into workspace_report (actual, completed_at, mode, period, semester_term, semester_year, started_at, status) values ('read', now(), 'dry-run', 'test:import', 'HOST', 2026, now(), 'complete')`,
        read: (sql) =>
          sql`select period from workspace_report where period = 'test:import'`,
      },
      {
        drop: (sql) =>
          sql`delete from outbox where payload ->> 'text' = 'test:import'`,
        held: "a queued message",
        make: (sql) =>
          sql`insert into outbox (created_at, kind, next_attempt_at, payload) values (now(), 'SlackPost', now(), '{"_tag":"SlackPost","channel":"test","text":"test:import"}'::jsonb)`,
        read: (sql) =>
          sql`select id from outbox where payload ->> 'text' = 'test:import'`,
      },
      {
        drop: (sql) =>
          sql`delete from captured_mail where recipient = 'test-import@example.org'`,
        held: "a captured mail",
        make: (sql) =>
          sql`insert into captured_mail (recipient, sent_at, subject, text) values ('test-import@example.org', now(), 'Emne', 'Tekst')`,
        read: (sql) =>
          sql`select id from captured_mail where recipient = 'test-import@example.org'`,
      },
      {
        drop: (sql) =>
          sql`delete from captured_slack where channel = 'test-import'`,
        held: "a captured Slack post",
        make: (sql) =>
          sql`insert into captured_slack (channel, sent_at, text) values ('test-import', now(), 'Tekst')`,
        read: (sql) =>
          sql`select id from captured_slack where channel = 'test-import'`,
      },
    ];

    for (const { drop, held, make, read } of unrestorable) {
      it.effect(
        `spec 0007 R8 and 0007b: replacement refuses a target that holds ${held} without changing its rows`,
        () =>
          Effect.gen(function* preserveRecords() {
            yield* importOnce(Option.none());
            yield* queryTarget(
              (sql) =>
                sql`insert into person (name, email, field_of_study_id) select 'Fake Person', 'protected@example.org', id from field_of_study order by id limit 1`
            );
            yield* queryTarget(make);
            const before = yield* dumpTarget;
            const failed = yield* Effect.flip(importOnce(Option.none()));
            assert.isTrue(Predicate.isTagged(failed, "TargetWriteError"));

            if (Predicate.isTagged(failed, "TargetWriteError")) {
              assert.strictEqual(failed.step, "protect records");
            }

            assert.strictEqual(yield* dumpTarget, before);
            assert.strictEqual((yield* queryTarget(read)).length, 1);

            // Released, so that the next case starts from a target that only the import has written.
            yield* queryTarget(drop);
            yield* queryTarget(
              (sql) =>
                sql`delete from person where email = 'protected@example.org'`
            );
          })
      );
    }
  }
);
