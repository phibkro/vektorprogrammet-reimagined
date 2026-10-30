# Spec 0009: Admission periods and applications

**Status:** in progress; frozen when its PR opens; later changes are dated entries under [Revisions](#revisions) · **Phase:** 3 · **Source:** the draft `analysis/vektorprogrammet/spec-drafts/0009-admission.md`; `docs/system/admission.md`; brief §3 Phase 3, §4 "Apply to become an assistant", §7; INFORMATION_MODEL §9.3, §9.7, §10.1, §10.3 A, §11.3–§11.4, §11.7, §11.9; ADR 0004, 0006–0008, 0010; specs 0006b, 0007, 0007b, 0008, 0010a, 0024; the operator's answers of 2026-10-30 (listed under [Decisions](#decisions)); lead's go (2026-10-30).

## Problem

The Phase 1 import carries `admission_period` rows and the public site reads them to say whether admission is open, but nothing can create a period, nobody can apply, and a recruitment team has nowhere to see who did. Recruitment still happens outside the system. Without applications there is nothing for interviews (spec 0010) and placement (spec 0011) to work on.

## Journey

1. **A department's recruitment team** (or a team leader) schedules an admission period for a semester with a start and an end, may extend its end while it is Scheduled or Open, and may cancel it before it opens when no application refers to it. It opens and closes by its dates: no stored status, no job.
2. **A student finds an open period** on `/soknad` (the departments that are open now) and `/soknad/<department>`. They fill in the form without an account: name, e-mail, field of study (of that department), year of study 1–5, the weekdays that suit them, bolk preference (Bolk 1, Bolk 2 or both), whether they can take a double (8-week) position, optional team interests, optional how they heard of us, optional gender, optional special needs with its own unticked consent. The form shows the privacy notice that the declarations generate. The page works without JavaScript.
3. **Turnstile and the per-IP rate limit** run before any transaction. A refused post leaves no row. A good post shows "Takk, vi har sendt deg en e-post" and queues one e-mail.
4. **The e-mail has one link** to `/soknad/bekreft?kode=…`. The page shows one button; pressing it verifies the e-mail address (the code is single use, so a mail scanner that opens the link does not spend it). Only then is the application joined to a Person that the system already knows by that address.
5. **A person who is signed in** can withdraw their own application; staff can withdraw it for them. An applicant with no account asks staff (see D1).
6. **At a stand**, recruitment staff register a person into a period of the current semester; the period need not be open. The same input, the same checks, the same uniqueness; a second registration of one e-mail in one period is refused.
7. **In the control panel** (`/kontrollpanel/opptak`) recruitment staff and team leaders read their department's periods and applications, and run the commands above.

## Goal, constraints, values

- **Goal:** one time-derived admission window and one application lifecycle for public applicants and staff registration, with personal data and consent declared where they are collected.
- **Constraints:**
  - **The one window.** `isAdmissionOpen` (`organisation/admission.ts`, `start ≤ now < end`) stays the only definition; `admissionState` (Scheduled, Open, Closed) is derived from it beside it and nothing else compares dates. The state is never stored.
  - **Periods.** `admission_period` gets a unique key `(department_id, semester_id)`; `end > start` is already a check. `createAdmissionPeriod`, `extendAdmissionPeriod` (moves `end` later only), `deleteAdmissionPeriod` (only Scheduled, with no application) are granted to `Leader(d) ∪ Fn(recruitment, d)` at department scope (RULE-103, 137, 222). The importer quarantines a later period for an already admitted `(department, semester)`.
  - **An applicant is a Person.** `submitApplication` creates a Person whose address is not verified (`person.email_verified = false`; the unique e-mail index covers verified addresses only) and the application, in one transaction, and queues an `IssueCode` message for the new purpose `verifyApplication` (single use, no account needed). The mail carries the code; the outbox never does (spec 0024). `verifyApplicantEmail` is run by the holder of that code: it sets the address verified; when another verified Person already has the address, the new Person is merged into that one with `PersonalDataStore.merge` (see [Privacy](#privacy)). A known verified address is therefore never linked to an application before it is verified (RULE-306), and a submit answers the same whether or not the address is known.
  - **One application per person and period** (unique key; with verified addresses unique, that is one per verified e-mail and period: RULE-129, 134, 153). The merge rule for `application.person_id` is `Move` with the period as the collision: of two applications of one person in one period the earlier stands and the later is dropped.
  - **Same input everywhere.** `submitApplication` (public, while the department's period is Open) and `registerApplication` (staff, a period of the current semester) decode one `ApplicantInput`; the field of study must belong to the period's department (RULE-165), each team of the interest must be an active team of it (RULE-159), the year is 1–5 (RULE-162), the weekdays are the days that suit (RULE-027). The browser and the server read the same schema (spec 0010a).
  - **Prepared outside the transaction.** The per-IP rate limit and Turnstile run in `prepareHuman` before `runPreparedCommand` opens the transaction, as for the contact form; a refused post creates no Person, application or outbox row. No provider is called in a transaction.
  - **Application machine.** Stored state `Submitted → Withdrawn`, written only by `Aggregates.apply` (spec 0006b); `application` is owned by `Person`. Spec 0010 adds Accepted and NotAccepted, spec 0011 Placed. `withdrawApplication` is granted to `Self` (own) and to `Leader(d) ∪ Fn(recruitment, d)` (department).
  - **Reads** are `viewAdmission`, granted to `Leader(d) ∪ Fn(recruitment, d)`, not to `Member(d)` (RULE-287, 309). The panel guard, `panelReads` and the SELECT-only role cover it.
  - **Consent.** The special-needs text is stored only with its own consent (`consent.kind = specialNeeds`, the text version and the time given), unticked by default; without consent the text is refused. The consent table, its export and its merge rule are 0007b's. An applicant without an account can have everything exported or erased by an administrator on their behalf (0007b).
- **Values:** a public form can create a request, but only a verified address can join it to a person's history; consent is a recorded choice, never an implication; the department boundary is a rule of the commands, not of the page.

## Privacy

- The application (and its special-needs text) is deleted six months after the end of its admission period, for every state that exists in this spec: a Submitted application that nobody decided and a Withdrawn one (`starts.periodEnd("period_id")`, `Periods.applicationAfterPeriodEnd`, a proposed 6 months; spec 0010 adds outcome-dependent retention through a `Column` trigger). **Nothing of an application is kept after its deletion**: no aggregate, no history row, no copy on the Person. (Answer 4 of the operator.)
- The special-needs text expires with its application here. The draft said "at the end of the placement semester" for a placed applicant; placement does not exist until spec 0011, which will own that.
- **The duplicate Person of a collision is not deleted; it is anonymised.** `PersonalDataStore.merge` moves what the survivor does not have, drops the colliding second application, and leaves the merged Person a tombstone without name or address (`anonymised_at`, `merged_into`). The operator's wording was "the empty duplicate is deleted". A row cannot simply be deleted here without writing a second person-collapse path next to the merge that every foreign key of `person` already obeys (`personalDataClosure.postgres.test.ts` fails on a key without a merge rule), and the tombstone holds nothing about the applicant: a reviewer can check this against "nothing kept" in `personalData/catalog.ts` (`person`: name `Anonymisert`, address `anonymisert-<id>@vektorprogrammet.invalid`). Decided with the lead 2026-10-30 (D3).
- An applicant who never verifies keeps an unverified Person for the person-core period (a year after creation, spec 0007b); the application under it follows its own six months.
- `heard_about_us` and `gender` are optional and used only in totals (no totals are built here).

## What is out of scope

- **Returning assistants** (`submitReturning`): left until placement (0011) and the people import (0013) give "an earlier placement" a meaning. (Operator, 2026-10-30.)
- **Admission alerts** and their consent, subscription and one-click unsubscribe: spec 0009b.
- **Interviews, outcomes, score, substitute flag**: spec 0010. Placement and Placed: 0011.
- **Admission statistics** (the draft's RULE-038, 055, 071, 073, 081, 087–090, 210): they need the spec 0027 release rules (minimum, complementary suppression) on new measures, which is a spec of its own after placement (lead, 2026-10-30).
- **A withdraw link for an applicant with no account**: needs a code keyed by application; spec 0009b generalises the code table and adds it (D1).
- A phone number (not asked; operator default). Information meetings (CMS content).
- **Phase 3 entry data** (an anonymised completed period for replay) and production Turnstile keys and mail credentials: operator-held. Local and Preview use the capture sink and test keys.

## Decisions

Operator, 2026-10-30: the draft is split into 0009 and 0009b; returning assistants are out; an applicant is an unverified Person created at submit and a single-use code verifies the address, a collision reassigns the application to the verified Person (RULE-306 falsifier with its control); reads are `Fn(recruitment, d) ∪ Leader(d)`; nothing is kept of an application after its deletion; no phone number; `revise` extends `end` only; a unique `(department, semester)`; undecided applications are deleted six months after the period ends.

Lead, 2026-10-30, on three points that the answers did not settle:

- **D1.** An applicant with no account cannot be `Self`: staff withdraw for them, and `Self` serves a signed-in applicant. The applicant's own link comes with 0009b.
- **D2.** Statistics are out (above).
- **D3.** A collision merges with `PersonalDataStore.merge` and leaves an anonymised tombstone (Privacy).

## Failure cases

| Case | What happens |
| --- | --- |
| No Turnstile answer, a wrong one, a rate-limited IP | 422 or 429 with the form shown again; no Person, application or outbox row |
| The department has no Open period at submit | the form is refused with "Opptaket er ikke åpent" on `departmentId`; nothing is written |
| The window closes between page load and post | the same refusal (the period is decided on the server, at the post) |
| Field of study of another department, an inactive or foreign team, year 0 or 6, a weekday that does not exist, special needs without consent | the field's message from the schema, in the browser first and identically on the server |
| The same address submits twice in a period | two unverified Persons; at the second verification the later application is dropped and the earlier stands |
| A known verified address submits | a new unverified Person; the verified Person is untouched until the link is used |
| The code is wrong, used, expired or not yet acknowledged | nothing is verified; the page says the link cannot be used |
| Two staff cancel or extend one period at once | one wins; the other is a `Conflict` |
| Cancel a period with an application, or an Open or Closed one | refused |
| Register in a period of another semester, or in another department | refused; the second is 403 |
| Register an address that already has an application in the period | `Conflict` |
| A leader of department A withdraws, reads or registers in B | 403 (a forged server call too) |
| Withdraw twice, or a withdrawn one again | the machine refuses (`Conflict`) |

## Falsifiers

| # | Falsifier | Negative control | Where |
| --- | --- | --- | --- |
| F1 | **One window.** `isAdmissionOpen` is true at the start and one millisecond before the end and false at the end; `admissionState` agrees at every boundary; no other file compares an admission date | an inclusive end fails; a planted second comparison is reported by the scan | `packages/domain/test/organisation/admission.test.ts`, a source scan |
| F2 | **Period constraints on PostgreSQL.** duplicate `(department, semester)` is `AlreadyExists`; `end ≤ start` is refused; extend moves the end later only; cancel is refused with an application, when Open and when Closed; 20 concurrent schedules of one `(department, semester)` leave one row and 19 typed losers | the same race without the unique key writes two rows | `packages/db/test/admission.postgres.test.ts` |
| F3 | **The public journey.** Playwright opens `/soknad`, reads the notice, submits a valid form, sees the confirmation, the application is stored once, the mail is captured, the link's button verifies the address, staff see the application as verified | a second submit without verification leaves an unverified one | `apps/web/e2e/admission.spec.ts` |
| F4 | **Public security.** a missing, wrong or reused Turnstile answer is refused before any transaction and leaves no Person, application or outbox row; a forged post is refused; the rate limit answers 429 | the valid post queues exactly one message | `admission.spec.ts`, `apps/web/test/admission.test.ts` |
| F5 | **Same checks, both sides.** invalid year, field of study of another department, inactive or foreign team, bad weekday, special needs without consent are refused with identical issues by the form schema and the command; the unique key is the race backstop | an application with the department's own field of study passes | `apps/web/test/formAgreement.test.ts`, `packages/domain/test/admission/*.test.ts`, `packages/db/test/admission.postgres.test.ts` |
| F6 | **RULE-306.** An application is never joined to a known verified Person by a submit. After verification with a collision the application belongs to the verified Person, the later duplicate in a period is dropped, the duplicate Person is a tombstone with no name or address, and its other rows are gone or moved; a code that is wrong, used, expired or `Unsent` verifies nothing | with no verification the verified Person has no new application and no changed field | `packages/db/test/admissionIdentity.postgres.test.ts` |
| F7 | **Staff and the department boundary.** register works in a current-semester period outside the window and not in another semester's; a duplicate address is refused; a leader of A cannot register, withdraw or read B, by page or by a forged server call; `Member(d)` reads nothing | the same call by a leader of the right department succeeds | `apps/web/test/admission.test.ts`, `apps/web/test/panelReads.test.ts`, `apps/web/e2e/admission.spec.ts` |
| F8 | **Consent.** the special-needs box is unticked and separate; the text is stored only with a `specialNeeds` consent that has its text version and time; a consent without text stores nothing; withdrawing another kind does not touch it | the same text with the box ticked is stored | `apps/web/test/admission.test.ts`, `packages/db/test/admissionIdentity.postgres.test.ts` |
| F9 | **Retention, export, erasure, merge.** the closure tests accept the new table; the nightly run deletes a Submitted and a Withdrawn application exactly six months after the period ends and not a day before, and a repeat changes nothing; export lists the person's applications; erasure on someone's behalf expires them | an application of a later period is kept | `packages/db/test/personalDataClosure.postgres.test.ts`, `retentionOracle.postgres.test.ts`, `admissionRetention.postgres.test.ts` |
| F10 | **Reads never write.** every new `runQuery` is registered and passes the SELECT-only role | an unregistered read fails the registration test | `apps/web/test/readsNeverWrite.postgres.test.ts`, `panelReads.test.ts` |
| F11 | **The machine.** `Submitted → Withdrawn` only; the state is written by `Aggregates.apply` alone; a withdrawn application cannot be withdrawn again; the lock order holds in every command | a direct `UPDATE` is rejected by the lint rule | `packages/db/test/aggregates.postgres.test.ts` pattern, the closure and lint |
| F12 | **Import.** the importer quarantines a later period of an admitted `(department, semester)` with its reason, and the rest are unchanged | the first of two is admitted | `tools/import/test/roundTrip.test.ts` |
| F13 | **Nothing else moved.** `vp check`, `bun run ready`, the module graph, the effx conformance vectors, the generated documents, the membership-writes model for the covered files |  | CI |

## Open items

1. **The 92 imported periods.** Whether two of them share `(department, semester)` cannot be read here: the 2024-08-22 dump is not on this machine and the rehearsal's branch was deleted. The importer's quarantine rule and its test are built; the count on the real backup is for the next rehearsal, and the unique-key migration fails on a database that holds a duplicate (the `main` and Preview databases hold the importer's fake fixture).
2. **The six months** are the proposed value of `Periods.applicationAfterPeriodEnd`; approving it is a one-line change of `approval`.
3. **The confirmation mail text and the special-needs consent text** are drafts (`consentTexts.specialNeeds`, `approval: "proposed"`), as the other consent texts were.

## Revisions

### R1 (2026-10-30): first plan

Written after reading the draft and `docs/system/admission.md`; the code that this builds on (`organisation/admission.ts`, `AdmissionPeriodRepository`, `PersonRepository`, `PersonalDataStore.merge`, `accounts/code.ts` and its delivery, the personal-data catalog's `PeriodEnd` trigger, the 0010a form construct); and the answers listed under Decisions.

### R2 (2026-10-30): what the build changed

What the code does that R1 did not say, or says differently. The falsifiers keep their numbers; where a row's file or wording changed, it is named here.

1. **The special-needs consent is stored in the application row, not in `consent`.** R1 said `consent.kind = specialNeeds`. A consent kind would have changed `ConsentKind`, the `consent_kind` check, the consent summary and Min side, for a text that exists for one purpose and is deleted with the application. The row carries `special_needs`, `special_needs_consent_version` and `special_needs_consented_at`, all null or all set (a check), written in the same statement. The consent text is `specialNeedsConsentText` (version 1, `approval: "proposed"`, in `admission/entities.ts`), shown beside an unticked box. The privacy notice's basis for that field is Art. 9(2)(a). What follows for F8: "withdrawing another kind does not touch it" is vacuous, because the consent is not a kind; the withdrawal of this consent is the deletion of the application (six months after the period, or an erasure on the person's behalf, spec 0007b), and an applicant with no account has no self-service withdrawal until 0009b's link. `admission.postgres.test.ts` shows the text stored with the version and the time, and nothing stored without the box.
2. **`verifyApplicantEmail` is a command of the PersonalData domain.** The merge port (`PersonalDataStore.merge`) is in the `privacy` layer, which `iam` may not import, so the command that merges lives in `personalData/commands.ts`; the `verifyApplication` purpose (`accounts/code.ts`, single use, no account, 30 days) and the Code machine's step (`accounts/codeMachine.ts`) name it, and `admission.test.ts` asserts that the three tags are one. It hashes the presented code, so its handler needs `Crypto`; the db tests' layer provides it (`support/database.ts`). The command locks the admin list, then the person and the holder of the address in id order, rechecks the holder under the locks, and a change since the first read makes the link unusable and writes nothing.
3. **effx.** `Holder(verifyApplication)` and `Anyone` are typed gaps (`conformance/gaps.json`), and the Application machine is dropped from the model with the typed `MachineDropped` gap, because a transition of it is applied by `submitApplication`, whose subject effx cannot be given. The machine is still checked by `admission.test.ts` (its table, its terminal state) and by the closure and ownership tests.
4. **One input, field names.** A form posts a checkbox set as one name per option (`weekday-Monday`, `source-Web`, `team-12`), because `textOf` keeps the last value of a name and a post without script must carry them all. `CheckGroup` (`components/form/choice.tsx`) renders such a set as a `fieldset` under one legend, and `Field` shows the messages of the set's path (`weekdays`, `heardAbout`, `teamInterest`) there. The special-needs text and consent are `specialNeeds.text` and `specialNeeds.consent`, the paths of the domain's issues on them.
5. **Where the tests are.** The commands run on PostgreSQL: F2, F4 (what a submit writes and what a refusal leaves), F5's database side, F8, F11 and F7's department boundary are in `packages/db/test/admission.postgres.test.ts` (`admissionWorld.ts` is its world); F6 is `admissionIdentity.postgres.test.ts`; F9 is `admissionRetention.postgres.test.ts` and the table-driven `retention.postgres.test.ts`, whose builder for `application` is in `support/retentionBuilders.ts`. `apps/web/test/admission.postgres.test.ts` holds the mail (F3's mail half, over the real delivery stack) and the public post's guards (F4: no or wrong Turnstile answer, a rate-limited address, a closed department: nothing written; the valid post: one message). The in-memory tables hold only the reads of applications (`memory.ts`), so `panelReads.test.ts` and `site.test.ts` run unchanged; their writes die with a message that names where they are tested. A Turnstile answer that is **reused** is refused by Cloudflare's verifier, which the offline fake does not model: it is covered by neither test. F1 is `packages/domain/test/admission/admission.test.ts` (a `openAdmissionPeriod` beside `hasOpenAdmission`; both read `isAdmissionOpen`). F12 added a third legacy period to the importer's fixture.
6. **A staff registration checks the address before it writes** (`existsForAddress`), so two registrations of one address in one period that start together can both pass. The consequence is the one a public submit already has: two unverified people, and at the second verification the later application is dropped. The unique key `(person, period)` is the backstop for one person, not for one address.
7. **The route of the link.** `/soknad/bekreft` is one route with a page (a button in a `PostForm`) and a `POST` handler on the same URL, as the contact form does; the page shows the same sentence for a code that is wrong, spent, expired or not yet acknowledged. `applicationPage` and `applyIndexPage` are read paths and are registered in `readsNeverWrite.postgres.test.ts`. The home page's open-admission buttons link to `/soknad/<department>` (they were contact links).
8. **A migration that can fail.** `admission_period_department_semester_unique` replaces `admission_period_department_idx` (the unique key's index serves the same lookups), and a database that holds two periods of one department and semester refuses it (Open items, 1). The importer's quarantine keeps a later duplicate out of a replacing import, and `application` is among the tables that a replacing import refuses to truncate while it holds rows.
9. **Purpose.** `admission` is a new purpose (`personalData/declaration.ts`, words in `texts.ts`), and the application form is declared in `admission/personalData.ts` (`ApplicationForm`), registered in `Forms`. The lint lists in `vite.config.ts` and EX-0028's file list gained the new route, server and test files for the Promise boundaries they share with the contact form.
