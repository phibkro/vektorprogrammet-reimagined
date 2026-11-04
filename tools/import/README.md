# @vektorprogrammet/import

Imports legacy organisation data from MySQL into PostgreSQL and writes reconciliation reports. Each organisation import replaces the eligible target data in one transaction. A second program (`src/cms.ts`) imports missing articles, texts and sponsors into PostgreSQL content snapshots. Both programs use the existing domain rules.

```
legacy MySQL (SELECT-only legacy_reader, one snapshot)
  → resolve legacy files (LEGACY_FILES_DIR, optional) → SHA-256 keys
  → plan (pure: map, validate, collapse, quarantine)
  → PostgreSQL target, one transaction: TRUNCATE … RESTART IDENTITY, INSERT, setval, count
  → reconciliation.json + reconciliation.md
```

The organisation importer refuses accounts, codes, consents and durable integration activity. It cannot restore credentials, consent records or notification history. Account migration belongs to spec 0013.

The importer does not import the database driver: `src/pipeline.ts` is its composition root, and it builds `ImportDatabaseLive` (`@vektorprogrammet/db`) for the domain's `ImportTarget` port (`packages/domain/src/organisation/legacyImport.ts`). The adapter, with the truncate list, is `packages/db/src/repositories/legacyImport.ts` (spec 0017).

## Authority

