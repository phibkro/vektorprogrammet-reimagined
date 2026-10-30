# Admission periods and applications

Spec 0009. Staff of a department schedule an admission period (`Opptak` in the control panel); while it is open, anyone with no account finds the department on `/soknad`, fills in `/soknad/<department>` and sends it (Turnstile and the rate limit first); the post stores a **new unverified person**, the application and one `IssueCode` message; the mail carries a link to `/soknad/bekreft?kode=…` whose one button spends the code and verifies the address. A known verified address is joined to an application only by that button (RULE-306): the new person is merged into the holder and leaves a tombstone. Staff see the applications with `Bekreftet` or `Ikke bekreftet`, register applicants at a stand and withdraw applications.

## Sub-features

- `period-schedule` `/kontrollpanel/opptak`, `Nytt opptak`: a department, a semester, `Start (norsk tid)` and `Slutt (norsk tid)`; one period per department and semester; the row reads `Planlagt`, `Åpent` or `Avsluttet` from the dates and the clock, and offers `Forleng` (a later end only) and `Avlys` (only before the start, with no application).
- `apply-index` `/soknad` lists the departments whose admission is open now under `Åpent opptak` (`Søk i <kortnavn>`); with none open it says so.
- `apply-form` `/soknad/<department>`: name, e-mail, field of study, year of study, bolk, the days that suit, double position, teams, gender (optional), where they heard of us (optional), special needs with **its own unticked consent**, the privacy notice (`#personvern`), the Turnstile widget and `Send søknad`. The post works without script: a refusal shows the page again with what was typed and the messages; a success is 303 to `?sendt=1`.
- `verify-link` `/soknad/bekreft?kode=…` shows `Bekreft e-postadressen`; pressing it verifies the address (`Takk! E-postadressen din er bekreftet.`); the same link a second time, a wrong code and a code whose mail has not gone out say the link cannot be used, with no reason.
- `staff-list` `/kontrollpanel/opptak` lists the applications of the departments the actor may see (a leader or a member of the recruitment team); `Registrer søker` (a period of the current semester) and `Trekk søknad` are on the rows.

## How to get to it (user POV)

- As `Ada Admin`: `Opptak` in the sidebar, `Nytt opptak`, a window that is open now (`2020-01-01T08:00` to `2099-12-31T22:00` is wide enough for a story).
- As nobody: `/soknad`, the link `Søk i …`, the form. The mail is in `captured_mail` (the non-production mailbox is the only stored copy of the link).

## Driving it with verify-vektorprogrammet

Preconditions:

- `scripts/doctor.sh` printed `DOCTOR OK`. The fixture's periods are from 2024, so no department is open until the story schedules one.

Steps:

- **The browser test.** `scripts/drive.sh admission.spec.ts` (two tests): schedule, apply with the consent box unticked (refused with the domain's message), tick it, send, read the mail from `captured_mail`, press the button, see `Bekreftet` for the first applicant and `Ikke bekreftet` for a second one that nobody verified.
- **What was stored.** `scripts/probe.sh "select a.state, p.email, p.email_verified from application a join person p on p.id = a.person_id order by a.id"` shows the two applications; the outbox rows of kind `IssueCode` carry the person and the purpose and no code (`select payload from outbox where kind = 'IssueCode'`).
- **Refusal.** `scripts/page.sh /kontrollpanel/opptak --as "Mats Medlem" --name opptak-medlem` prints `200` (a member of the recruitment team holds `viewAdmission`); `--as "Sofie Styre"` prints `403` (the board team holds none of its commands); `--as anonymous` prints `403`.
- **Proof.** `scripts/report.sh --features "period-schedule, apply-form, verify-link, staff-list"`.

## Gotchas

- The specs create their period and applications by fixed names and addresses, so a story that has run once on an instance cannot run again there.
- A department with no open period shows no link on `/soknad`, and its `/soknad/<department>` page says the admission is not open: the page is a view, and the refusal is the server's, at the post.
- The spec's special-needs consent is **in the application row** (version and time), not in `consent`: a person's Min side does not list it. It is deleted with the application, six months after the period ends (proposed).
