# @vektorprogrammet/import

Imports the organisation tables of the legacy MySQL backup (departments, semesters, fields of study, admission periods, social events and the departments' logos) into a PostgreSQL target (a Neon branch) and writes a reconciliation report (format version 2). It is deterministic and reruns from scratch: every run replaces the target's data in one transaction. Design: `analysis/vektorprogrammet/REIMAGINED_ARCHITECTURE.md` §6 and spec `docs/specs/0001-departments-and-semesters.md` ("Data and migration"). Articles, static texts and sponsors are not loaded here since spec 0005: a second program (`src/cms.ts`) loads them into the CMS; see "Into the CMS" below.

```
legacy MySQL (SELECT-only legacy_reader, one snapshot)
  → resolve legacy files (LEGACY_FILES_DIR, optional) → SHA-256 keys
  → plan (pure: map, validate, collapse, quarantine)
  → PostgreSQL target, one transaction: TRUNCATE … RESTART IDENTITY, INSERT, setval, count
  → reconciliation.json + reconciliation.md
```

## Authority

- **Loading rows derived from the 2024-08-22 backup into Neon branches is authorised** (operator, Checkpoint 2, 2026-10-15). Production Neon is written only at the final import.
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

### 2. Create a Neon branch and migrate it

Use the direct (unpooled) connection string: the importer connects straight to PostgreSQL, not through Hyperdrive. Pick one tool; keep the connection string in a file only you can read.

With `neonctl` (check `neonctl branches --help` for your version):

```sh
neonctl branches create --project-id "$NEON_PROJECT_ID" --name "$IMPORT_BRANCH"
umask 077
neonctl connection-string "$IMPORT_BRANCH" --project-id "$NEON_PROJECT_ID" > "$IMPORT_TARGET_URL_FILE"
```

With Alchemy: declare the branch in the infrastructure root, deploy it, and write its direct connection URI to `$IMPORT_TARGET_URL_FILE` the same way.

Apply the schema with `packages/db`'s migrations (its `drizzle.config.ts` reads `DATABASE_URL`, so set it for this one command):

```sh
devenv shell -- bash -c 'cd packages/db && DATABASE_URL="$(cat "$IMPORT_TARGET_URL_FILE")" bunx drizzle-kit migrate'
```

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

Delete the Neon branch when the rehearsal is done, and drop or keep the local `legacy` database according to the backup's handling rules.

## Into the CMS (spec 0005, D5)

Articles, static texts and sponsors do not go to PostgreSQL any more: they belong to the editors, so they go into EmDash (`apps/cms`). This is a second program with its own lifecycle, because the two targets differ: the PostgreSQL import truncates and reloads, while this one only creates what the CMS lacks.

```
legacy MySQL (the same SELECT-only snapshot)
  → plan (pure: sanitize, convert to Portable Text, quarantine)
  → CMS REST API through @vektorprogrammet/cms-client: create (draft, original dates), then publish
  → read the collections back → emdash-reconciliation.json + emdash-reconciliation.md
```

```sh
devenv shell -- bash -c 'cd tools/import && IMPORT_CMS_URL="$CMS_URL" IMPORT_CMS_TOKEN="$(cat "$CMS_TOKEN_FILE")" bun src/cms.ts --report-dir "$IMPORT_REPORT_DIR"'
```

| Variable | Required | Meaning |
| --- | --- | --- |
| `LEGACY_MYSQL_URL` | yes | set by devenv: `legacy_reader` on the `legacy` database |
| `IMPORT_CMS_URL` | yes | the CMS origin (`apps/cms`): its `/_emdash/api/` is called |
| `IMPORT_CMS_TOKEN` | yes | a personal access token with the scopes `content:read`, `content:write` and `schema:write`, created in the EmDash admin by an administrator (writing the original dates needs the `content:publish_any` permission, which an administrator has; `schema:write` lets the import add department cities as options of `news.departments`) |

- **Create-only, so a rerun changes nothing.** An entry whose slug exists is left as it is, which also means an editor's later change is never overwritten. The second run reports `created` 0 and `unchanged` everything.
- **Create, then publish.** An entry is created as a draft with the legacy `created` date as both its creation and publication date, then published when the legacy row was live (`published = 1`). A legacy draft stays a draft (RULE-267). If the CMS refuses an entry (for example a department city that is not an option of the `departments` field of `news`), the run goes on, counts the refusal with the CMS's error code and exits non-zero at the end; fix the cause and run again. A CMS that cannot be reached stops the run.
- **Images are left out.** The legacy files are not copied (see Authority), so an image has nothing to point at: `<img>` in rich text and the article and sponsor image columns are dropped and counted. The article is imported without its image; add images in the admin.
- **Rich text** goes through the domain sanitizer, then into Portable Text (`src/emdash/portableText.ts`: paragraphs, h2–h4, bold, italic, underline, strike, sub/superscript, code, links, lists with levels, blockquote, preformatted text, rules, tables). Links to legacy upload paths stay as they are: `apps/web` redirects them (301) to `/filer/{key}` once the files are registered.

| CMS collection | Legacy | Rule |
| --- | --- | --- |
| `news` | `article` | slug kept (unique); title required; `created` is the creation and publication date; `sticky`; department tags become city names (`departments`, empty = every department; a tag for an absent department is counted, not imported); the legacy author id is dropped (EmDash authors are CMS users) |
| `texts` | `static_content` | the `html_id` is the slug (`[a-z0-9_-]`); the editor title comes from the legacy template (`TEXT_TITLES` in `src/emdash/plan.ts`); a repeated `html_id` is quarantined (the first id wins); created at the import time |
| `sponsors` | `sponsor` | name, absolute http(s) URL and size required (RULE-189); slug `sponsor-{id}`; created at the import time |

`emdash-reconciliation.md` and `.json` (decode with `EmDashReportFromJson` from `src/emdash/report.ts`) hold, per collection: rows in, quarantined, created as drafts, created and published, already there, refused by the CMS, and the published and draft counts read back from the CMS. Like the PostgreSQL report they hold counts, legacy ids, column names and CMS error codes only.

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
- With `LEGACY_FILES_DIR` the importer registers `public_file` rows only. Uploading the bytes to R2 under their keys is a separate step this tool does not perform.

## Development

```sh
devenv shell -- bash -c 'cd tools/import && bunx vp test'    # round trip against real MySQL and PostgreSQL
devenv shell -- bash -c 'cd tools/import && bunx vp check'   # format, lint, type check
```

The round trip creates a uniquely named MySQL database with `mysql -uroot` over `$MYSQL_UNIX_PORT`, loads the Phase 1 `CREATE TABLE` statements from `test/fixtures/legacy-phase1-schema.sql` (vendored verbatim from the production structure-only dump; source and checksum in its header) plus FAKE rows (`test/support/fixture.ts`), and grants `legacy_reader` SELECT on it, so the importer reads through the same SELECT-only user as in production. The PostgreSQL target is the migrated disposable database of `@vektorprogrammet/db/testing` (`vp_db_test_<random>`, created through `$TEST_DATABASE_ADMIN_URL` and migrated from `packages/db/drizzle/`). Both are dropped afterwards. The first test runs the CLI (`bun src/main.ts`) exactly as the runbook does.

`bun run import:fixture` (`test/support/importFixture.ts`) imports that same FAKE fixture into an already migrated database named by `IMPORT_TARGET_DATABASE_URL`, with the same `runImport` and `importLayer`, and drops the throwaway MySQL database again. It refuses the development database like the CLI does. The `apps/web` browser tests use it to start on migrated data.

`bun run import:fixture:cms` (`test/support/importFixtureCms.ts`) does the same for the CMS: it loads the fake fixture into a throwaway MySQL database and runs `runCmsImport` against the CMS named by `IMPORT_CMS_URL`, with the token `IMPORT_CMS_TOKEN`. The browser tests and the Preview data setup (`apps/cms/README.md`) use it, so the public pages are checked on content that went through the importer. `test/cmsRoundTrip.test.ts` runs the same program on the same fixture against an in-memory CMS (`test/support/fakeCms.ts`), and `test/emdash/` has the unit tests of the converter, the plan and the writer.

No lint suppression or registered exception exists in this package.
