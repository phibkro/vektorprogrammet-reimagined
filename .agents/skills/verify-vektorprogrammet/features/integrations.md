# Integrations and scheduled jobs

An administrator reads the Google Workspace projection on the control panel's `Integrasjoner` page, and the Worker's scheduled handler runs the registered jobs that produce it (spec 0008). On this stack the projection is a **dry-run**: the directory is an empty local stand-in, the writer refuses (`WORKSPACE_MODE` is not set, so it is `dry-run`), and no call to Google exists without the operator's credentials, which are an open gate. What a run decided is the evidence: a `workspace_report` row, `job_run` rows, and no outbox row of kind `WorkspaceChange`. The jobs, their cadence and the proposed schedule are the generated table in `docs/system/administration.md`.

## Sub-features

- `integrations-page` an administrator opens `/kontrollpanel/integrasjoner` (the sidebar entry `Integrasjoner`, group `Administrasjon`) and reads `Skrivemodus:` with the badge `Av`; a team leader is refused with `403`.
- `team-group-address` `Nytt team` and `Rediger team` have the field `Google-gruppeadresse`; the address becomes the team's Google group in the report. An address that another team or a person already holds is refused (`Vektor-adressen er allerede i bruk.`); see [team memberships](./team-memberships.md).
- `report-request` `Bestill prøverapport`, then `Bestill rapport`, adds one `job_run` row of `workspaceSync` whose period is `request:<n>`. Only an administrator may ask.
- `scheduled-tick` `GET <origin>/cdn-cgi/handler/scheduled` runs the Worker's `scheduled` handler as the cron trigger does: the request is taken and completed, and the page then shows `Siste rapport` with `Status: complete`, `Modus: dry-run`, the counts, and the sections `Grupper`, `Kontoer`, `Ønskede avdelingslister` and `Uadministrerte oppføringer`.
- `dry-run-writes-nothing` the run queues no `WorkspaceChange` outbox row and changes nothing outside its report.
- `jobs-ledger` the tick's other jobs leave their own `job_run` rows; `workspaceSync` runs without a request only when its proposed schedule is approved, which it is not.

## How to get to it (user POV)

- Open `/kontrollpanel/integrasjoner` as an administrator, or choose `Integrasjoner` in the sidebar.
- Choose `Bestill prøverapport`, then `Bestill rapport` in the sheet. The page says `Ingen rapport ennå` or keeps the last report until a tick takes the request.
- Trigger the tick that the cron would: `GET <origin>/cdn-cgi/handler/scheduled` (the origin is in `state.env`). Reload the page.
- Set a team's group address on its page with `Rediger team`, field `Google-gruppeadresse`.

## Driving it with verify-vektorprogrammet

Preconditions:

- A fresh instance from `scripts/launch.sh` with `scripts/doctor.sh` at `DOCTOR OK`: the story creates the team `Integrasjonsteam` and its group address by fixed name, so it cannot run twice on one instance.
- `Ada Admin` acts, as the local test actor; `Lise Leder` is the person who is refused.

Steps:

- **Before.** `scripts/probe.sh "select count(*) from workspace_report" --name reports-before` and `scripts/probe.sh "select count(*) from job_run where job = 'workspaceSync' and period like 'request:%'" --name requests-before`. On a fresh instance both are `0`: the launch's tick ran the approved jobs, and `workspaceSync` is only proposed.
- **The committed story.** Run `scripts/drive.sh integrations.spec.ts`. Exit code `0`, 2 tests `passed`. As the spec performs it, as Ada Admin: `Nytt team` with `Navn` `Integrasjonsteam` and `Google-gruppeadresse` `integration@vektorprogrammet.no` (`Opprett`); on the team's page `Rediger team` changes the address to `integration-updated@vektorprogrammet.no` (`Lagre`); `/kontrollpanel/integrasjoner` shows the heading `Integrasjoner` and `Skrivemodus:` with `Av`; `Bestill prøverapport` and `Bestill rapport` add one request row; `GET /cdn-cgi/handler/scheduled` completes it (one more request row has outcome `done`); the page then shows `Siste rapport`, `Status: complete` with `dry-run`, the headings `Grupper`, `Kontoer` and `Ønskede avdelingslister`, and the updated address. The second test: Lise Leder gets `403` for the page.
- **Stored state, the second view.** `scripts/probe.sh "select id, period, mode, status, actual, counts, issues from workspace_report order by id" --name reports-after`: one row more than before, `mode` `dry-run`, `status` `complete`. Read `issues`: a team or a person without an address is a typed issue, never a guessed address. `scripts/probe.sh "select job, period, outcome, attempt, counts from job_run order by job, period" --name job-runs`: `semesters` (period of the current semester, for example `2026-HOST`) and `outboxSweep` (one row per tick) are `done`; `workspaceSync` has only its `request:<n>` row; `endingSoon` appears only in the last weeks of a semester.
- **Nothing was written.** `scripts/probe.sh "select kind, status, count(*) from outbox group by kind, status order by kind, status" --name outbox-after` has no row of kind `WorkspaceChange`, and `serve.log` has no line about a Workspace change or a call to Google.
- **Who may open it.** `scripts/page.sh /kontrollpanel/integrasjoner --as "Ada Admin" --name integrations-admin` prints `200` and `h1: Integrasjoner`; `--as "Lise Leder"` prints `403`, and her sidebar (`scripts/page.sh /kontrollpanel --as "Lise Leder"`) has no `/kontrollpanel/integrasjoner` link.
- **Look at it.** `scripts/shot.sh /kontrollpanel/integrasjoner integrations --as "Ada Admin"` after the story: the report with its tables.
- **Proof.** `scripts/report.sh --features "integrations-page, team-group-address, report-request, scheduled-tick, dry-run-writes-nothing, jobs-ledger"`; attach the drive log, `results-<n>.json`, `probes/reports-after.txt`, `probes/job-runs.txt`, `probes/outbox-after.txt` and the page captures of both people.

## Gotchas

- A request is taken at the next tick, not at submit: the page cannot show its report before `GET /cdn-cgi/handler/scheduled` (or the real cron on a deployment) ran. The spec triggers the Worker's real handler; do not call a job runner by another path and report it as the scheduled one.
- This stack proves the dry-run only. The real Google directory and writer, `WORKSPACE_MODE=write`, the nightly window and a removal cap above 20 are operator gates that no browser journey here crosses; the package tests `workspaceAdapters.test.ts` and `workspace.postgres.test.ts` cover the gate and the plan. Do not claim a Google call verified from this feature.
- The local directory is empty: every group is missing and every desired account and member is an addition (`Mangler` in the tables). That is the stand-in's answer, not a finding about production, where the directory is unconfigured and the report says so.
- Mail and Slack are not sent here: the capture sink keeps them in `captured_mail` and `captured_slack`, keyed by the outbox row (a message delivered twice is captured once).
- A failed run leaves `Integrasjonsteam` and its address behind. Clean up and relaunch before trying again.
