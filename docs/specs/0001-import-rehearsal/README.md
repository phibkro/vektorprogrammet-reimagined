# Spec 0001 import rehearsal

Falsifier 4 of [`0001-departments-and-semesters.md`](../0001-departments-and-semesters.md): the importer (`tools/import`) ran on the real 2024-08-22 backup against a disposable Neon branch. The reconciliation report it wrote sits next to this file ([`reconciliation.md`](reconciliation.md) for people, [`reconciliation.json`](reconciliation.json) for tools). It holds ids, counts, column names and upload areas only.

## What ran

|  |  |
| --- | --- |
| Date | 2026-10-16, 10:04 (Europe/Oslo) |
| Source | `vektor-backup_2024-08-22.sql` (MySQL 5.7.33 dump, mode 0600, outside the repository), restored as root over the socket into the devenv MySQL 8.4 `legacy` database. The importer read it through the SELECT-only `legacy_reader`. |
| Target | Neon project `bold-poetry-64036846`, branch `rehearsal-0001-20261016-1004` created from `dev`. `drizzle-kit migrate` found the schema current; the import ran as `neondb_owner` over the direct (unpooled) connection, not Hyperdrive. |
| Importer | The source of `tools/import` and of `packages/db` is the tree of commit `2421c9a`; this pull request changes neither (it only adds importer tests). The run used the runbook of `tools/import/README.md`, steps 2 to 5, in one script that creates the branch, migrates it, imports, and deletes the branch on exit. |
| Files | `LEGACY_FILES_DIR` unset: copying the production file directories is not authorised yet, so every referenced file is reported missing and the 26 articles (whose images are required) are quarantined. |
| Secrets | `NEON_API_KEY` through `secretspec run` with a `SECRETSPEC_REASON`. No connection string was printed or written; `neonctl` read the key from its environment. |
| Cleanup | The branch was deleted by the script's exit trap; `neonctl branches list` afterwards shows `dev` and `production` only. The restored local `legacy` database was dropped and recreated empty, and `legacy_reader` kept its `SELECT` grant on `legacy.*`. |

Report checksums (SHA-256, first 16 hex digits): `reconciliation.json` `ad09223972b12361`, `reconciliation.md` `fb57269cc67355ed`. The report holds no timestamp, so a rerun on the same backup is byte-identical.

## Counts in and out: the three tables of spec 0001

Each count was also taken independently with `SELECT COUNT(*)` in MySQL before the import. "Out" is read back from the target inside the import's transaction, which rolls back on any difference from the plan.

| Table | Legacy rows in (importer) | `COUNT(*)` in MySQL | Rows out (Neon) | Quarantined | Duplicates | Orphans |
| --- | --- | --- | --- | --- | --- | --- |
| `department` | 5 | 5 | 5 | 0 | 0 repeated cities (the legacy schema has a unique key on `city`, so the source cannot hold one) | not applicable |
| `semester` | 28 | 28 | 28 | 0 | 0 identical (term, year) groups, so 0 collapsed | not applicable |
| `field_of_study` | 110 | 110 | 110 | 0 | not applicable | 0 with a NULL department, 0 with an absent department |

The backup holds no duplicate semester and no field of study without a department, so the reporting paths found nothing to report on real data. Tests exercise each path with fake rows: `tools/import/test/roundTrip.test.ts` runs collapsed semesters and a field of study whose department is NULL, absent or quarantined through real MySQL and PostgreSQL, and `tools/import/test/transform.test.ts` pins the repeated-city quarantine on the plan (MySQL cannot hold a repeated city, so only the pure plan can be tested with one).

## The other Phase 1 tables

These are outside the falsifier but are in the same report.

| Table | In | Out | Quarantined | Why |
| --- | --- | --- | --- | --- |
| `admission_period` | 93 | 92 | 1 | id 45: its end date is not after its start date |
| `article` | 26 | 0 | 26 | the images are required and no file copy was given |
| `article_department` | 49 | 0 | 49 | every tag points at a quarantined article |
| `static_content` | 44 | 44 | 0 |  |
| `sponsor` | 10 | 10 | 0 | the 10 logos are reported missing; a logo is optional |
| `social_event` | 10 | 9 | 1 | id 4: its end time is not after its start time |
| `public_file` | 42 referenced | 0 | 0 | no file copy |

## Personal-data check before committing

Run on the two report files, printing only counts:

- `@` characters: 0.
- Digit runs of 8 or more (telephone and account numbers): 0.
- Whole-word, case-insensitive matches against 9141 distinct tokens of three or more characters taken from the backup (every user first name, last name, user name, telephone, account number and company e-mail; every department name, short name, city, address and Slack channel; every field-of-study and sponsor name; sponsor URLs): the only hits are the report's own words `per`, `data`, `are` and `null`. No name appears.
