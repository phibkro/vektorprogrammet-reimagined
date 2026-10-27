# Accounts and sessions

A person signs in with their private e-mail and a password. A leader or administrator invites a person; the person activates the account from a link in an e-mail, manages their profile and sessions on `Min side`, changes their password, and can reset it through an e-mail link. An administrator can deactivate and reactivate an account, which ends its sessions. Reset requests answer the same for every account state, and wrong credentials, wrong codes and wrong states are refused alike (spec 0007, falsifier 7). A Better Auth session outranks the local `vp-test-actor` cookie.

## Sub-features

- `account-invite` a leader saves a person's Vektor e-mail on `Personer` and invites them; the invitation reaches the mailbox.
- `account-activate` the person opens the link from the mail, chooses a password with `Aktiver og logg inn` and lands on the control panel with the sidebar their membership gives (a team member: `Oversikt, Semestre, Team, Arrangementer`).
- `profile` `/min-side` shows and saves the profile, lists active sessions with `Opprettet:` and `Sist sett:`, ends another session, and changes the password.
- `account-reset` `/glemt-passord` (Turnstile-guarded) answers `Hvis en konto finnes …`; the mailed link sets a new password at `/tilbakestill-passord` and leads to `/logg-inn`.
- `account-deactivate` an administrator deactivates and reactivates (`Deaktiver <name>`, `Reaktiver <name>`); a deactivated person's open page turns into `Ikke innlogget`, a reactivated person's returns to `Min side`.
- `reset-privacy` `POST /api/account/request-reset` gives one identical answer for active, invited, deactivated, unknown and company addresses and queues one intent; refused activation and reset codes answer exactly like a wrong password; five wrong sign-ins end in `429`.

## How to get to it (user POV)

- Open `/logg-inn` and sign in (`E-post`, `Passord`, `Logg inn`); `/etter-innlogging` and `/kontrollpanel` or `/min-side` follow.
- Open the activation link from an invitation e-mail (`/aktiver?…`), or the reset link (`/tilbakestill-passord?kode=…`).
- Open `/glemt-passord` from the sign-in page.
- Open `/min-side` while signed in.
- Staff: `Personer` → `Rediger <name>`, `Inviter <name>`, `Deaktiver <name>`, `Reaktiver <name>`.

## Driving it with verify-vektorprogrammet

Preconditions:

- A fresh instance with `scripts/doctor.sh` at `DOCTOR OK` and outbound network (the reset form uses Turnstile).
- Seeded accounts: `lise.leder@example.org` and `ada.admin@example.org` sign in with the local fake password `LOCAL_FAKE_PASSWORD`, `vektor-test-passord` (`packages/db/src/localPeople.ts`; fake, local only); the address of a seeded person is `<first>.<last>@example.org`, lower case. Which people have an account is data: after the whole suite ran, `account` held Active rows for Ada Admin, Lise Leder, Mats Medlem and Nora Nybegynner and none for Sofie Styre or Eva Ekstern (read it with the probe below, do not assume).
- Real sessions need a context without the `vp-test-actor` cookie, or with a session: with a Better Auth cookie present the test-actor cookie is ignored, and a stale or deactivated session is anonymous, not Ada Admin.

- **The committed story.** Run `scripts/drive.sh accounts.spec.ts`. Exit code `0`, 2 tests `passed`. The first: Lise Leder saves Mats Medlem's Vektor e-mail and invites him; the mailbox row appears; his browser context opens the link, activates with a password, sees the four sidebar entries, edits his profile, signs in a second context (a phone user agent), sees `2` active sessions, ends the other one, changes the password, resets it from the mailed link in the second context, signs in again with the new password, and Ada Admin deactivates then reactivates him. The second: five reset requests (active, invited, deactivated, unknown, company address) get byte-identical `303` answers and one queued intent; four code refusals match the wrong-password refusal; a fifth wrong sign-in is `429`.
- **The mailbox, the second view.** The non-production mailbox is a table, and its row is the only stored copy of a link: `scripts/probe.sh "select id, recipient, subject, sent_at from captured_mail order by id" --name mailbox`. (Do not save the `text` column into evidence: it holds a working activation or reset link. The run is disposable, but a link in a review comment is still a credential.) `serve.log` shows `outbox message captured (non-production deployment)` lines with the kind only.
- **Account states.** `scripts/probe.sh "select p.email, a.state from account a join person p on p.id = a.person_id order by p.email" --name account-states` before and after the spec. The invitee ends `Active` after passing through `Deactivated`; the second test leaves three `privacy-…` rows (`Deactivated`, `Deactivated`, `Invited`).
- **What a visitor without a session gets.** `scripts/page.sh /min-side --as anonymous` prints `200` with `h1: Ikke innlogget` (the page renders the not-signed-in view with status 200, unlike the control panel's `403`). The helper sends the test-actor cookie only, so it shows the cookie path, not a real session; for a real session use the spec or your own browser after `/logg-inn`.
- **Look at it.** `scripts/shot.sh /logg-inn sign-in --as anonymous` and the same with `--phone`; the form has `E-post`, `Passord` and `Logg inn`.
- **Proof.** `scripts/report.sh --features "account-invite, account-activate, profile, account-reset, account-deactivate, reset-privacy"`; attach the drive log, `results-<n>.json`, the traces, `probes/mailbox.txt` and `probes/account-states.txt`.

## Gotchas

- Login uses real Better Auth cookies on `localhost`: a browser context that signed in as one person and later gets the `vp-test-actor` cookie for another is still the first person. Use fresh contexts (the spec does), or sign out.
- The spec mixes origins from `baseURL`: always the origin printed in `state.env`, not `127.0.0.1`, or the cookies do not travel.
- Both tests write by fixed addresses (`mats.medlem@example.org`, the `privacy-…` people) and the second creates fake people without credentials. They run once per instance.
- A rate limit applies per IP header: the spec sends `cf-connecting-ip: 192.0.2.77`; a hand-made probe that repeats wrong sign-ins from the same address trips `429` for the later requests of the same run.
- Code delivery sends outside the command's transaction; a queue row `IssueCode` carries no plaintext code. Do not look for the code in `outbox`: the mailbox holds it.
