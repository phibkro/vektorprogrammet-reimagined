# Spec 0001: Departments and semesters (Phase 1, first slice)

**Status:** draft, to freeze when its pull request opens · **Phase:** 1, Pilot: organisation core and public site (`MODERNIZATION_BRIEF.md`) · **Modules:** `dom:org`

## Journey

1. **An administrator** opens the control panel and sees the departments, each with name, short name, city, e-mail and active flag. The administrator can create a department and edit it; a city is unique.
2. **An administrator** sees the semesters, newest first, and creates the next one. Creating a semester that already exists is refused with a message.
3. **A team leader** manages the fields of study of **their own department only**: create, rename, list.
4. **Every part of the system** asks one function for "the current semester" and "is admission open for department D now". The answer is the same everywhere, including the public site, filters and forms.

The journey is done when steps 1-3 work in the browser on migrated data and step 4 is one tested domain function that every caller uses.

## Goal, constraints, values

- **Goal:** the first real slice of the new monorepo, end to end (UI → server function → domain → PostgreSQL), proving the stack and the migration path on the simplest, most-depended-on data.
- **Constraints (operator decisions, `INTENT.md`):** TanStack Start + React + shadcn/ui, Effect v4 on the server and domain side, Neon PostgreSQL through **Drizzle ORM**, Better Auth as a library, Cloudflare hosting, R2 storage. Drizzle details:
  - The Drizzle table schema is the single source; migrations come from `drizzle-kit generate`, and Effect Schemas come from `drizzle-orm/effect-schema`.
  - The current-semester write (RULE-237) is an insert with `onConflictDoNothing` against the unique (term, year) constraint.
  - This slice uses no storage and no external delivery.
- **Values:** the legacy system is the specification source, not the template. Each rule below is pinned by a test; nothing else from legacy is copied.

## Behavior contract for this slice

These rules must each have an executable test. The legacy citations are the oracle, except where §7 of the brief decided a replacement.

| Rule | What the test proves | Source of truth |
|---|---|---|
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

Source tables, from `analysis/vektorprogrammet/prod-schema.sql`, which reflects the 2024-08-22 backup:
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

The public site pages, articles, static text and files (later Phase 1 slices); admission periods as stored data (Phase 3); authentication beyond a test session (Phase 2 owns accounts; this slice uses a test-only actor, which only the test composition may construct).
