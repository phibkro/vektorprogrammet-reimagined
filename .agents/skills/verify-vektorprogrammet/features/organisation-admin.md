# Organisation admin

Staff maintain the organisation's core data on the control panel: departments (administrators create and edit; team leaders edit their own), semesters (a list only: the cron job makes them), and fields of study (a team leader manages those of their own department only). Every staff write lands in the audit log in the same transaction (specs 0001, 0003 and 0004; RULE-050, RULE-139, RULE-237).

## Sub-features

- `departments` `/kontrollpanel/avdelinger` lists the migrated departments; an administrator creates and edits them; a repeated city is refused.
- `semesters` `/kontrollpanel/semestre` lists semesters newest first; the job made the current and the next; the page has no create form and writes nothing.
- `fields-of-study` `/kontrollpanel/linjer`: a team leader lists, creates and renames the fields of their own department.
- `department-scope` a team leader of department A is refused with `403` on department B's field of study, with nothing changed.
- `events` the overview, the semester list and the form of `/kontrollpanel/arrangementer` name the same current semester (the spec does not save an event; creating one is not covered here).

## How to get to it (user POV)

- Open `/kontrollpanel` and choose `Avdelinger`, `Semestre`, `Linjer` or `Arrangementer` in the sidebar.
- On Avdelinger choose `Ny avdeling`, or `Rediger <department>` on a row.
- On Linjer choose `Ny linje`, or `Gi nytt navn til <field>`.

## Driving it with verify-vektorprogrammet

Preconditions:

- A fresh instance with `scripts/doctor.sh` at `DOCTOR OK`: the journey creates departments by fixed name and city, so it cannot run twice on one instance.
- Baseline rows: `scripts/probe.sh "select id, name, short_name, city, active from department order by id" --name departments-before` lists `Avdeling Alfa` and `Avdeling Beta`.

- **The committed story.** Run `scripts/drive.sh journey.spec.ts`. Exit code `0`, 5 tests `passed` (steps 1 to 4 and the department-scope falsifier). It asserts the column headers `Navn, Kortnavn, By, E-post, Status, Handlinger`, the row of `Avdeling Alfa` (`ALFA`, `Alfaby`, `kontakt@alfa.example`, `Aktiv`), the create and edit sheets, the refusal of a repeated city, the semester order, and the leader's department scope.
- **Stored state.** `scripts/probe.sh "select id, name, short_name, city, active from department order by id" --name departments-after` shows the new and edited departments; `scripts/probe.sh "select count(*) from audit_log" --name audit-after` is larger than before the story (each staff write adds an entry); `scripts/probe.sh "select id, term, year from semester order by year desc, term" --name semesters` lists the semesters and none was added by the page.
- **A forbidden write, by address.** The spec's forged-request tests post a capability the page hides and expect `403` with the stored row unchanged. Re-read the row with `scripts/probe.sh "select id, name, department_id from field_of_study order by id" --name fields-after`.
- **Look at it.** `scripts/shot.sh /kontrollpanel/avdelinger departments --as "Ada Admin"` and `scripts/shot.sh /kontrollpanel/avdelinger departments-leader --as "Lise Leder"`: Ada Admin has `Ny avdeling` and `Rediger` on every row; Lise Leder has `Rediger Avdeling Alfa` and `Vis Avdeling Beta`.
- **Proof.** `scripts/report.sh --features "departments, semesters, fields-of-study, department-scope"`; attach the drive log, `results-<n>.json`, the probes and the screenshots.

## Gotchas

- The journey is one serial story (`test.describe.configure({ mode: "serial" })`): a failed step skips the rest. Select single steps with `-g "step 3"` only on an instance that already holds the earlier steps' data.
- The legacy import collapses duplicate semesters and quarantines bad rows, so the baseline has fewer semesters and departments than the fixture's input (`import:fixture` prints `rows out/in`): assert against the database, not against the fixture's source.
- `semestre` is read-only by design (spec 0003): a missing create button is the expected state, not a gap.
- The shell spec (`shell.spec.ts`) also writes a department (its falsifier 4). Run it on its own instance, or after the journey with its names considered, never twice.
