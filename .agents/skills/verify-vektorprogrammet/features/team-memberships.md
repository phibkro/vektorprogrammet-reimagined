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
- **Who sees what afterwards.** `scripts/page.sh /kontrollpanel --as "Emma Utvider"` prints `200` and `links: "/kontrollpanel" "/kontrollpanel/arrangementer" "/kontrollpanel/semestre" "/kontrollpanel/team"`; `scripts/page.sh /kontrollpanel --as "Nora Nybegynner"` prints `403` and `h1: Ingen tilgang`.
- **Look at it.** `scripts/shot.sh /kontrollpanel/team team-list --as "Lise Leder"`, then open the team's link from the page (its numeric id comes from `scripts/probe.sh "select id, name from team order by id" --name teams`) with `scripts/shot.sh /kontrollpanel/team/<id> team-members --as "Lise Leder"`: the table lists the members with `Aktiv` or `Planlagt` and the row buttons.
- **Proof.** `scripts/report.sh --features "team-create, person-register, member-add, principal-from-membership, member-extend, member-change, member-end"`; attach the drive log, `results-<n>.json`, `probes/team-after.txt`, the traces of the journey test and the screenshots.

## Gotchas

- Local sign-in is the `vp-test-actor` cookie (spec 0007 brings real accounts), so a switch of principal is a cookie, not a session: the journey proves what the grant table says for that person, not an authentication flow.
- Terms follow the current semester and the cron job's semesters. A launch in another semester changes the end labels the spec reads from the form, never what it asserts: they come from the page, not from constants.
- `Forleng` reads `Ny slutt` from a select; the spec takes the preselected option. A team with a default term of one semester may offer no later end, and the journey then fails for the reason, not for a bug in the spec.
- The overlap rule (no overlapping memberships of one person in one team) lives in the database; the race test for it is a package test (`packages/db`), not a browser journey. Do not claim it verified from this feature.
- A failed run leaves the team and people behind. Clean up and relaunch before trying again.