- The current Supabase prototype permits synthetic data only (spec 0024). Earlier Neon rehearsal authority does not authorize a Supabase production migration.
- **Copying the production file directories is NOT authorised yet** (Checkpoint 2: the file-copy entry item stays open). Run without `LEGACY_FILES_DIR`; the report then lists every referenced file (the departments' logos) as missing.
- The backup holds personal data. Keep it, the restored `legacy` database and any Neon branch out of the repository, issue trackers and chat. The report holds ids, counts, column names and upload areas only, so it may be attached to a pull request.

## Operator runbook

All commands run from the monorepo root inside devenv (`devenv up -d` started the services). Paths and URLs are environment variables you set in your own shell; never paste a real path or connection string into a file in this repository.

### 1. Restore the backup into devenv MySQL (as root)

`LEGACY_BACKUP_SQL` is the path of your private copy of `vektor-backup_2024-08-22.sql`.

```sh
devenv shell -- bash -c 'mysql -uroot -e "DROP DATABASE IF EXISTS legacy; CREATE DATABASE legacy CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"'
devenv shell -- bash -c 'mysql -uroot --default-character-set=utf8mb4 legacy < "$LEGACY_BACKUP_SQL"'
```

The root login uses the socket `$MYSQL_UNIX_PORT`. `legacy_reader` keeps its `SELECT` grant on `legacy.*` across the drop (database-level grants are not removed by `DROP DATABASE`). The backup comes from MySQL 5.7.33 and devenv runs 8.4; if the restore stops on a 5.7-only setting (for example `NO_AUTO_CREATE_USER` in an `SQL_MODE` line), remove that setting from your copy and restore again.

### 2. Select a disposable PostgreSQL target and migrate it

CAUTION: Use an empty target that you own. The organisation importer replaces data and cannot restore credentials or consent history.

Keep the direct PostgreSQL connection string in a private file named by `IMPORT_TARGET_URL_FILE`. The prototype setup guide describes local Supabase configuration.

Apply the migrations before the import:

```sh
devenv shell -- bash -c 'cd packages/db && DATABASE_URL="$(cat "$IMPORT_TARGET_URL_FILE")" bunx drizzle-kit migrate'
```

Import organisation data before seed accounts or provider identities. `prototype:setup` already creates accounts, so its database is not an empty import target.

### 3. Run the import

```sh
devenv shell -- bash -c 'cd tools/import && IMPORT_TARGET_DATABASE_URL="$(cat "$IMPORT_TARGET_URL_FILE")" bun src/main.ts --report-dir "$IMPORT_REPORT_DIR"'
```

| Variable | Required | Meaning |
| --- | --- | --- |
| `LEGACY_MYSQL_URL` | yes | set by devenv: `legacy_reader` on the `legacy` database |
| `IMPORT_TARGET_DATABASE_URL` | yes | the PostgreSQL target |
| `DATABASE_URL` | no | set by devenv; the import **refuses** to target it unless `--allow-dev-database` is given |
| `LEGACY_FILES_DIR` | no | the legacy web root (holds `images/` and `Offentlige filer/`); absent → all files missing |

The run prints rows in/out per table and the report paths. It exits non-zero and leaves the target unchanged on any failure (the write is one transaction). Rerunning gives an identical target and a byte-identical report.

### 4. Read the report

`$IMPORT_REPORT_DIR/reconciliation.md` (for people) and `reconciliation.json` (decode it with `ReportFromJson` from `src/report.ts`). Ids are legacy ids.

| Section | Meaning |
| --- | --- |
| Rows per table | rows read, rows stored (read back from the target), rows quarantined |
| Quarantined rows | rows that break a target constraint; the reasons name columns and ids, never values |
| Collapsed semesters | identical (term, year) rows merged into the lowest id; references were remapped |
| Missing files | references to upload files that were not found, grouped as `missing-file-N` with their upload area |
| Broken references | references to absent or quarantined rows, and file references that cannot be mapped |
| Normalisations | value changes that are not guesses (blank optional text → NULL) |
| Dropped legacy columns | columns with no target, by decision (`event.role_id`: RULE-188) |

A quarantined row is never repaired by the importer. Decide the fix with the operator, correct it in the source (or record the decision), and rerun.

### 5. Clean up

Delete only the disposable databases and reports that you own. Keep any real backup under its existing handling rules.

## Into PostgreSQL content (spec 0024)

The content importer uses the same database through `ContentLive`. There is no CMS HTTP service, token or separate schema.

```
legacy MySQL (the same SELECT-only snapshot)
  → plan (sanitize, convert to Portable Text, quarantine)
  → PostgreSQL site_content: create missing drafts, then publish eligible entries
  → read published/draft snapshots → emdash-reconciliation.json + emdash-reconciliation.md
```

```sh
devenv shell -- bash -c 'cd tools/import && DATABASE_URL="$(cat "$IMPORT_TARGET_URL_FILE")" bun src/cms.ts --report-dir "$IMPORT_REPORT_DIR"'
```

| Variable           | Required | Meaning                    |
| ------------------ | -------- | -------------------------- |
| `LEGACY_MYSQL_URL` | yes      | SELECT-only legacy source  |
| `DATABASE_URL`     | yes      | Migrated PostgreSQL target |

- **Create-only, so a rerun changes nothing.** An entry whose slug exists is left as it is, which also means an editor's later change is never overwritten. The second run reports `created` 0 and `unchanged` everything.
- **Create, then publish.** The importer creates a draft with the original dates. It publishes only legacy rows with `published = 1`. A legacy draft stays private (RULE-267). Content validation refusals appear in the report and produce a nonzero exit. An unavailable database stops the run.
- **Images are left out.** The legacy files are not copied (see Authority), so an image has nothing to point at: `<img>` in rich text and the article and sponsor image columns are dropped and counted. The article is imported without its image; add images in the admin.
- **Rich text** goes through the domain sanitizer, then into Portable Text (`src/emdash/portableText.ts`: paragraphs, h2–h4, bold, italic, underline, strike, sub/superscript, code, links, lists with levels, blockquote, preformatted text, rules, tables). Links to legacy upload paths stay as they are: `apps/web` redirects them (301) to `/filer/{key}` once the files are registered.

| CMS collection | Legacy | Rule |
| --- | --- | --- |
| `news` | `article` | Unique slug and required title. Original creation/publication dates and sticky flag remain. Department tags become city names. Legacy author ids are omitted. |
| `texts` | `static_content` | the `html_id` is the slug (`[a-z0-9_-]`); the editor title comes from the legacy template (`TEXT_TITLES` in `src/emdash/plan.ts`); a repeated `html_id` is quarantined (the first id wins); created at the import time |
| `sponsors` | `sponsor` | name, absolute http(s) URL and size required (RULE-189); slug `sponsor-{id}`; created at the import time |

The historical `emdash-reconciliation` filenames and `EmDashReportFromJson` type remain the report format. Their counts describe PostgreSQL content, not an EmDash service. Reports contain counts, legacy ids, column names and refusal codes, not content values.

## Mapping rules (PostgreSQL)

| Target | Legacy | Rule |
| --- | --- | --- |
| `department` | `department` | legacy ids kept; e-mail, Slack channel (`#name`) and coordinates checked with the domain schemas; city unique |
| `semester` | `semester` | `semesterTime` exactly `Vår`/`Høst` → `VAR`/`HOST`; four-digit numeric year (RULE-050); duplicates collapse into the lowest id (RULE-144, RULE-237) |
| `field_of_study` | `field_of_study` | a NULL, absent or quarantined department quarantines the row |
| `admission_period` | `AdmissionPeriod` | semester remapped through collapses; end after start; `infoMeeting_id` dropped (Phase 3) |
| `social_event` | `event` | title required, end after start, link ≤ 250; `role_id` dropped (RULE-188) |
| `public_file` | the departments' logos on disk | one row per content key (SHA-256 + type by magic bytes, RULE-130); `legacy_path` is the decoded path below the web root, e.g. `images/Logo images/x.png` (RULE-290 redirects). Article images and sponsor logos belong to the CMS program, which does not copy files |

- Legacy `DATETIME` values are Oslo wall-clock time ([INFERENCE] from spec 0001: legacy used server-local time) and are stored as UTC instants.
- Only `Offentlige filer/`, `images/article_images/` and `images/Logo images/` are upload roots. Site paths, percent-encoded paths and absolute URLs on `vektorprogrammet.no` are recognised. Other `images/` assets and unsafe paths (`..`, empty segments, malformed encoding) are reported as unmappable.
- With `LEGACY_FILES_DIR`, the importer registers `public_file` rows only. Copying bytes into Supabase Storage requires separate authority and is not part of this importer.

## Development

```sh
devenv shell -- bash -c 'cd tools/import && bunx vp test'    # round trip against real MySQL and PostgreSQL
devenv shell -- bash -c 'cd tools/import && bunx vp check'   # format, lint, type check
```

The round trip creates a uniquely named MySQL database with `mysql -uroot` over `$MYSQL_UNIX_PORT`, loads the Phase 1 `CREATE TABLE` statements from `test/fixtures/legacy-phase1-schema.sql` (vendored verbatim from the production structure-only dump; source and checksum in its header) plus FAKE rows (`test/support/fixture.ts`), and grants `legacy_reader` SELECT on it, so the importer reads through the same SELECT-only user as in production. The PostgreSQL target is the migrated disposable database of `@vektorprogrammet/db/testing` (`vp_db_test_<random>`, created through `$TEST_DATABASE_ADMIN_URL` and migrated from `packages/db/drizzle/`). Both are dropped afterwards. The first test runs the CLI (`bun src/main.ts`) exactly as the runbook does.

`bun run import:fixture` (`test/support/importFixture.ts`) imports that same FAKE fixture into an already migrated database named by `IMPORT_TARGET_DATABASE_URL`, with the same `runImport` and `importLayer`, and drops the throwaway MySQL database again. It refuses the development database like the CLI does. The `apps/web` browser tests use it to start on migrated data.

`bun run import:fixture:cms` (`test/support/importFixtureCms.ts`) imports the synthetic content fixture into `DATABASE_URL`. Browser verification runs this program before provider identities are linked. `test/cmsRoundTrip.test.ts` exercises the same rules with an in-memory content adapter. Browser verification exercises the real PostgreSQL adapter. Converter, plan and writer tests remain in `test/emdash/`.

No lint suppression or registered exception exists in this package.
