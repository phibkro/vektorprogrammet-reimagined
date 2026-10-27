# Vektorprogrammet verification map

This directory is the maintained source for verifying the user-facing behavior of the reimagined Vektorprogrammet site. Read this index before driving anything, then use the matching feature file as the recipe. Commands are written relative to the skill directory, `.agents/skills/verify-vektorprogrammet/` (so `scripts/doctor.sh` means `.agents/skills/verify-vektorprogrammet/scripts/doctor.sh`).

## Baseline preconditions

- `scripts/launch.sh` is running under a supervisor and printed `VERIFY READY origin=<url> cms=<url>`. It created a disposable migrated PostgreSQL database, filled it from the importer's fake legacy fixture, added the six seeded people, started the CMS with the fixture's articles, texts and sponsors, and started `vp dev` with the `local` deployment and Cloudflare's always-pass Turnstile keys.
- `scripts/doctor.sh` printed `DOCTOR OK`. Never drive an instance that did not.
- The instance belongs to this run: one per worktree, ports and database drawn at random, listed in the run directory's `state.env`. Never drive an origin you did not launch.
- The machine has outbound network: the contact form's Turnstile widget and verification call Cloudflare's servers.
- Seeded data at launch (read from the first run, 2026-10-27): departments `Avdeling Alfa` (short name `ALFA`, Alfaby, `/kontakt/alfaby`) and `Avdeling Beta` (`BETA`, Betaby); four semesters, the current one named by the wall clock (`Høst 2026` on that day) and the next (`Vår 2027`) made by the cron job that the launch runs once; teams `Rekruttering` and `Styret` in Avdeling Alfa; CMS articles (`/nyhet/opptak-apner`), texts, FAQ and one sponsor; and a synthetic public-file object registered under `state.env`’s `E2E_PUBLIC_FILE_KEY`. The people:

| Person (cookie value) | What they are | What they may open in the control panel |
| --- | --- | --- |
| `Ada Admin` | holds an admin place, no membership | everything, including Administratorer |
| `Lise Leder` | leads the recruitment team of Avdeling Alfa | everything but Administratorer |
| `Mats Medlem` | member of the recruitment team | Oversikt, Semestre, Team, Arrangementer |
| `Sofie Styre` | member of the department's board team | Oversikt, Semestre, Team, Personer, Arrangementer |
| `Nora Nybegynner` | registered, no team | nothing: `403 Ingen tilgang` |
| `Eva Ekstern` | membership ended last semester | nothing: `403 Ingen tilgang` |
| `anonymous` | nobody | nothing: `403 Ikke innlogget` |

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise. The specs change the database (they create departments, teams and people by fixed names), so a story that has run once cannot run again on the same instance: clean up and relaunch for a fresh story.
- Two ways to be someone. The local test actor is the `vp-test-actor` cookie, whose value is a person's name or `anonymous`; it exists only under `DEPLOYMENT=local`, and without the cookie the instance acts as `Ada Admin`: always name the actor (`scripts/page.sh` and `scripts/shot.sh` require `--as`). Real sign-in (spec 0007, [accounts](./accounts.md)) makes a Better Auth session, and a session outranks the cookie; a stale or deactivated session is anonymous. Both exist side by side on this instance: say which one acted.
- Prefer ARIA roles and accessible names over CSS selectors (the repository's specs do: `getByRole`, `getByLabel`). The interface is Norwegian; quote labels exactly.
- The repository's own specs in `apps/web/e2e` are the committed recipes. Run them with `scripts/drive.sh <spec> -g "<title regex>"`; they take a trace of every action.
- Treat a Playwright pass as proof of the spec's claims only. Anything the changed code does that no spec names needs your own drive: `scripts/page.sh` for what the server decided, `scripts/shot.sh` for what it looked like, `scripts/probe.sh` for what it stored.
- Do not remove proof artifacts during cleanup. They live in the run directory, outside the worktree.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen: a screenshot or trace of the action, a `scripts/probe.sh` read of the stored row, and the capture-sink lines in `serve.log` for mail.
- Record the feature ID and the entry point used with every artifact (`--name`/`--features`). `scripts/report.sh --features "<ids>"` writes it into `REPORT.md`.
- Report an unreachable path with the attempted command and the unmet precondition. Do not report a skipped entry point as verified through a different path (the no-JS contact post is not covered by the browser form, and the other way round).
- A feature file's journey that fails stays failed: record the reason under that file's `Gotchas` after the run, never weaken the journey.

## Features

- [Public site](./public-site.md) covers the anonymous pages, CMS publishing, public file responses, and legacy URL redirects.
- [Contact form](./contact-form.md) covers the browser form with Turnstile, the no-JS post, the refusals, and the queued mail and Slack messages.
- [Control panel sidebar](./control-panel-sidebar.md) covers each seeded person's reads, admin-place grant and revoke rules, forged requests, and the sidebar on desktop and phone.
- [Team memberships](./team-memberships.md) covers the spec 0006 journey: create a team, register people, add, extend, change and end memberships, and switch principal.
- [Organisation admin](./organisation-admin.md) covers departments, semesters (read-only), and fields of study with their department scoping.
- [Accounts and sessions](./accounts.md) covers spec 0007: invitation, activation, profile and sessions, password change and reset, deactivation, and the identical answers of the reset and refusal paths.
- [Personal data](./personal-data.md) covers spec 0007b: the two consent questions on Min side, the JSON export and the erasure of a person's own data, the alumni e-mail link, the administrator's merge and erasure, the nightly retention cron, and the privacy notice on the contact form.
