# Control panel sidebar

The control panel at `/kontrollpanel` shows each person exactly the sections their grants allow, and each page renders only the controls the person may use. Both come from the domain's grant table, not from a role list in the web code. A person with no current grant, and a visitor who is not signed in, get a page that says so and no navigation at all (spec 0004, falsifiers 1 to 5; spec 0006).

## Sub-features

- `sidebar-by-person` the sidebar lists exactly the sections the signed-in person may use, and each entry opens its page.
- `sidebar-refused` no current grant gives `403` with `Ingen tilgang`; no sign-in gives `403` with `Ikke innlogget`; neither page has a sidebar or any link into the panel.
- `controls-by-grant` a control the person lacks is not rendered at all (not hidden, not disabled).
- `forged-request` a request for a capability the page does not offer is refused by the server with `403` and changes nothing.
- `sheet-forms` create and edit happen in a right-hand sheet; Escape and `Avbryt` close it and return focus to the opener.
- `sidebar-responsive` at 1280 px the sidebar collapses to icons and back; at 390 px it opens as an off-canvas panel.
- `actor-switch` the local-only `Testaktør (virker bare lokalt)` list on the overview switches the signed-in person.

## How to get to it (user POV)

- Open `/kontrollpanel` (the site's `Til nettsiden` link leads back out).
- Choose a person in the `Testaktør (virker bare lokalt)` list on the overview. This is the local stand-in for sign-in; real sign-in is spec 0007.
- Open a section address directly: `/kontrollpanel/avdelinger`, `/semestre`, `/linjer`, `/team`, `/personer`, `/administratorer`, `/arrangementer`.

## Driving it with verify-vektorprogrammet

Preconditions:

- `scripts/doctor.sh` printed `DOCTOR OK` (it already checks Ada Admin, Nora Nybegynner and an anonymous visitor).
- A fresh instance if you also run `shell.spec.ts` (its falsifier 4 creates a department).

- **The committed story.** Run `scripts/drive.sh shell.spec.ts`. Exit code `0`, 17 tests `passed`: sidebar per person (Ada Admin, Lise Leder, anonymous), controls per grant on five pages, the forged request, the sheet, and both viewports. It saves screenshots into `screenshots/`.
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
- **Proof.** `scripts/report.sh --features "sidebar-by-person, sidebar-refused, controls-by-grant, forged-request"`; attach the `page.sh` outputs for every person, the drive log and `results-<n>.json`.

## Gotchas

- The sidebar is derived from the grant table, and `apps/web/test/shell.test.ts` and `teamsPanel.test.ts` compare controls with commands. A change that edits a role list in `apps/web/src` is itself the finding (AGENTS.md, Conventions).
- Observed at `9ee265f`: `Mats Medlem` opens `/kontrollpanel/personer` by address and gets `200` with the empty list `Ingen personer å vise ennå` and no `Registrer person` button, although the sidebar does not list `Personer` for him. Confirm against spec 0006 before calling it a defect or accepting it: it is what the build did, not a statement of the intended rule.
- The `Testaktør` list has one button per person in the database, so people a journey registered appear in it too.
- Without a cookie the instance acts as `Ada Admin`. A check run without `--as` or the cookie can pass for the wrong person.
- `shell.spec.ts` passed on an instance where `journey.spec.ts` had not run (first run, 2026-10-27); its header says it runs after the journey. Its falsifier 4 creates a department, so a second run on the same instance collides.
