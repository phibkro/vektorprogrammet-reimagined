# Control panel sidebar

The control panel at `/kontrollpanel` shows each person exactly the sections their grants allow, and each page renders only the controls the person may use. Both come from the domain's grant table, not from a role list in the web code. A person with no current grant, and a visitor who is not signed in, get a page that says so and no navigation at all (spec 0004, falsifiers 1 to 5; spec 0006).

## Sub-features

- `sidebar-by-person` the sidebar lists exactly the sections the signed-in person may use, and each entry opens its page.
- `sidebar-refused` no current grant gives `403` with `Ingen tilgang`; no sign-in gives `403` with `Ikke innlogget`; neither page has a sidebar or any link into the panel.
- `controls-by-grant` a control the person lacks is not rendered at all (not hidden, not disabled).
- `forged-request` a request for a capability the page does not offer is refused by the server with `403` and changes nothing.
- `sheet-forms` create and edit happen in a right-hand sheet; Escape and `Avbryt` close it and return focus to the opener.
- `sidebar-responsive` at 1280 px the sidebar collapses to icons and back; at 390 px it opens as an off-canvas panel.
- `admin-grants` the Administratorer page grants and removes another person's place; revoking one while another remains succeeds, while removing the last place that outlasts the current semester is refused.
- `actor-switch` the local-only `Testaktør (virker bare lokalt)` list on the overview switches the signed-in person.

## How to get to it (user POV)

- Open `/kontrollpanel` (the site's `Til nettsiden` link leads back out).
- Choose a person in the `Testaktør (virker bare lokalt)` list on the overview. This is the local stand-in for sign-in; real sign-in is spec 0007.
- Open a section address directly: `/kontrollpanel/avdelinger`, `/semestre`, `/linjer`, `/team`, `/personer`, `/administratorer`, `/arrangementer`.

## Driving it with verify-vektorprogrammet

Preconditions:

- `scripts/doctor.sh` printed `DOCTOR OK` (it already checks Ada Admin, Nora Nybegynner and an anonymous visitor).
- A fresh instance if you also run `shell.spec.ts` (its falsifier 4 creates a department).

- **The committed story.** Run `scripts/drive.sh shell.spec.ts`. Exit code `0`, all tests pass (Playwright prints the count), covering sidebar per person (Ada Admin, Lise Leder, anonymous), controls per grant on five pages, the forged request, the sheet, and both viewports. It saves screenshots into `screenshots/`.
- **Admin-place grant, revoke and last-place refusal.** In a browser as `Ada Admin`, open `/kontrollpanel/administratorer`. Click `Gi administratorplass`, choose `Nora Nybegynner`, set `Til (dato og klokkeslett)` to a future time far ahead (for example `2099-12-31T12:00`) and submit `Gi plass`; the list now has Ada and Nora. Click `Fjern plassen til Nora Nybegynner`, submit `Fjern`, and confirm Nora is gone while Ada remains. Now grant `Lise Leder` an admin place ending after now but before the active semester boundary (the windows end at Aug 1 for Vår and Jan 1 for Høst; for Høst 2026, use `2026-12-31T23:00`). Switch the `Testaktør` to Lise and open the page again. Click `Fjern plassen til Ada Admin` and submit. The expected message, `Den siste administratorplassen …`, is issue #26, being fixed in separate PR `fix/hidden-field-errors`; until that merges, the observed result is a `400`, the sheet stays open, and Ada’s row and database grant remain unchanged.
- **What each person gets, from the server.** Run `scripts/page.sh /kontrollpanel --as "<person>"` for each person and compare the `links:` line:
  - `Ada Admin`: `/kontrollpanel /administratorer /arrangementer /avdelinger /linjer /personer /semestre /team`.
  - `Lise Leder`: the same without `/administratorer`.
  - `Mats Medlem`: `/kontrollpanel /arrangementer /semestre /team`.
  - `Sofie Styre`: `/kontrollpanel /arrangementer /personer /semestre /team`.
  - `Nora Nybegynner` and `Eva Ekstern`: `403`, `h1: Ingen tilgang`, empty `links:`.
  - `anonymous`: `403`, `h1: Ikke innlogget`, empty `links:`.
- **A forbidden section by address.** `scripts/page.sh /kontrollpanel/administratorer --as "Lise Leder"` prints `403`; `--as "Ada Admin"` prints `200`.
- **Look at it.** `scripts/shot.sh /kontrollpanel panel-lise --as "Lise Leder"` and `scripts/shot.sh /kontrollpanel panel-lise-phone --as "Lise Leder" --phone`. The footer reads `Innlogget som Lise Leder, teamleder`; the entries are grouped `Generelt`, `Organisasjon`, `Innhold` (and `Administrasjon` for Ada Admin).
- **Switch person in the browser.** Open `/kontrollpanel` with your driver as `Ada Admin` (cookie `vp-test-actor=Ada Admin` on `localhost`), choose the button `Lise Leder` in the `Testaktør` list; the overview now says `Innlogget som Lise Leder, teamleder`, the sidebar loses `Administratorer`, and the cookie value is `Lise Leder`.
- **Proof.** `scripts/report.sh --features "sidebar-by-person, sidebar-refused, controls-by-grant, forged-request, admin-grants"`; attach the `page.sh` outputs for every person, the browser trace/screenshots of the admin grant journey, the drive log and `results-<n>.json`.

## Gotchas

- The sidebar is derived from the grant table, and `apps/web/test/shell.test.ts` and `teamsPanel.test.ts` compare controls with commands. A change that edits a role list in `apps/web/src` is itself the finding (AGENTS.md, Conventions).
- A principal without the page's read gets HTTP 403 on direct navigation (issue #15, fixed by PR #19), not 200 with an empty list. Drive it with scripts/page.sh /kontrollpanel/personer --as "Mats Medlem": require 403 and no person list; the same path for "Ada Admin" returns 200 with the list.
- The `Testaktør` list has one button per person in the database, so people a journey registered appear in it too.
- Without a cookie the instance acts as `Ada Admin`. A check run without `--as` or the cookie can pass for the wrong person.
- `shell.spec.ts` passed on an instance where `journey.spec.ts` had not run (first run, 2026-10-27); its header says it runs after the journey. Its falsifier 4 creates a department, so a second run on the same instance collides.
