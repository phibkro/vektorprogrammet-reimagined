# Team memberships

Staff manage teams and the people in them on the control panel's Team and Personer pages. A membership ties a person to a team with a position and a term (start and end semester); the person's access follows their current memberships. A change never deletes history: extending moves the end, changing a position closes the old row and plans a new one, ending shortens the term (spec 0006, falsifier 10).

## Sub-features

- `team-create` an administrator or team leader creates a team in a department with a function and a default term in semesters.
- `person-register` a person is registered in a department through a field of study and appears in the list.
- `member-add` a leader adds a registered person as `Medlem` with the current semester as start and the team's default end.
- `principal-from-membership` switching to the new member shows them as `teammedlem` with the sections a member gets, and without `Nytt team`.
- `member-extend` `Forleng <name>` moves the end of the term; the digest's link `<team page>?forleng=<membership id>` opens the same form.
- `member-change` `Endre <name>` to position `Leder` keeps the old row and adds a row marked `Planlagt` with the new position.
- `member-end` `Avslutt <name>` shortens the term and keeps the row.
- `no-current-grant` a person with no team, or only an ended membership, reaches `Ingen tilgang`.
- `welcome-queued` a person's first membership queues two mails to their registered address, `Velkommen til <team>` and `Fullfør oppsettet med din Vektor-epost` (RULE-248), and the capture sink keeps both; a later membership of the same person queues nothing more (spec 0008, `welcome_ledger`).
- `team-group-address` `Nytt team` and `Rediger team` take an optional `Google-gruppeadresse`, the team's Google group in the Workspace report (spec 0008). An address that another team or a person already holds is refused with `Vektor-adressen er allerede i bruk.`; the report is in [integrations](./integrations.md).

## How to get to it (user POV)

- Open `/kontrollpanel/team` and choose `Nytt team`; open a team by its name link for its members page.
- Open `/kontrollpanel/personer` and choose `Registrer person`.
- On a team's page choose `Legg til medlem`, and the per-row buttons `Forleng`, `Endre` and `Avslutt` (each named with the person).
- Open a digest's extend link: the team page with `?forleng=<membership id>`.

## Driving it with verify-vektorprogrammet

Preconditions:

- A fresh instance from `scripts/launch.sh` with `scripts/doctor.sh` at `DOCTOR OK`: the story creates the team `Dokumentasjonsteam` and the people `Emma Utvider`, `Kaja Endrer` and `Einar Avslutter` by fixed name, so it cannot run twice on one instance.
- `Ada Admin` and `Lise Leder` are seeded; the seeded memberships are read in `scripts/probe.sh "select p.name, t.name as team, pos.name as position, m.leader from membership m join person p on p.id = m.person_id join team t on t.id = m.team_id join position pos on pos.id = m.position_id order by p.name" --name seed-memberships` (Lise Leder leads `Rekruttering`, Mats Medlem belongs to it, Sofie Styre belongs to `Styret`, Eva Ekstern's has ended).

- **The committed story.** Run `scripts/drive.sh teams.spec.ts`. Exit code `0`, 3 tests `passed` (the journey and the two no-grant people). The journey, as the spec performs it: Ada Admin creates the team in Avdeling Alfa (`Avdeling` option `1`, `Funksjon` `Rekruttering`, `Standardperiode (semestre)` `2`, then `Opprett`); registers the three people (`Registrer person`, `E-post`, `Navn`, `Linje` `1`, `Registrer`); Lise Leder opens the team and adds each as `Medlem` (`Legg til medlem`, `Person`, `Stilling`, `Legg til`); a switch to `Emma Utvider` shows `Emma Utvider, teammedlem` and the sidebar `Oversikt, Semestre, Team, Arrangementer`, no `Nytt team`, and `Avslutt Emma Utvider` but not `Avslutt Kaja Endrer`; back as Lise Leder the digest link extends Emma's term, `Endre Kaja Endrer` to `Leder` adds a `Planlagt` row, and `Avslutt Einar Avslutter` shortens his term.
- **Stored state, the second view.** After the story: `scripts/probe.sh "select m.id, p.name as person, pos.name as position, m.leader, m.start_term, m.start_year, m.end_term, m.end_year from membership m join person p on p.id = m.person_id join position pos on pos.id = m.position_id join team t on t.id = m.team_id where t.name = 'Dokumentasjonsteam' order by p.name, m.start_ordinal, m.id" --name team-after`. Expected: one row each for Emma Utvider and Einar Avslutter (their `end_*` differ from the values just after adding), two rows for Kaja Endrer (the second with position `Leder`).
- **The welcome mail, the second view.** After the story: `scripts/probe.sh "select recipient, subject from captured_mail where recipient in ('emma.extend@example.org', 'kaja.change@example.org', 'einar.end@example.org') order by recipient, id" --name welcome-after`. Expected: two rows for each of the three people (`Velkommen til Dokumentasjonsteam`, and `Fullfør oppsettet med din Vektor-epost`, which goes to the registered address because no Workspace account exists yet). `scripts/probe.sh "select p.name from welcome_ledger w join person p on p.id = w.person_id order by p.name" --name welcome-ledger` lists exactly these three, once each, although `Kaja Endrer` has two membership rows: a changed position is not a first membership. The committed story asserts the two mails for `Emma Utvider` after the first add; the other probes are your own second view.
- **Who sees what afterwards.** `scripts/page.sh /kontrollpanel --as "Emma Utvider"` prints `200` and `links: "/kontrollpanel" "/kontrollpanel/arrangementer" "/kontrollpanel/semestre" "/kontrollpanel/team"`; `scripts/page.sh /kontrollpanel --as "Nora Nybegynner"` prints `403` and `h1: Ingen tilgang`.
- **Look at it.** `scripts/shot.sh /kontrollpanel/team team-list --as "Lise Leder"`, then open the team's link from the page (its numeric id comes from `scripts/probe.sh "select id, name from team order by id" --name teams`) with `scripts/shot.sh /kontrollpanel/team/<id> team-members --as "Lise Leder"`: the table lists the members with `Aktiv` or `Planlagt` and the row buttons.
- **Proof.** `scripts/report.sh --features "team-create, person-register, member-add, principal-from-membership, member-extend, member-change, member-end"`; attach the drive log, `results-<n>.json`, `probes/team-after.txt`, the traces of the journey test and the screenshots.

## Gotchas

- In the committed story a switch of principal is the `vp-test-actor` cookie, not a session: it proves what the grant table says for that person, not an authentication flow (see [accounts](./accounts.md) for sign-in). A browser that also holds a Better Auth session ignores the cookie.
- Terms follow the current semester and the cron job's semesters. A launch in another semester changes the end labels the spec reads from the form, never what it asserts: they come from the page, not from constants.
- `Forleng` reads `Ny slutt` from a select; the spec takes the preselected option. A team with a default term of one semester may offer no later end, and the journey then fails for the reason, not for a bug in the spec.
- The overlap rule (no overlapping memberships of one person in one team) lives in the database; the race test for it is a package test (`packages/db`), not a browser journey. Do not claim it verified from this feature.
- A failed run leaves the team and people behind. Clean up and relaunch before trying again.
- The welcome mails go to the person's registered e-mail, not to a Vektor address: the dry-run provisions no Workspace account (spec 0008 R2), and the text says so when the person has no registered company address. Real delivery is not exercised here; the capture sink is what is observed.
