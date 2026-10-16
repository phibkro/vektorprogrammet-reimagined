# Spec 0001: Departments and semesters (Phase 1, first slice)

**Status:** frozen when PR opens (slice 0000 passed on a deployed Worker, [`0000-results.md`](0000-results.md); every later change is a dated entry under [Revisions](#revisions)) · **Phase:** 1, Pilot: organisation core and public site (`MODERNIZATION_BRIEF.md`) · **Modules:** `dom:org`

## Journey

1. **An administrator** opens the control panel and sees the departments, each with name, short name, city, e-mail and active flag. The administrator can create a department and edit it; a city is unique.
2. **An administrator** sees the semesters, newest first, and creates the next one. Creating a semester that already exists is refused with a message.
3. **A team leader** manages the fields of study of **their own department only**: create, rename, list.
4. **Every part of the system** asks one function for "the current semester" and "is admission open for department D now". The answer is the same everywhere, including the public site, filters and forms.

The journey is done when steps 1-3 work in the browser on migrated data and step 4 is one tested domain function that every caller uses.

## Goal, constraints, values

- **Goal:** the first real slice of the new monorepo, end to end (UI → server function → domain → PostgreSQL), proving the stack and the migration path on the simplest, most-depended-on data.
- **Constraints (operator decisions, `INTENT.md`):** TanStack Start + React + shadcn/ui, Effect v4 on the server and domain side, Neon **PostgreSQL 18** through **Drizzle ORM**, Better Auth as a library, Cloudflare hosting, R2 storage. Drizzle details:
  - The Drizzle table schema is the single source of the tables; migrations come from `drizzle-kit generate`. The Effect Schemas of the domain types live in `packages/domain` (R5); the database reads their closed value sets and decodes every row through them.
  - The current-semester write (RULE-237) is one statement, `INSERT … ON CONFLICT (term, year) DO UPDATE SET term = EXCLUDED.term RETURNING *`, against the unique (term, year) constraint (R1).
  - This slice uses no storage and no external delivery.
- **Values:** the legacy system is the specification source, not the template. Each rule below is pinned by a test; nothing else from legacy is copied.

## Behavior contract for this slice

These rules must each have an executable test. The legacy citations are the oracle, except where §7 of the brief decided a replacement.

| Rule | What the test proves | Source of truth |
| --- | --- | --- |
| RULE-033 (P0) | A date in January-July is spring ("Vår") of that calendar year; August-December is autumn ("Høst"). 2026-07-31 → Vår 2026; 2026-08-01 → Høst 2026; 2026-10-15 → Høst 2026. | Legacy `Utils/SemesterUtil.php:15-40` |
| RULE-022 (P0) | Vår Y is [Y-01-01 00:00, Y-08-01 00:00); Høst Y is [Y-08-01 00:00, (Y+1)-01-01 00:00), at **Europe/Oslo** wall-clock time. | Legacy `Entity/Semester.php:76-92`. See the equivalence note below. |
| RULE-050 (P1) | Semester order is by year, with Vår before Høst within a year. "Between" includes both bounds, and a missing bound is open-ended. | Legacy `Entity/Semester.php:181-230`; the int-vs-string year defect is made impossible by the typed value. |
| RULE-144 (P1) | Creating a semester that exists is refused, and nothing is saved. Selectable years run from 2012 to next year. | Legacy `Controller/SemesterController.php:38-71` |
| RULE-237 (P1) | When "the current semester" has no row, it is created. Creation is idempotent under concurrency: two simultaneous requests yield one row. | Legacy `Entity/Repository/SemesterRepository.php:57-68`; concurrency is new and needs a unique constraint. |
| RULE-139 (P1) | A team leader creates and edits fields of study only in their own department; other departments' entries are refused. | Legacy `Controller/FieldOfStudyController.php:23-52` |
| RULE-015 (P0, decided) | CURRENT admission period is the one whose window contains now. If there is none, LATEST is the period with the most recent start in the past. A period that has not started is never current or latest. | Brief §7 (operator, 2026-10-15). It replaces legacy `Entity/Department.php:128-174`. |
| RULE-119 (P0, decided) | Admission is open when start ≤ now < end. The same function serves every caller. | Brief §7 (operator, 2026-10-15). It replaces legacy `Entity/Department.php:179-190` and `AdmissionPeriod::hasActiveAdmission`. |

**Equivalence note (RULE-022).** Legacy stores and compares instants at one-second resolution with an inclusive end of 23:59:59. A half-open end at the next 00:00:00 gives the same answer for every instant legacy can represent. The only difference is the sub-second gap 23:59:59.x, which legacy left uncovered and this closes. The test asserts both boundary instants: `Y-07-31 23:59:59` is in Vår, and `Y-08-01 00:00:00` is in Høst.

**Time zone.** Legacy uses server-local time and never names a zone. The assumption is that the server ran on Europe/Oslo [INFERENCE]. The new system computes in Europe/Oslo explicitly, through the injected clock service, and stores UTC.

**Scope boundary for RULE-015/119.** Admission periods belong to Phase 3. This slice delivers the two decisions as pure, tested domain functions over typed periods, with fixtures. Phase 3 wires them to stored admission periods.

## Data and migration

Source tables, from `analysis/vektorprogrammet/prod-schema.sql`, which reflects the 2024-08-22 backup. The tests read the vendored structure `tools/import/test/fixtures/legacy-phase1-schema.sql`; the rehearsal (falsifier 4) restores the real backup (R3):

- `department`: id, name, short_name, email, address, city (unique), logo_path, latitude, longitude, active, slackChannel.
- `semester`: id, semesterTime (varchar), year (varchar). **There is no unique key**, so the import must detect duplicate (semesterTime, year) rows and report them rather than guess.
- `field_of_study`: id, department_id (nullable), name, short_name.

Target: PostgreSQL tables with typed columns and constraints the legacy schema lacked: unique (term, year) on semesters, unique city on departments, and a non-null department on fields of study (rows without one are quarantined and reported). The import runs against a disposable copy, never production, and reports counts in, counts out, and every quarantined row by id.

## Falsifiers / definition of done

- [ ] Every rule in the table has an executable test that fails if the rule is broken. Each test is named with its rule id.
- [ ] The RULE-022 boundary tests pass for `2026-07-31T23:59:59 Europe/Oslo` (Vår) and `2026-08-01T00:00:00 Europe/Oslo` (Høst), including across a daylight-saving change.
- [ ] Concurrency test: 20 parallel "current semester" calls on an empty table produce exactly one row.
- [ ] Import rehearsal on a disposable copy of the backup: departments, semesters and fields of study are imported. Duplicates and orphans are reported, and the reconciliation report is attached to the pull request.
- [ ] A team leader from department A is refused (403) on department B's field of study, in a browser test and at the server function.
- [ ] CI runs format, lint, typecheck and these tests on the pull request.

## Not in this slice

The public site pages, articles, static text and files (later Phase 1 slices); admission periods as stored data (Phase 3); authentication beyond a test session (Phase 2 owns accounts; this slice uses a test-only actor, which only the `local` deployment may construct (R6)).

## Revisions

The spec is frozen when its pull request opens. Everything below was decided before that point and changes the text above; each entry names the old text, the new text and the reason. A later change needs a new dated entry.

### R1 — RULE-237 is `DO UPDATE … RETURNING`, not `onConflictDoNothing` (2026-10-16)

- **Was:** "an insert with `onConflictDoNothing` against the unique (term, year) constraint".
- **Now:** `INSERT … ON CONFLICT (term, year) DO UPDATE SET term = EXCLUDED.term RETURNING *`. One statement returns the row, whether it was just inserted or already existed.
- **Why:** architecture critique m4 ("the outcome comes from the database, not from catching an error"). With `DO NOTHING` the losing concurrent caller gets no row back and needs a second statement to read it. `DO UPDATE` (a no-op write of the same term) returns the existing row in the same statement, so 20 simultaneous callers all receive the one row. The cost is one new row version per call, so a caller on a hot path asks once per request.
- **Unchanged:** RULE-144 (a staff create) keeps `ON CONFLICT (term, year) DO NOTHING RETURNING`. There, "no row returned" is the refusal ("Semesteret <term> <year> finnes allerede"), and the database decides it. Slice 0000 check 5 ran both forms through Hyperdrive on Neon (`0000-results.md`).

### R2 — PostgreSQL 18 (2026-10-16)

- **Was:** "Neon PostgreSQL" with no version.
- **Now:** PostgreSQL 18. Neon project `bold-poetry-64036846` runs 18.x and devenv runs PostgreSQL 18.6, so a local migration and the real-PostgreSQL tests rehearse the deployed server. Slice 0000 ran on 18.6.
- **Why:** the devenv server was 17.11 until 2026-10-16; the spec must name the version the tests and the deployment share.

### R3 — The tests read a vendored source schema (2026-10-16)

- **Was:** "Source tables, from `analysis/vektorprogrammet/prod-schema.sql`", a file outside this repository.
- **Now:** the importer's tests create the legacy tables from `tools/import/test/fixtures/legacy-phase1-schema.sql`, the Phase 1 `CREATE TABLE` statements copied verbatim from the production structure-only dump (source and checksum in its header), and fill them with fake rows. The rehearsal (falsifier 4) restores the real backup `vektor-backup_2024-08-22.sql` into the devenv MySQL, never into the repository.
- **Why:** pull request #1 vendored the structure so the tests run in CI and on any clone. The backup holds personal data and stays outside the repository.

### R4 — Status (2026-10-16)

- **Was:** "draft, to freeze when its pull request opens".
- **Now:** "frozen when PR opens". Slice 0000 passed (12 of 12 checks, `0000-results.md`), on one condition that this slice keeps: `enable_request_signal` stays in `apps/web/worker.config.ts`.

### R5 — The domain's Effect Schemas are not derived from `drizzle-orm/effect-schema` (2026-10-16)

- **Was:** "Effect Schemas come from `drizzle-orm/effect-schema`".
- **Now:** the Effect Schemas of the domain types are written in `packages/domain`. `packages/db` reads the closed value sets from the domain (`Term` and the others), so the database `CHECK` and enum values cannot disagree with the domain, and decodes every stored row through the domain schemas. A row that fails to decode is a defect. `drizzle-orm/effect-schema` is not used.
- **Why:** architecture §2 keeps `domain` free of `db`, so the importer, the web app and the database share one pure model. Brands and normalising decoders (`EmailAddress`, trimmed text, `SanitizedHtml`) cannot be derived from column types. The dependency runs from the domain to the database constraints, not the other way round.

### R6 — The test actor exists only in a `local` deployment (2026-10-16)

- **Was:** "a test-only actor, which only the test composition may construct".
- **Now:** the test actor is built only when `DEPLOYMENT=local` (`vp dev` and the browser tests), selected by the `vp-test-actor` cookie. `preview` and `production` can never yield a staff actor, so every staff command there is `Forbidden`. `apps/web/test/sandbox.test.ts` proves it.
- **Why:** a cookie-selected actor is a local development aid, and the deployment decoded at the composition root is the one switch that makes it unreachable elsewhere.

### R7 — A refusal is the HTTP status of the server function's reply (2026-10-16)

- **Was:** falsifier 5 says "refused (403) … in a browser test and at the server function" and does not say where the 403 is visible. A TanStack server function answers 200 with a serialized `Outcome`, so a refusal was a 200 that carried a failure.
- **Now:** a function middleware (`apps/web/src/server/outcomeStatus.ts`) sets the failure's status, chosen once by the error table (`server/errors.ts`), as the HTTP status of the reply: 403 `Forbidden`, 409 `AlreadyExists`, 400 `ValidationFailed`, 404 `NotFound`. The client still decodes the `Outcome` body, so no caller changed. The browser test asserts the status on the wire and the message on the page; the server-function tests assert the typed `Forbidden` outcome.
- **Why:** a refusal that is only visible to our own client is not a 403. Proxies, logs and monitoring see the status.

### R8 — The browser journey runs Playwright on importer-migrated data (2026-10-16)

- **Was:** "steps 1-3 work in the browser on migrated data", with no runner and no data source named.
- **Now:** `@playwright/test` 1.63.0 drives the Chromium that devenv provides, against the real `vp dev` (the `local` deployment) and a disposable PostgreSQL database that `packages/db` migrates and the real importer fills from its fake legacy fixture (`tools/import`, script `import:fixture`). The data has the importer's own quirks (a quarantined department, collapsed duplicate semesters). The real-backup rehearsal (falsifier 4) is separate evidence on a Neon branch.
- **Why:** Vitest's browser mode runs the test code inside the page and cannot observe a separately started application's cookies, server-function round trips and response statuses; Playwright's own runner can. The version is pinned to the nixpkgs `playwright-driver` build that devenv provides.
