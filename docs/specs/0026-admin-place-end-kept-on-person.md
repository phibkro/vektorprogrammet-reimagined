# Spec 0026: A deleted admin place leaves its end on the person (spec 0021 finding; operator decision B, 2026-10-29)

**Status:** in progress; frozen when its PR opens; later changes are dated entries under [Revisions](#revisions) · **Source:** operator decision (2026-10-29, option B of the finding recorded in `STATE.md` and in spec 0021 Revisions, review round 1): delete the places on schedule and keep a minimal last-admin-end date on the person, updated under the Person lock before the deletion; spec 0021 (retention arithmetic), spec 0007b (personal data), spec 0006b (aggregate locks)

## Problem

A place on the admin list (`admin_grant`) is deleted three years after its `until` (`Periods.adminPlaceAfterEnd`, `onExpiry: Delete`, **proposed**). A person's last activity is the later of their last membership's end, their last place's `until` and their creation, and their core is anonymised one year after it (`Periods.personCore`, decided), or five years after it while a `keepDetails` consent is current (`Periods.personCoreWithKeepDetails`, decided).

For a person with a current `keepDetails` consent the five years are longer than the three that keep the place. On the first night after `until` plus three years the place row is gone, the last activity falls back to the last membership's end (or the person's creation), and on the next night the person is anonymised although `until` plus five years has not come. The view that spec 0021 replaced did the same (it read `admin_grant`), so this is not a regression of 0021: it is a decided period (five years) that a proposed one (three years) silently undercuts. The operator chose to keep the three years and to keep the one fact that the place was needed for.

## Journey

An administrator's place ends on 1 March 2027 (`until`). The person gave `keepDetails` in 2026.

1. **Before 1 March 2030** the place row is there and the person is active until its end, as today.
2. **On the first nightly run after 1 March 2030** the retention run locks the person, **writes the place's end (`until`) to the person's `last_admin_place_end`**, then deletes the place. Both statements are in the run's transaction for the chunk.
3. **Every later night** the person's last activity is the later of their last membership's end, their remaining places' `until`, **and `last_admin_place_end`**: it did not move when the row went, so the person is anonymised on the first night after 1 March 2032, not on 2 March 2030.
4. **When the person's core is anonymised** (or they are erased) `last_admin_place_end` is set to null with the rest of the core: it is not needed afterwards. A merged person's date goes to the survivor (the later of the two), and the tombstone's is nulled.

## Goal, constraints, values

- **Goal:** the decided period of a person's core is never shortened by the deletion of a row that counts toward their last activity, and the one fact kept to prevent that is itself declared, exported, erased, merged and expired like every other personal datum.
- **Constraints:**
  - Declarations are data (spec 0007b): the kept fact is one declaration in the teams domain (`keeps` on the `admin_grant` table: which column of the row, which column of the owner). The nightly run, the merge and the checks read it; there is no admin-specific branch in them.
  - The date is written **under the Person lock, before the rows that justify it are deleted, in the same transaction**; written only through `Aggregates` and the chunk's token. No advisory locks, `LISTEN/NOTIFY`, session `SET` or triggers; no view, function or `make_interval` in the schema (spec 0021).
  - The kept date never outlives the person's core, and is never written to an anonymised person.
  - The grant period (three years) and the legal bases remain **proposals**: production still counts and does not delete (spec 0007b R4). Nothing here approves a period.
  - Clean cutover: `ActivityFacts` gains a required field, every constructor says what it holds.
- **Values:** the bad state unrepresentable where the declaration can say it (a closed set checked against the schema), the minimum of personal data (one date, no history), one definition of last activity (`lastActivityEnd`).

## Decisions

**D1. One date, on the person.** `person.last_admin_place_end` (`timestamptz`, null) holds the latest `until` of the places that retention has deleted from this person. It is the _minimum_ that keeps the person's last activity where it was: last activity reads the maximum of the ends, so the latest end alone is enough, and no earlier one can matter. It is not the history of who held a place (that is the row, for three years).

**D2. The fold is declared on the table that is deleted.** `TableDeclaration` gains an optional `keeps: { from, into }`: before a row of this table is deleted by retention, the greatest `from` of the rows about to be deleted is folded into the owner row's `into` (greatest of that and what it holds). `admin_grant` declares `keeps: { from: "until", into: "last_admin_place_end" }`; `person.last_admin_place_end` is declared a personal column like any other (purpose `places`, legal basis legitimate interest, retention `withThePersonCore`, expiry `Anonymise.null`), which is also what expires it. The retention rule derived for the table carries `keeps`; the merge reads it from the catalog.

