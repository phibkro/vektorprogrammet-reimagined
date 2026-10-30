# Spec 0027: Evidence of operations: assistants placed, schools served, placements (draft 0016 of the analysis; operator decision, 2026-10-29)

**Status:** in progress; frozen when its PR opens; later changes are dated entries under [Revisions](#revisions) · **Source:** operator decision (2026-10-29): the small initial set of measures (distinct assistants placed, schools served, placements, by defined semester and department), closing snapshots with provenance where history must outlive its source records, the school-level breakdown restricted, a suppression minimum of five enforced across every output and against differencing, and sources that are unavailable or incomplete marked and never invented; the sponsor pipeline stays in Notion and Drive (ADR 0005). Draft: `../../analysis/vektorprogrammet/spec-drafts/0016-impact-evidence.md`. Numbered 0027 because 0016 was taken.

## Problem

Funding depends on sponsors and the university seeing that Vektorprogrammet delivers: assistants placed and schools helped. The sponsor team asked IT for such numbers in October 2026 and none could be produced. Legacy kept inward-facing counts (RULE-071, RULE-074) and a front-page total with fixed offsets (RULE-075, retired as count inflation), and no count of schools helped and no history across semesters.

**Today the reimagined system has no source for any of the three measures.** `main` has no `school`, `placement` or `assistant_history` table (placement is spec 0011, not built) and the importer reads none of them; only `semester`, `department`, `person` and `membership` exist. A number produced now would be invented. The honest state of a measure whose source does not exist is **Unavailable, with the reason**, and this spec builds everything around that state: the declarations, the release rules that protect small counts, the snapshot that freezes a closed semester, the page and the CSV. The day placement lands, the source adapter answers and the page fills in, with no change to the rules. Legacy history (about 1,815 `AssistantHistory` rows, 2016 to 2024) cannot come from the live source either; a follow-up spec imports it as aggregate snapshots (see "Not done here").

## Journey

An administrator (open item: and the board and the sponsor team) wants the numbers.

1. **Open the impact page** in the control panel. For each closed semester and each department it shows the three measures, each with its **definition in words**, the **coverage** of the number (`complete`, `incomplete: <reason>` or `unavailable: <reason>`) and, for a number below five, **"< 5"** and not the number.
2. **Today** every cell reads **Unavailable: placement is not built (spec 0011)**. Nothing is estimated and no zero is shown in its place.
3. **Download the CSV** of the same page. It holds exactly what the page shows: the same suppressed cells, the same coverage, the same definitions. There is no other output: no export of raw counts.
4. **When a semester closes** a scheduled job freezes the cells that the source answered into immutable snapshots with their provenance. A published number for a closed semester does not change silently, and it survives the retention of the rows it was computed from.

## Goal, constraints, values

- **Goal:** evidence of operations as a by-product of normal work, with no manual counting, that a sponsor can trust: exact where it is shown, silent where it would single out a person, and explicit where it does not exist.
- **Constraints:**
  - The measures are declared once in the domain: name, definition (English and Norwegian), the source it needs, the grain it is published at, and whether its parts add up. The page, the CSV and the documentation are generated from the declarations; no count is written in a page.
  - **One release function.** Every output reads cells through `release`, and its result type holds no raw count: a number below the minimum cannot be put in an output because the output type cannot carry it. The minimum (**5**, proposed) is one declaration with an `approval`.
  - **No differencing.** A suppressed cell cannot be recovered from the published cells of the same output: not from a published total minus its published parts, and not by narrowing with the bounds that a total gives its parts. The check is a test over generated lattices with a control that fails without the complementary suppression.
  - **The publishable cells are a fixed lattice**: each closed semester by each department, and each closed semester across departments. There are no free date ranges and no cross-semester totals, because a distinct count over several semesters cannot be derived from snapshots once the people rows are gone, and a total that the reader adds up would be a second route to differencing.
  - School-level cells are a grain of their own with a restricted audience; no output of the standard audience holds one.
  - Snapshots are written once and never changed (a port with an insert and a read, and no update or delete). A snapshot is written only from a source that answered: an Unavailable is not frozen, or the semester could never be filled in later.
  - Reads never write (spec 0003). Nothing here calls an integration. No advisory locks, `LISTEN/NOTIFY` or session `SET`.
- **Values:** one definition per measure; honest numbers; the bad state unrepresentable where the types can say it (`Released` carries no raw count; `Coverage` is part of every cell).

## What is out of scope

- **Sponsor pipeline** (leads, pitches, sponsor contact history): stays in Notion and Drive (ADR 0005); the system does not store it.
- **Operations telemetry and site analytics** (draft 0016's other two channels): separate sources with separate guarantees; not built here.
- **A public page or public totals, a PDF sponsor report:** audience and format are open items; the CSV is the one export.
- **Legacy history:** a follow-up spec imports `AssistantHistory` as aggregate snapshots with provenance `legacy-import` once placement lands (see below). Until then the semesters before the reimagined system have no cells.

## Decisions

**D1. The three measures, as definitions.** Each is declared with its text; the open items below say what the sponsor team and the board must confirm. _Placement_ is one assistant at one school for one semester.

| Measure | Counts | Parts add up? |
| --- | --- | --- |
| `assistantsPlaced` | the distinct people with at least one placement in the semester | no: a person placed in two departments is one in the total |
| `schoolsServed` | the distinct schools with at least one placement in the semester | no: a school served by two departments is one in the total |
| `placements` | the placements of the semester | yes |

**D2. Coverage is part of every cell.** `Coverage = Complete | Incomplete(reason) | Unavailable(reason)`, a tagged union. A cell is `Available { value, coverage }` or `Unavailable { reason }`; there is no number without a coverage. `Incomplete` is for a source that answered from partial history (for example a semester whose legacy rows are known to be partial); the page prints "at least" and the reason. An `Unavailable` cell takes part in no relation and is never suppressed (it has no number to protect).

**D3. Why `Unavailable` is the honest state today, and not a zero.** A zero says "the system counted and found nobody placed". No system counted: the tables that placement would fill do not exist. A zero would be read by a sponsor as a result, and the first real number would then look like growth. `Unavailable` says what is true (the source does not exist, and which spec builds it) and is replaced by a number the day a source answers; it also keeps the snapshot job from freezing a falsehood. The live source adapter that ships answers `Unavailable("placement is not built (spec 0011)")` for every cell, and a test shows that no number is produced from it.

**D4. Release: primary suppression, then complementary suppression until nothing can be recovered.** For one semester the cells are `(measure, department)` for each department and `(measure, all departments)`, related by the measure's parts rule: for an additive measure the total **equals** the sum of its parts; for a distinct measure the total is **at least the largest part and at most the sum of the parts**; and for the school grain (restricted) the department cell stands to its schools as the total to its parts, by the same rule. `release(cells, relations, minimum)`:

1. a count from 1 to `minimum − 1` is suppressed (primary). A zero is published as zero (open item);
2. while some suppressed cell can be recovered by one of two attacks, the published cell that lies in a relation with it and holds the smallest value (ties by cell id) is suppressed too (complementary). The attacks: **exact elimination** (a suppressed cell that is a linear combination of published cells over the additive relations: Gaussian elimination over the rationals) and **bound narrowing** (a suppressed cell whose feasible interval collapses to one value, propagating the relations' bounds to a fixed point, starting from `1 … minimum − 1` for a primary-suppressed cell and `0 … ∞` for a complementary one);
3. the loop ends, because each pass suppresses a cell, and in the worst case every cell is suppressed.

Neither attack is complete (an integer program could pin a value that these miss); the spec claims exactly what the test runs, and the Revisions say so.

**D5. The output type carries no raw count.** `Released` is `Published { value, coverage } | Suppressed { minimum, coverage } | Unavailable { reason }`. The report, the page and the CSV are made from `Released` and nothing else; the command's success schema is `ImpactReport`, a list of `Released` cells with the definitions. The raw `Cell` exists only inside `release` and the snapshot port.

**D6. Audiences and grains.** `Grain = department | school`. Every measure declares the grains it is published at and each grain declares its `Audience` (`standard` or `restricted`); `assistantsPlaced` and `placements` have a `school` grain with the `restricted` audience, `schoolsServed` has none (it would be 1). `impactReport(audience)` returns the cells of grains whose audience is at most the caller's. The command that ships serves the `standard` audience only; the school grain is declared, suppressed by the same release, and has no command until placement gives it cells and the operator says who reads it (open item). A test shows that the standard report holds no school cell and that the restricted report, over a fake source that has schools, holds them and suppresses them.

**D7. Snapshots.** `impact_snapshot(measure, semester_term, semester_year, department_id, value, coverage, coverage_reason, source, source_ref, definition_hash, closed_at)`, unique on `(measure, term, year, department_id)` with `department_id` null for "all departments" (`NULLS NOT DISTINCT`). Provenance: `source` is `reimagined` (a live source at close) or `legacy-import` (a later spec), `source_ref` names the import run when there is one, and `definition_hash` is the digest of the measure's declaration (a changed definition is a different measure: the page shows a snapshot only when its hash is the declaration's, and marks one that is not). `ImpactSnapshots` has `close` (insert, conflict: do nothing, and report whether the cell was newly closed) and `read`; there is no update or delete. The raw value of a closed cell is stored and only read through `release`. School-grain cells are not snapshotted (R2).

**D8. The close job.** `impactClose` is a registry job (`SystemJob`), whose runner closes every ended semester that lacks a snapshot of a cell that the source answers now. It runs as `System("impactClose")` through the command `closeImpact` (resource `ImpactSnapshot`, method `:close`). Its cadence is **proposed** (a proposed cadence installs no trigger; approving it is one word in `registry.ts`), because a new nightly job is the operator's call. With the only source Unavailable it writes nothing, and the test shows that.

**D9. Who reads.** `listImpact` (resource `Impact`, method `list`) is held through the admin row alone, as `listAuditEntries` is, and has no grant row. Who else reads (the board, the sponsor team, a department's leaders) is an open item: a grant row and a regeneration of the effx vectors, one line each. The page lives in the control panel as a section whose access is `listImpact`.

**D10. Generated documentation.** `docs/system/impact.md` is generated from the declarations (`bun run docs`, checked by `bun run check:docs`): the measures with their definitions, grains, audiences, the minimum with its approval, the relations, and the open items. A definition that changes changes the page and the snapshot hash together.

## Failure cases

| Case | What happens |
| --- | --- |
| The source does not exist or does not answer for a cell | the cell is `Unavailable` with the reason; no relation uses it; no snapshot is written; the page and the CSV say so |
| The source answers from partial history | the cell is `Incomplete(reason)`: published as "at least", suppressed below the minimum like any other |
| One suppressed cell among published siblings and a published total | the smallest published sibling is suppressed as well (D4 step 2); the test solves for the cell from the output and fails when it can |
| A semester is closed twice, or two jobs close it at once | the second insert finds the cell closed and does nothing; the first value stays |
| A measure's definition changes after a semester closed | the snapshot's hash no longer equals the declaration's; the page marks the cell "closed under another definition" and does not show it as the current measure |
| A caller of the standard audience asks for a school cell | the report has none (D6) |
| Every cell of a semester is suppressed | the page says so; that is the worst case of D4 and is safe |

## Falsifiers

Each has a negative control; the controls and the mutations that were run are in the Revisions.

| # | Falsifier | Negative control | Where |
| --- | --- | --- | --- |
| F1 | **Declared once.** The page, the CSV and `docs/system/impact.md` hold the three declared measures with their definitions, and nothing else; the declarations are consistent (every measure has a source, a grain, a definition in both languages) | a planted measure without a Norwegian definition fails the check | `packages/domain/test/impact`, `tools/docgen/test`, `bun run check:docs` |
| F2 | **Honest today.** With the shipped source every cell of the report is `Unavailable` with the reason of D3, the CSV says so, and the close job writes no snapshot | a fake source that answers makes the same code produce numbers and snapshots | `packages/domain/test/impact`, `packages/db/test/impactSnapshots.postgres.test.ts`, `apps/web/test` |
| F3 | **Suppression below five, everywhere.** Over generated lattices no `Published` cell holds 1 to `minimum − 1`, in the report, the page's data and the CSV; the type of `Released` has no raw field | lowering the minimum to 1 publishes a 3; widening `Released` is a type error | `packages/domain/test/impact` |
| F4 | **No differencing.** Over generated lattices (two to four departments, optional schools, additive and distinct measures, values 0 to 12) no suppressed cell is recovered by exact elimination or by bound narrowing; a published cell always equals its true value; the release is deterministic | the same release without step 2 discloses at least one cell of a named lattice and of the generated ones (the attack finds it) | `packages/domain/test/impact` |
| F5 | **Coverage is carried.** An `Incomplete` cell is published as "at least" with its reason and suppressed below the minimum; an `Unavailable` cell takes part in no relation and is never turned into a number or a zero | an incomplete cell printed without the reason fails the report test | `packages/domain/test/impact` |
| F6 | **School level is restricted.** The standard report holds no school cell; the restricted one does, suppressed like the rest; no command serves the restricted audience | asking the restricted audience for the standard report's command is not possible: the command has no such parameter (type) | `packages/domain/test/impact`, `apps/web/test` |
| F7 | **Snapshots are immutable and carry their provenance.** A second close of the same cell leaves the first value; every row has its provenance; the adapter has no update or delete; a snapshot whose definition hash differs is marked | an `UPDATE` through the application's port does not exist; a direct `UPDATE` by the table owner is outside the guarantee (port-enforced, stated) | `packages/db/test/impactSnapshots.postgres.test.ts` |
| F8 | **The close job.** It closes an ended semester once, writes nothing for an open semester, writes nothing from an Unavailable source, and two concurrent runs leave one row per cell | the same job over a source that answers writes the rows once, not twice | `packages/db/test/impactSnapshots.postgres.test.ts` |
| F9 | **Access.** An administrator reads the report; a person with no admin place and an anonymous caller are refused (403) with no row read; the section appears in the sidebar for the administrator only | a non-administrator's section is absent and its data answers 403 | `apps/web/test/panelReads.test.ts`, `apps/web/e2e` |
| F10 | **The page.** An administrator opens `/kontrollpanel/effekt`, sees the three measures with their definitions and "Unavailable: placement is not built (spec 0011)" in every cell, and downloads a CSV that says the same | — | `apps/web/e2e/impact.spec.ts` |
| F11 | **Nothing else moved.** `vp check`, `bun run ready`, the personal-data closure (the new table is declared), the module graph, the effx vectors regenerated, the membership-writes model untouched | — | CI |

## Open items for the sponsor team and the board (not invented here)

1. **What counts as "placed"?** Proposal: a placement that exists for the semester (state Placed). Alternatives: only one that ran to the semester's end, or one with a minimum number of visits. This decides all three measures.
2. **Does a school count if its only assistant left?** Proposal: yes, a school with a placement in the semester is served.
3. **Which department does a placement belong to?** Proposal: the school's department (the department whose placement team set the school's capacity). The alternative, the assistant's team's department, changes the department cells and which parts add up: if every school has one department, `schoolsServed` becomes additive (one word in its declaration).
4. **Is the unit the Vektor semester (Vår, Høst), or does the sponsor want an academic year or a calendar year?** The lattice has semesters only. A year is a new period kind with its own closing snapshot, because a distinct count over a year cannot be derived from two semesters.
5. **The minimum (5) and whether zero is shown.** The minimum is a proposal with an `approval` field. A zero is published as a zero in this spec; a department with no placements at all may prefer "–".
6. **Who reads which grain.** Proposal: administrators and the board see departments and totals; a department's placement leaders also see that department's school level (restricted audience); sponsors and the public see only what the board decides to send, from the CSV. Today only administrators read the page (D9).
7. **A public page with the totals.** Not built. If wanted, the same report with the standard audience is the only candidate, and the totals-only view needs its own differencing check (a single total has no parts to difference, but a time series of totals does).
8. **Legacy history.** Which semesters of `AssistantHistory` are reliable enough to publish, and with which `Incomplete` reasons (INFORMATION_MODEL §4 data-quality notes).

## Not done here

- **The legacy aggregate import** (a follow-up spec once placement lands): `AssistantHistory` aggregated by semester and department into `legacy-import` snapshots, with no person rows imported, `Incomplete` where the data is known to be poor.
- **The school entity, the placement table and their source adapter** (spec 0011). The school grain and the live source exist as declarations and a port; the adapter answers Unavailable.
- **A grant row for anyone but administrators**, a public page, a PDF report, year periods, site analytics, telemetry (open items and out of scope above).
- **The semantics of `Incomplete` in a real source**: no source says it yet; the type, the rendering and the tests exist.

## Revisions

### R1 (2026-10-29): first plan

Written before any code, after reading the draft, the operator's decision, INFORMATION_MODEL (§4, §10), the audit domain (the shape of an admin-only read), the registry and the personal-data catalog. The finding that shaped it: `main` has no school, placement or assistant history, so the shipped source is Unavailable. The plan changes under this heading as the build teaches.

### R2 (2026-10-30): as built

What the build changed in the plan above (the text of the decisions is edited to match; this entry says why):

- **`viewImpact` is `listImpact`** (D9). A command whose method is `list` must be named with a leading `list` (`Domain.problems`), so the name followed the method. Its resource is `Impact`, and its error is `Forbidden` alone: the one thing it can refuse is the admin row, and a narrower error keeps the panel's read type (and `readsNeverWrite.postgres.test.ts`) honest.
- **No `source_rows` column** (D7). A count of the source's rows would be a second raw count beside `value` for the same cell, and nothing reads it; provenance is `source`, `source_ref`, `definition_hash` and `closed_at`. If an auditor later needs the row count, it is one nullable column and one line in the close.
- **School-grain cells are not snapshotted** and no command serves them (D6, D7): the grain is declared and released by the same function and tested over a fake source, and the snapshot table has no school column. A snapshot of school cells would need the school entity (spec 0011) for its key; it is deferred with the entity.
- **The page text is Norwegian**, as the panel is: `Utilgjengelig: placement is not built (spec 0011)`, where the reason is the declaration's own text, in English, as the other declared reasons are. The domain's definitions are in both languages (D2).
- **`docs/system/impact.md`** is generated (`tools/docgen/src/impact.ts`; blocks `measures` and `rules`) and the module graph has an `impact` module (uses annotations, kernel, organisation, triggers, vocabulary; `catalog` uses it).
- **The close is a registry job and a command** (D8): `impactClose` joins `SystemJob`, so every effx description changed and the conformance vectors were regenerated at the pinned commit.
- **Panel negative control.** `listImpact` is a command and refuses a non-administrator on its own, so `panelReads.test.ts`'s control "without the guard nothing leaks" exempts the self-guarded reads (`SELF_GUARDED`) and a second control shows that the command alone refuses them.
- **The legacy aggregate import is named** as the follow-up in "What is out of scope", "Not done here" and open item 8: nothing here imports `AssistantHistory`, and the history before the reimagined system stays `Unavailable`.
- **D3 stands, and the lead asked for it to be explicit:** `Unavailable` is the honest state of a live source that does not exist. A zero would be a result nobody computed; the first real number would then read as growth; and an `Unavailable` that is never snapshotted keeps a semester fillable later. The F2 test shows that the shipped source yields no number, no snapshot and no CSV value.
- **Claims limited to what runs:** release's two attacks (exact elimination, bound narrowing) are not a proof that nothing can be recovered; the tests add an independent brute-force oracle over small lattices, which found nothing the release leaks, and the primary-only release as its control.
