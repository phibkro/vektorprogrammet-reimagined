# @vektorprogrammet/import

Imports the Phase 1 tables of the legacy MySQL backup into a PostgreSQL target (a Neon branch) and writes a reconciliation report. It is deterministic and reruns from scratch: every run replaces the target's Phase 1 data in one transaction. Design: `analysis/vektorprogrammet/REIMAGINED_ARCHITECTURE.md` §6 and spec `docs/specs/0001-departments-and-semesters.md` ("Data and migration").

```
legacy MySQL (SELECT-only legacy_reader, one snapshot)
  → resolve legacy files (LEGACY_FILES_DIR, optional) → SHA-256 keys
  → plan (pure: map, validate, collapse, quarantine)
  → PostgreSQL target, one transaction: TRUNCATE … RESTART IDENTITY, INSERT, setval, count
  → reconciliation.json + reconciliation.md
```

## Authority

- **Loading rows derived from the 2024-08-22 backup into Neon branches is authorised** (operator, Checkpoint 2, 2026-10-15). Production Neon is written only at the final import.
- **Copying the production file directories is NOT authorised yet** (Checkpoint 2: the file-copy entry item stays open). Run without `LEGACY_FILES_DIR`; the report then lists every referenced file as missing, and articles (whose images are required) are quarantined.
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
| Rich text | rows the sanitizer changed (RULE-133 replacement) and references rewritten to `/filer/{key}` |
| Normalisations | value changes that are not guesses (blank optional text → NULL; `published` NULL → draft) |
| Dropped legacy columns | columns with no target, by decision (`event.role_id`: RULE-188) |

A quarantined row is never repaired by the importer. Decide the fix with the operator, correct it in the source (or record the decision), and rerun.

### 5. Clean up

Delete the Neon branch when the rehearsal is done, and drop or keep the local `legacy` database according to the backup's handling rules.

## Mapping rules

| Target | Legacy | Rule |
| --- | --- | --- |
| `department` | `department` | legacy ids kept; e-mail, Slack channel (`#name`) and coordinates checked with the domain schemas; city unique |
| `semester` | `semester` | `semesterTime` exactly `Vår`/`Høst` → `VAR`/`HOST`; four-digit numeric year (RULE-050); duplicates collapse into the lowest id (RULE-144, RULE-237) |
| `field_of_study` | `field_of_study` | a NULL, absent or quarantined department quarantines the row |
| `admission_period` | `AdmissionPeriod` | semester remapped through collapses; end after start; `infoMeeting_id` dropped (Phase 3) |
| `article` | `article` | slug kept (unique); body sanitized and rewritten; both images must be registered files; the legacy author id kept in `author_id` (the architecture's `legacy_author_id`) with no foreign key; `published` NULL → draft (RULE-267) |
| `article_department` | `articles_departments` | kept when both ends were imported |
| `static_content` | `static_content` | keyed by `html_id`; a repeated `html_id` is quarantined (the first id wins); html sanitized and rewritten |
| `sponsor` | `sponsor` | name, absolute http(s) URL and size (`small`/`medium`/`large`) required (RULE-189); logo optional |
| `social_event` | `event` | title required, end after start, link ≤ 250; `role_id` dropped (RULE-188) |
| `public_file` | files on disk | one row per content key (SHA-256 + type by magic bytes, RULE-130); `legacy_path` is the decoded path below the web root, e.g. `Offentlige filer/x.pdf` (RULE-290 redirects) |

- Legacy `DATETIME` values are Oslo wall-clock time ([INFERENCE] from spec 0001: legacy used server-local time) and are stored as UTC instants.
- Only `Offentlige filer/`, `images/article_images/` and `images/Logo images/` are upload roots. Site paths, percent-encoded paths and absolute URLs on `vektorprogrammet.no` are recognised. Other `images/` assets and unsafe paths (`..`, empty segments, malformed encoding) are reported as unmappable.
- With `LEGACY_FILES_DIR` the importer registers `public_file` rows only. Uploading the bytes to R2 under their keys is a separate step this tool does not perform.

## Development

```sh
devenv shell -- bash -c 'cd tools/import && bunx vp test'    # round trip against real MySQL and PostgreSQL
devenv shell -- bash -c 'cd tools/import && bunx vp check'   # format, lint, type check
```

The round trip creates a uniquely named MySQL database with `mysql -uroot` over `$MYSQL_UNIX_PORT`, loads the Phase 1 `CREATE TABLE` statements from `test/fixtures/legacy-phase1-schema.sql` (vendored verbatim from the production structure-only dump; source and checksum in its header) plus FAKE rows (`test/support/fixture.ts`), and grants `legacy_reader` SELECT on it, so the importer reads through the same SELECT-only user as in production. The PostgreSQL target is a uniquely named database created through `$TEST_DATABASE_ADMIN_URL` and migrated from `packages/db/drizzle/`. Both are dropped afterwards. The first test runs the CLI (`bun src/main.ts`) exactly as the runbook does.

No lint suppression or registered exception exists in this package.
