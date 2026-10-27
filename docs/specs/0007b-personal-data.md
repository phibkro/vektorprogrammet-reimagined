# Spec 0007b: Personal data: declarations, consent, export, erasure, merge and retention

**Status:** frozen when PR opens; later changes are dated entries under [Revisions](#revisions) · **Phase:** 2 · **Source:** brief §7 "Information model and personal data" (accepted 2026-10-26); `docs/system/administration.md` § Personal data; INFORMATION_MODEL §11.3–§11.4, §11.7, §11.9, §11.11; ADR 0004, 0008, 0010; specs 0006, 0006b and 0007. Split on 2026-10-27 from the draft "Accounts, sessions and personal data". Built on main at `79bbecf`, which has specs 0006, 0006b and 0007 and ADR 0010's text; [R1](#r1-2026-10-27-reconciliation-with-main-before-any-code) says how the draft meets them.

## Journey

1. **On Min side** a signed-in person answers each consent separately, downloads everything held about them as JSON, or asks to be erased.
2. **When a person's last engagement ends**, they get an e-mail with two questions: keep my details for 5 years, and send me alumni news. Each answer is one click, without signing in, and can be changed later on Min side.
3. **Every night** the retention job deletes or anonymises what has reached the end of its period, and writes counts, never values, to the audit log.
4. **An admin merges** two records of one person (who applied under one e-mail and joined under another). Every row of the second record follows the first.
5. **Anyone** reads the privacy notice on the contact form, generated from the same declarations as the record of processing.

## Goal, constraints, values

- **Goal:** the personal-data rules of ADR 0004 as running code: one declaration per personal field drives the privacy notice, the record of processing and the retention job, and the rights of access, erasure and consent work.
- **Constraints:**
  - **Personal data is declared once.** Each field of an entity schema in `packages/domain` carries `PersonalData { purpose, legalBasis, retention: { trigger, duration }, onExpiry }` or `NotPersonal(reason)`; a reference to a person (`audit_log.person_id`, `public_file.uploaded_by`) is personal. A real-PostgreSQL test lists every column of the migrated schema and fails on one without either, so the check closes over the schema and not over guessed names. `tools/docgen` (spec 0006) renders the record of processing (Art. 30) and the privacy notice between markers in `docs/system/administration.md` (`check:docs`); a `PrivacyNotice` component shows the same declarations on the contact form (`apps/web/src/components/site/contactTabs.tsx`) and, in spec 0009, on the application and alert forms. The classification is a field annotation that the effx `DomainDescription` can carry later (ADR 0009); it is not a second list.
  - **The retention job runs as `System("retention")`.** It reads the declarations, compiles each into one conditional statement per table from a closed set of triggers (`Column`, `LastActivityEnd`, `PeriodEnd`, `SemesterEnd`, `FiscalYearEnd`), works in chunks, and writes one audit row per run with integer counts in a new `counts` column. A person's core fields are anonymised 1 year after the later of the end of their last engagement and the end of the admission period of their last application (their creation if neither exists), or 5 years while a `keepDetails` consent is current. Engagement rows are kept 10 years, so the history row outlives the anonymisation. One database view, `person_last_activity_end`, is that derivation; spec 0011 adds placements to it.
  - **Consent** is the value `ConsentRecord { textVersion, givenAt, withdrawnAt? }`, reused by every consent (specs 0009 and 0010); `AlumniConsent { person, keepDetails, news }` holds one record per box. Each consent text is declared data with a version, and a record can name only the current version. A request row per person and engagement end (unique) makes the alumni e-mail idempotent.
  - **The `alumniConsent` code purpose** joins spec 0007's `Code` construct: 60 days, reusable until then (an answer can be corrected), narrowed to `answerAlumniConsent` on its own record.
  - **Photos** are stored only under a current photo consent; withdrawing it removes the photo.
  - **Hyperdrive:** no advisory locks, no LISTEN/NOTIFY; jobs are idempotent through conditional statements. Every new read is registered with the SELECT-only role test.
- **Values:** one fact, one home: the retention of a field is its declaration's.

## Declarations (new kernel use)

- **System principals** `retention` and `alumniConsent` join the closed set of spec 0006 R1; each acts only through its own grant (`runBy` in the command declaration).
- **Commands (`PersonalDataRpc`):**

| Command | Granted to | Scope |
| --- | --- | --- |
| `setPhoto(file, consent)` | `Self ∪ Leader(d)` | own / department |
| `setAlumniConsent`, `answerAlumniConsent(code, keepDetails, news)` | `Self`; the `alumniConsent` code | own |
| `exportMyData` (audited, changes no data) | `Self` | own |
| `eraseMe`, `erasePerson` | `Self`, `Admin` | own, all |
| `mergePersons(a, b)` | `Admin` | all |
| `runRetention`, `sendAlumniConsent` | `System("retention")`, `System("alumniConsent")` | — |

- **The initial retention schedule** (§11.3, §11.7, §11.9) is declared with each entity; this slice declares and tests the rows whose entities exist when it lands, and the table-driven test picks up every later row.

| Data | Declared by | Trigger → duration | On expiry |
| --- | --- | --- | --- |
| Person core (name aside), consents, photo | 0006, here | last activity end → 1 year, 5 with `keepDetails`; photo also when consent is withdrawn | anonymise |
| Engagement rows (membership, placement) | 0006, 0011 | end → 10 years | delete |
| Account, sessions, codes | 0007 | with the person core; session expiry; code expiry + 30 days | delete |
| Audit rows | here | 3 years (proposed) | delete |
| Outbox rows | 0008 | delivered → 30 days (proposed) | delete |
| Applications, responses, `specialNeeds`, subscriptions, claims, bank numbers | 0009, 0010, 0012 | as in `administration.md` § Personal data | as there |

## Behavior contract

| Rule | After |
| --- | --- |
| RULE-117 | No user is deleted: `erasePerson` anonymises and keeps the history row |
| RULE-142, 160 | `setPhoto` by `Self ∪ Leader(d)` and only under a current consent |
| — (new) | `exportMyData`, `eraseMe` and `erasePerson` with legal holds, alumni consent, `mergePersons` and the retention job (GDPR Art. 7, 15, 17, 20) |

## Falsifiers (definition of done)

1. **Declarations are complete and generated.** Every column of the migrated schema is `PersonalData` or `NotPersonal`; adding a column without either fails. `check:docs` passes on the record of processing, the privacy notice and the "legacy role → new permissions" report; one retention value changed without regenerating fails it. The notice on the contact form lists exactly the personal fields of its input schema.
2. **Retention.** A table-driven real-PostgreSQL test derives rows one second inside and one second outside each declared period, so a new declaration is tested without a new test. One run removes or anonymises exactly the expired rows, a second run changes nothing, 20 concurrent runs end in the same state, and the audit row holds integer counts and no value of the seeded data. A person is anonymised 1 year after their last activity, 5 with `keepDetails` (withdrawing falls back to 1); engagement rows stay 10 years. Skipping one declared rule fails the test.
3. **Export.** `exportMyData(p)` returns exactly the rows keyed by p. A property over generated multi-person data finds no other person's value in it, and a test over the catalog finds every table with a `PersonalData` column keyed by a person in the export or in a declared exclusion with a reason.
4. **Erasure with holds.** `eraseMe` anonymises the person core; deletes the account, sessions, consents and subscriptions; keeps the history rows. With an open claim, or when it would remove the last Active admin, it is refused with the reason and nothing changes. Claims under accounting retention are reported as held with their end date and stay. A second call changes nothing. A scan finds no value of the erased person outside the held rows; skipping the person core fails the scan.
5. **Alumni consent.** When a person's last engagement ends (the date passes, or `endEarly`) and no other engagement is current, one run sends one e-mail with two boxes and a second run sends none. Each box is answered by the code and by Min side through one command path; "news yes, keep no" is stored as two records with text version and time; withdrawing one leaves the other.
6. **Merge.** `mergePersons(a, b)` moves every row of b to a in one transaction and leaves a tombstone without personal data. A test over the database catalog fails when a table that references `person` has no merge rule. Overlapping memberships in one team, two placements in one semester or two accounts refuse the merge with a typed conflict and no change; 20 concurrent merges of one pair have one winner; a second Person cannot verify an e-mail that a verified Person holds.
7. **Browser journey.** Playwright: a signed-in person answers both consents, downloads their data (the file holds their rows and no seeded other person's), and the alumni-consent link from the capture sink records an answer without sign-in. CI is green, and the pull request's Worker Preview serves the privacy notice on the contact form.

## Open for the operator

These are recorded and do not block code (operator approval 2026-10-26).

- **Three proposed periods:** alert subscriptions 2 years without an opening, audit rows 3 years, delivered outbox rows 30 days (`administration.md`). The declaration holds these values until the operator confirms or changes them.
- **Texts:** the privacy owner (the national board leader) approves the generated privacy notice and the consent texts. The design is not legal advice (§11).
- **Processors:** every service on an organisation-owned account with a data processing agreement (Neon, Cloudflare, Google Workspace) before go-live (ADR 0004).
- **Production input for the Phase 2 exit:** the production `access_rule` export that the "legacy role → new permissions" report compares against; every difference in that report is approved by the operator.

## Out of scope

The applications, interviews and claims declarations (their own specs add rows); the public team page that would show photos; the breach runbook (Art. 33), which is the privacy owner's document.

## Revisions

### R1 (2026-10-27): reconciliation with main before any code

The draft was written before spec 0006b and 0007 landed and before ADR 0010 was decided. The journey, the goal and the falsifiers stand. These are the places where the draft meets what main now has, decided before the code so that a reviewer can disagree with a decision before there is a diff.

**What main gives, and what it changes in the draft**

1. **Aggregate locks (spec 0006b).** Every write to a table that the Person root owns takes a `Locked<"Person">`.
   - `consent` and `alumni_request` are new tables that the Person root owns (owner column `person_id`). `packages/db/src/aggregate/ownership.ts` declares them; the closure test fails until it does, and the lint rule `no-owned-table-write` rejects a Drizzle write of either outside `Aggregates`. The new columns of the person's own row (`photo_key`, `anonymised_at`, `merged_into`) change only through `updateRoot`.
   - The nightly job and erasure write owned tables through tokens too. A statement compiled from a declaration does not leave the construct: the job reads which people have an expired row, locks all of them in ascending order (`lockAll`, in chunks, before its first write), and writes through `Aggregates`, whose `update` and `remove` accept the tokens of several owners (`owner IN (…)`). The decision "is it still expired" is made by the statement that writes, after the lock, so a membership added after the unlocked read keeps its person. A row that no root owns (`outbox`, `audit_log`, the Better Auth tables, `captured_mail`, `public_file`) is a conditional bulk statement.
   - Merge locks the admin list and then both people. It moves accounts and admin places, so it takes `lockAdminList` first (spec 0006b R2 item 4: a command that changes a place or deactivates or reactivates an account locks the list), then `lockAll("Person", [into, from])` in ascending id order. Rows move with a new writer, `Aggregates.reassign(from, to, owned)`, which needs both tokens; `update` cannot do it, because it refuses to set the owner column (`ProtectedColumn`).
   - A merged person cannot be locked. `ownership.ts` gives a root an optional `tombstone` column; `Person` names `mergedInto`. `lock` and `lockAll` leave a row whose tombstone is set out of their one statement and answer `NotFound`, so a stale request for the second record is refused like a missing person and the tombstone cannot gain rows. A second merge of the same pair loses the same way. This is one more condition in the lock statement, not a second statement.
   - `erasePerson` locks the admin list first as well: it deletes an account and decides through the list's token (`isLastActiveAdmin`) that the person is not the last Active administrator. The nightly job needs no list lock: a valid admin place counts as activity until it ends (item 8), so no person with a place that still counts is ever expired, and the job never removes an account that counts.
2. **ADR 0010.** Every command carries `resource` and `method`, in the shape that the command-resources change declares: `info({ summary, resource, method, … })`, `resource` an `EntityName` and `method` one of `get`, `list`, `create`, `update`, `delete` or a custom verb with a leading colon. A custom command's tag starts with its verb, and `(resource, method)` is unique across domains. The eight commands of this slice:

   | Command | Resource | Method | Granted to |
   | --- | --- | --- | --- |
   | `setPhoto` | `Person` | `:set` | `Self ∪ Leader(d)` |
   | `setAlumniConsent` | `Consent` | `:set` | `Self` |
   | `answerAlumniConsent` | `Consent` | `:answer` | `Holder(alumniConsent)` |
   | `exportMyData` | `Person` | `:export` | `Self` |
   | `erasePerson` | `Person` | `:erase` | `Self`, `Admin` |
   | `mergePersons` | `Person` | `:merge` | `Admin` |
   | `runRetention` | `Retention` | `:run` | `System("retention")` |
   | `sendAlumniConsent` | `Consent` | `:send` | `System("alumniConsent")` |

   The draft's `eraseMe` and `erasePerson` were one verb on one resource with two grants. `(Person, :erase)` may be held once, and `endEarly` already shows that one command has several grant rows, so there is one command, `erasePerson`, granted to `Self` at scope `own` and to `Admin` at scope `all`; "eraseMe" is the Min side button's wording. `Consent` and `Retention` join `EntityName` (the audit rows name them), with the `audit_log_entity` migration that each such name needs. Until the command-resources change is on main, the two fields are carried by `info()` in the same shape and the kernel's version replaces ours on rebase.

3. **The `Code` construct (spec 0007).** `alumniConsent` joins `CodePurpose`. `codePolicy` already says per purpose which command it opens and how long it lives; it gains the two other facts that were `if` statements elsewhere, so a purpose is declared once: `singleUse` (`activation` and `resetPassword` are consumed, `alumniConsent` is not: it lives 60 days and an answer can be corrected until then, so use validates and never consumes) and `account` (the Account state that the purpose needs: `Invited`, `Active`, or none; an alumnus may have no account). `codePrincipal` and the code mail read these instead of `purpose === "activation"`. The code is minted at delivery like the others (spec 0007 R1): the outbox row names the purpose and the person and holds no secret. A new request replaces the older code of the person (RULE-220). The code principal is narrowed to `answerAlumniConsent` on the person's own record.
4. **System principals.** `retention` and `alumniConsent` join `SystemJob` (the `audit_log_system_job` check follows). The cron tick that runs every 10 minutes runs `sendAlumniConsent` and then the outbox sweep; `runRetention` has a cron of its own, once a night (`RETENTION_CRON`, dispatched on `controller.cron`).
5. **No Better Auth write from a command, except to delete.** Spec 0007 says that a command never writes an auth table in its transaction. Erasure and retention delete the person's `auth_user` row (sessions and credentials follow by `ON DELETE CASCADE`) and expired sessions in the same transaction as the person core: an erasure that left a name and an e-mail address in `auth_user` until a retried delivery ran would not have erased, and its receipt (the commit) would say more than the state. Nothing is written to those tables, only deleted, and the library holds no state outside them. `NotOwned` in `ownership.ts` says so.

**What the draft assumed that main does not have**

6. **Columns and tables.** `person` has no creation time, which "their creation if neither exists" needs, and no photo, anonymisation marker or merge pointer: `created_at` (default `now()` for existing rows, set from the `Clock` for new ones), `photo_key` (references `public_file`), `anonymised_at` and `merged_into` (references `person`). `consent` and `alumni_request` are new. `audit_log` gains `counts` (jsonb, a check that every value is a number). `person_last_activity_end` is a view (a migration, since Drizzle cannot model it): the later of the end of the last membership, the end of the last admin place and, with spec 0009, the last application's admission period, and the person's creation when there is none. Views hold no data of their own, so the closing test lists base tables.
7. **The declaration is a catalog of stored tables.** The draft puts `PersonalData` or `NotPersonal` on each field of an entity schema. The retention job, the export, the erasure and the merge act on stored columns, and falsifier 1 closes over the migrated schema, but the entity schemas of the domain (`Person`, `Membership`, …) do not map one to one to rows (a `Membership`'s two semesters are four columns, a `Person`'s department is a join). So `packages/domain/src/personalData/` holds one declaration per stored column, grouped by table, written beside the entities that each domain owns (`teams/personalData.ts`, …), and a form's input schema carries its own declaration of what the form collects, which names the stored column that holds it (`storedIn`) and takes its retention from there. The test closes the catalog over the schema in both directions (a column without a declaration fails, and so does a declaration of a column that is not there) and over every foreign key to `person` (each has an export, an erasure and a merge rule). The declaration is still data that effx's `DomainDescription` can read later; nothing else lists the columns by hand.
8. **Retention values, one declaration each.** Each period is one named value with an `approval` of `decided` or `proposed`; the generated documents print "proposed, awaiting operator approval" next to a proposed one, and approving is a one-line change. A valid admin place counts as activity until it ends, in `person_last_activity_end` (the draft derived it from engagements and applications only): without it the job would anonymise the account of an administrator whose place outlasts their membership, and the last Active administrator could vanish. The initial schedule:

   | Data (tables) | Trigger → duration | On expiry | Status |
   | --- | --- | --- | --- |
   | Person core: name, e-mail addresses, e-mail verified, photo (`person`) | last activity end → 1 year, or 5 years while a `keepDetails` consent is current | anonymise | decided |
   | Consents, alumni requests, account, Better Auth user and credentials, digest ledger, file uploader reference | with the person core | delete (`public_file.uploaded_by`: set to null) | decided |
   | Engagement history (`membership`) | the end of the end semester → 10 years | delete | decided |
   | Sessions (`auth_session`, `auth_verification`) | expiry | delete | decided |
   | Codes (`code`) | expiry → 30 days | delete | proposed |
   | Admin places (`admin_grant`) | end of the place → 3 years | delete | proposed |
   | Audit rows (`audit_log`) | the row's time → 3 years | delete | proposed |
   | Outbox rows (`outbox`) | the row's creation → 30 days (a delivered row is delivered within hours, and a dead one never is, so `delivered_at` alone would keep it) | delete | proposed |
   | Captured mail (`captured_mail`, non-production) | the mail's time → 30 days | delete | proposed |

   `PeriodEnd` and `FiscalYearEnd` are in the closed set of triggers and have a compiled statement and a test on a throwaway table; no declaration uses them until applications (0009, 0010) and claims (0012) exist.

9. **Export and erasure are the declarations read in two other ways.** `exportMyData` is one `SELECT jsonb_build_object(…)` generated from the catalog: one statement, so one snapshot, with every table that names the person as its key, the declared column exclusions (credential hashes and session tokens) and nothing from a table that declares an exclusion with its reason (the outbox and the mail sink: transport copies that address a person by e-mail and hold other people's text). `erasePerson` is the early expiry of the rows whose retention is the person core's: it runs the declared `onExpiry` now, for this person, and keeps what a table declares as kept with a reason (history rows, audit rows). It writes nothing a declaration does not name, which is why a new declaration is erased with no new code. A person under a legal hold is refused with the reason and nothing changes. The only hold that exists today is the last Active administrator. Claims and accounting retention are spec 0012's: this slice defines the hold seam (`LegalHolds`, one source per entity) and the falsifier runs against a source that the test registers, so 0012 adds one source and the table-driven tests pick it up.
10. **Merge.** The merge rule of each reference to a person is data in the catalog: `move` (memberships, admin places by holder, Better Auth user), `refuse when both have one` (accounts, Better Auth user), `newest decision` (consents), `drop the second's` (codes, requests, the digest ledger rows that would collide) and `follow` (the soft references `audit_log.person_id` and `entity_key`, `public_file.uploaded_by`). `admin_grant.granted_by` stays and names the tombstone: the grant history keeps saying who granted, and the tombstone is a person with no data. A place that the second person's record holds and that the first person granted would become the first's own and breaks `admin_grant_not_self`: the check refuses it, and the merge reports a typed conflict. The tombstone is the second row, anonymised, with `merged_into` set.
11. **Alumni consent.** A person is asked when they have at least one membership, every membership has ended, their core is not yet past its 1-year period (the request would be sent to someone about to be anonymised), and no request exists for that engagement end. The request row and the outbox row commit together under the person's lock; the unique row is the idempotency. A "no" is stored as a record that was given and withdrawn at the same instant: the person was asked, which text they saw, and when; one record per box and person (`consent` is unique on `(person_id, kind)`), so a later change replaces it. The code and Min side share one function (`recordConsent`) behind two commands.
12. **Photo.** `setPhoto` is granted, declared and tested, and stores a photo only under a current `photo` consent (which it records when given with the file), clearing it when the consent is withdrawn. No Min side control or team page shows it: the public team page that would show photos is out of scope in this spec, and an upload form whose result nobody sees would store personal data for nothing.
13. **Not built here.** The "legacy role → new permissions" report of falsifier 1 is a Phase 2 exit criterion that compares the new grant table with the production `access_rule` export, which is not in the repository (`analysis/vektorprogrammet/access-rules-export.csv`; the draft lists it under "Open for the operator"), and no generator for it exists. It is not personal data, and it belongs to the slice that has its input. Falsifier 1 here covers the record of processing and the privacy notice.

**Operator gates, unchanged and still open**

14. The periods marked `proposed` in item 8, the generated privacy notice and the three consent texts (`keepDetails`, `news`, `photo`) are **proposed, awaiting operator approval**. Each is one declaration with an `approval` field (`packages/domain/src/personalData/periods.ts`, `texts.ts`), and the notice component shows a "Utkast" label while its text is not approved, so a Preview never passes a draft off as approved. The processors and the production `access_rule` input are as in "Open for the operator".

### R2 (2026-10-27): what the build changed against R1

The code is written and the falsifiers are run. These are the places where it differs from, or adds to, what R1 decided. The journey, the goal and the seven falsifiers stand.

15. **The names follow ADR 0010 as main has it.** R1 declared the eight commands before spec 0007c merged. After the rebase onto it, each carries `resource` and `method` in its required shape (`setPhoto`, `setAlumniConsent`: `Person`/`Consent` and `:set`; `answerAlumniConsent`: `Consent`, `:answer`; `exportMyData`: `Person`, `:export`; `erasePerson`: `Person`, `:erase`; `mergePersons`: `Person`, `:merge`; `runRetention`: `Retention`, `:run`; `sendAlumniConsent`: `Consent`, `:send`), `Consent` and `Retention` are in `EntityName`, and the completeness test passes. `codePolicy.activation.command` is `activateAccount` after its rename. `runWithCode` lives in `accounts/principal.ts` because the alumni answer runs by a code too, and it takes the domain whose command the purpose opens: `runWithCode(AccountDomain, "activation", …)` and `runWithCode(PersonalDataDomain, "alumniConsent", …)`. Its refusal is `domain.forbidden(codePolicy[purpose].command)` (spec 0007c R2), so a purpose whose command another domain owns does not compile; `packages/domain/test/kernel/forbidden.test.ts` pins both sides (the account purposes name account commands, the alumni purpose names a personal data command and not an account one). `personResource` moved to `packages/domain/src/teams/personResource.ts` and is shared by `createAccount`, `updatePerson` and `setPhoto`.
16. **The shape of a retention rule and of a merge rule.** A `RetentionRule` groups the personal columns of a table by their retention and the kind of their expiry. A `Delete` rule removes the row. An `Anonymise` rule sets each column to the value that the column declares (`Flag`, `Null`, `PerRow` or `Text`) and stamps the table's marker in the same statement, so a row is never half anonymised; a column that is the table's own key (`public_file.uploaded_by`) needs no marker, because a row without its key is no longer found. `Move` carries `collisions` and the `refusal` text, and `Single` carries its `message`: a refused merge returns the Norwegian text of the rule that refused it, and `MERGE_REFUSED` is the default for a constraint that no key names (the overlap of two memberships in one team).
17. **The admin list's root row is declared.** `admin_list`, the one row that the admin list's lock takes (spec 0006b R2), is a stored table of the closure, so the catalog declares it. It holds nothing about a person.
18. **A consent record after a withdrawal.** `answerRecord(kind, given, at, previous)` keeps the time and the text version of the consent that was given and adds when it was withdrawn; a "no" from a person who had not said yes is given and withdrawn at the same instant. Both commands pass the person's earlier record as `previous`.
19. **What the person's reads hide.** `PersonRepository.list` leaves out anonymised people (a merged record is one), `PersonRepository.create` sets `created_at` from the `Clock`, and `PublicFileRepository.register` makes a key that was removed live again.
20. **Erasure reaches the mail that names the person.** It deletes, in the same transaction, the outbox rows and the captured mail that carry the person's address. An `IssueCode` message already in the outbox names a person and not an address, so the code mail checks the address before it mints: a person whose address anonymisation wrote (`anonymisert-<id>@vektorprogrammet.invalid`, `.invalid` never resolves) gets no code and no mail, and the message is acknowledged. The same check holds for a person who is merged away (the lock refuses a tombstone) and for a purpose whose account is gone.
21. **The code mail reads the purpose's policy.** `codePolicy[purpose].account` says which account state a purpose needs (`null`: none), so `AccountDelivery.issueCode` has no `if` on the purpose. The alumni mail names `/alumni?kode=` and the lifetime that the policy gives, in days.
22. **Each answer is one click.** Min side and the page of the e-mail show each question with the text from `consentTexts`, and a "Ja" button and a "Nei" button that answer that question alone. They run through server functions, and the page of the e-mail is the only public one: a wrong code gets the refusal and records nothing. The download is a form post to `/api/eksport` (a command is never a GET), and an erasure ends on `/slettet`. An administrator can erase a person on their behalf from the People page, which is how a person with no account is erased.
23. **The retention cron.** `RETENTION_CRON` (`17 2 * * *`, 02:17 UTC) is declared in `apps/web/worker.config.ts` beside the tick's cron. `alchemy.run.ts` and the standalone `vite.config.ts` register both, and `scheduled` dispatches on `controller.cron`. The tick also runs the alumni consent job before the sweep.
24. **The importer.** `tools/import` truncates its tables without `CASCADE`, so the new tables had to be named: the first run of the browser stack failed on `consent` and `alumni_request` (`cannot truncate a table referenced in a foreign key constraint`). They are in its list, and a target that holds a consent is refused like one that holds an account, because the importer cannot restore it.
25. **Documents.** `docs/system/administration.md` has five generated blocks: the retention schedule, the record of processing, the privacy notices, the consent texts and the personal data commands. The code policy table of `accounts.md` gained the account and single-use columns. `recordOfProcessing` groups columns by their expiry kind and not by the value that each is anonymised to, so a purpose is one row.
26. **Nothing for legal holds yet.** `LegalHolds` is registered with an empty source. Falsifier 4's part about holds is shown with a source that the test registers; expense claims (spec 0012) add the first real one. The confirmation page of an erasure does not repeat what a hold keeps, because no hold can exist yet.

**Evidence, per falsifier**

| Falsifier | Where it is shown |
| --- | --- |
| 1 | `packages/db/test/personalDataClosure.postgres.test.ts` (every table and column declared both ways, the merge rule of every foreign key to `person`, and controls that add a column or a table); `packages/domain/test/personalData/catalog.test.ts` (one negative control for each kind of inconsistency) and `notice.test.ts`; `tools/docgen/test/render.test.ts` (the generated blocks, with controls); `apps/web/test/site.test.ts` and the browser test of the contact notice |
| 2 | `packages/db/test/retention.postgres.test.ts` (one test per rule, each with a control that skips that rule) and `retentionPeople.postgres.test.ts` (1, 5 and 10 years, the audit counts, 20 concurrent runs, a run that waits for a held lock, with its control); the browser test of the cron through the Worker's `scheduled` handler |
| 3 | `packages/db/test/personalDataExport.postgres.test.ts` (a person's export, a property over generated multi-person data, and a control that exports every person's rows and is caught); the browser test that saves the file |
| 4 | `packages/db/test/personalDataErasure.postgres.test.ts` (the scan, a control that skips the person core, holds, the last Active admin, a second call) |
| 5 | `packages/db/test/personalDataAlumni.postgres.test.ts`; `apps/web/test/alumniDelivery.postgres.test.ts` (the mail, the 60-day code, an erased person, with its control); the browser test of the link |
| 6 | `packages/db/test/personalDataMerge.postgres.test.ts` (conflicts, 20 concurrent merges, the verified e-mail) and `personalDataMergeRace.postgres.test.ts` (300 rounds each of a merge against a membership write, a profile write, an invite and a consent answer, with controls); the browser test of the People page |
| 7 | `apps/web/e2e/personalData.spec.ts`; the Worker Preview of the pull request is the lead's gate |