**D3. The rule order and the anonymised person.** Last-activity rules run first, the place's deletion later (spec 0007b), so on the night a person's core is due the person is anonymised before their places are deleted. The fold is therefore written only `where anonymised_at is null`: an anonymised person gets no date, and the places go without one. (That is also what a place period longer than the person's period needs: F6.)

**D4. Only retention folds.** `deleteAdminGrant` (an administrator revokes a place) deletes the row without a fold, as before: a place that was revoked stops counting, which is what the old view said. Whether a revoked place should count until its revocation is a decision of its own, not made here.

**D5. The merge keeps the later date.** A merge folds the merged person's date into the survivor's (greatest), then the merged person is anonymised, which nulls theirs. A survivor with none takes the merged person's.

**D6. Last activity reads the date.** `ActivityFacts` gets `keptPlaceEnd: Option<Utc>`; `lastActivityEnd` is the greatest of the memberships' ends, the places' `until`s and `keptPlaceEnd`, or the creation when there is none of them. `readPeople` reads `person.last_admin_place_end`. The alumni candidates read the same facts.

**D7. Notices and records are generated.** The column is in the catalog, so the record of processing, the privacy notice and the export list it without a hand-written line; the text of the `admin_grant` rows and of the column say that the end of a deleted place stays on the person's record until the core period ends.

## Failure cases

| Case | What happens |
| --- | --- |
| The run dies after the fold and before the delete | one transaction per chunk: both roll back, the place and the old date stay, the next night repeats |
| The person is anonymised on the same night their place is due | the place is deleted with no fold (D3); the date stays null |
| The place period is longer than the person's period | the person is anonymised first, the place goes later with no fold; nothing is written to the anonymised record (F6) |
| Two places end on different nights | each night folds its due rows (the greatest); a place that is not due still counts as a place |
| The production run (`ReportOnly`) | counts, writes no date (the report has no lock and no writer) |
| `keepDetails` is withdrawn after the place went | the period falls to one year from the same end; if that has passed the person is anonymised on the next night |

## Falsifiers

Each has a negative control; the controls and the mutations that were run are in the Revisions.

| # | Falsifier | Negative control | Where |
| --- | --- | --- | --- |
| F1 | **Consecutive nightly runs.** A `keepDetails` person with a place until `U` and a membership that ended long before: at `U+3y−1d` the place is there; at `U+3y+1d` it is gone, `last_admin_place_end = U`, the person intact; a run at `U+3y+2d` changes nothing; at `U+5y−1d` intact; at `U+5y+1d` anonymised and the date null. A person without the consent is anonymised at `U+1y+1d`, her place row goes at `U+3y+1d` and no date is written to her | the same person under a store whose rules have no `keeps` is anonymised on the second night after the place went (`U+3y+2d`), two years early (the finding, reproduced) | `packages/db/test/adminPlaceEnd.postgres.test.ts` |
| F2 | **Consent withdrawal.** The consent is withdrawn after the place went: the person is anonymised on the next night, the date null | the consent kept: intact | same |
| F3 | **Several places and memberships.** Places that end on different nights and memberships that end before and after the kept date: the person's period follows the greatest of all, at every night | `lastActivityEnd` over generated facts equals the greatest of its parts; the old-view oracle equals it when `keptPlaceEnd` is `None` | same; `packages/domain/test/personalData/retentionEnd.test.ts`; `retentionOracle.postgres.test.ts` |
| F4 | **Merge.** Survivor with the later date keeps it, survivor with the earlier or no date takes the merged person's; the tombstone's is null | a merge that did not fold leaves the survivor's date lower (the mutation M2 below) | `packages/db/test/adminPlaceEnd.postgres.test.ts` |
| F5 | **Erasure and export.** `exportMyData` holds the date; `erasePerson` nulls it with the core | an export of a person with no date has `null` | same |
| F6 | **Period change.** The place period set to 1 year, to the person's own period, and to 6 years: the person's anonymisation night is `lastActivity + 5y` in each case, and an anonymised person never holds a date | the guard `anonymised_at is null` taken out (mutation M3): the date reappears on an anonymised person | same |
| F7 | **Production still counts.** A `ReportOnly` run over the same people writes no date and deletes nothing | the `Apply` run does | same |
| F8 | **Declarations.** The catalog declares the column (closure test), `keeps` names a column of the row and a column of its owner, the record of processing lists the column with the person core's retention, and the record is regenerated | a `keeps` that names a missing column fails the closure | `personalDataClosure.postgres.test.ts`, `packages/domain/test/personalData/catalog.test.ts`, `bun run check:docs` |
| F9 | **Nothing else moved.** `vp check`, `bun run ready`, the personal-data suites; the membership-writes model | — | CI |

## Not done here

- **Approving the grant period or any legal basis** (they stay `proposed`; the production run counts).
- **Revoked places** (D4).
- **Backfill.** Production is not deployed and no run has deleted a place there; the importer writes no date, so a person's date appears at their first deletion.
- **A retention rule that depends on whether a later activity exists** (clearing the date once a later membership makes it irrelevant): the date is cleared with the core, which is what "no longer needed" means for a fact that can only matter until then.

## Revisions

### R1 (2026-10-29): first plan

Written before any code, after reading `retention.ts`, `activity.ts`, `merge.ts`, the teams declarations, spec 0021 R-1 and the `STATE.md` item. The plan changes under this heading as the build teaches.

### R2 (2026-10-29): the build

What the build taught, in the order of the plan:

1. **The person goes one night later than the plan said.** The person's facts are read once, before the night's rules run, so on the night the place is deleted the person still has the place in their facts; the fall-back to the last membership's end is seen on the next night. The Problem and F1's control are read that way: place gone on night one, person anonymised on night two. (Spec 0021's note says "that night"; its Revisions now say it was one night early.)
2. **The control needs a membership.** A person with no membership falls back to their _creation_, which in a test is recent and five years from it is later than the place's three, so the finding does not show. F1 and its control give the person a membership that ended with Høst 2020, as `retentionPeople.postgres.test.ts` does; then the unprotected store anonymises her on the second night (the control) and the real run does not (F1).
3. **`keeps` lives on the table, and the merge reads it too.** `TableDeclaration.keeps` (`from`, `into`) is one declaration for both: the retention run folds the due rows' greatest `from` into the owner's `into`, and the merge folds the merged person's `into` into the survivor's. `RetentionRule.keeps` carries it for `Delete` rules (`derive.ts`); `keptDates(catalog)` lists them for the merge.
4. **The record of processing prints the new column on its own row** ("Keep the record of who held a place on the admin list … `person`: last_admin_place_end … anonymised"), with the person core's retention and the legal basis marked proposed like the admin place's. `bun run docs` regenerated `docs/system/administration.md`; nothing in the notice of a form changed.
5. **The table-driven rule test has a new rule id**: the person rule's columns now include `last_admin_place_end` (`retentionBuilders.ts`). The rule is the same rule: the column is anonymised with the rest of the core.
6. **`STATE.md`'s open item is removed** and spec 0021's Revisions say that this spec resolves it.

### R3 (2026-10-29): the controls that were run, and the claims that this revision narrows

Mutations, each on the real source and restored by hand, two runs each of `adminPlaceEnd.postgres.test.ts` (10 tests):

| Mutation | What failed |
| --- | --- |
| M1: `keepBeforeDelete` is not called | F1, F2, F3 (3 of 10), 2 of 2 runs |
| M2: `foldKeptDates` is not called in the merge | F4 (1 of 10), 2 of 2 runs |
| M3: the `anonymised_at is null` guard is `true` | F1 and F6 for the place periods of 5 and 6 years (3 of 10), 2 of 2 runs |

F6 with a place period of one year does not discriminate M1 or M3 (the person is created recently and her creation is the fall-back); it shows that the fold works when the place goes long before the person does. The narrowed claims, so that the table above does not say more than the tests do:

- **F3's control** is the unit cases of `lastActivityEnd` with `keptPlaceEnd` (`retentionEnd.test.ts`: alone, after a membership, before a membership, beside a place that is still there) and the old-view oracle property test, which still holds with `keptPlaceEnd = None` (`retentionOracle.postgres.test.ts`); there is no property over generated `Some` dates.
- **F5's control** is that the export is read before the erasure, so the clear is observed and not assumed; no mutation was run on the erasure, whose clear is the person core's `Anonymise.null` for the column.
- **F8** is two checks: `catalogProblems` finds a `keeps` whose `from` is not a personal column that the rule deletes, or whose `into` is not a personal column of `person` (`catalog.test.ts`, three planted names); the closure over the migrated schema (`personalDataClosure.postgres.test.ts`) fails when the column is not declared or not in the schema, which is the existing check.
- **The failure case "the run dies after the fold"** rests on the run being one transaction (`runRetention` is `transactional`); no test injects a failure between the two statements.
