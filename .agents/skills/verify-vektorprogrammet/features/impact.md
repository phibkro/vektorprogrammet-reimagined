# Evidence of operations

Spec 0027. An administrator opens `Effekt` in the control panel and sees, for each ended semester, the three measures (assistants placed, placements, schools served) by department and for all departments, each with its definition in words; a number below five reads `< 5`; a cell that no source answers reads `Utilgjengelig: <reason>`; and the page's CSV holds the same cells. **Today every cell is unavailable**: `main` has no school, placement or assistant history, so the source that ships answers `placement is not built (spec 0011)` for every cell, and nothing is estimated and no zero stands in for it. The job `impactClose` (a proposed cadence: it installs no trigger) would freeze the cells that a source answers into `impact_snapshot`, once.

## Sub-features

- `impact-page` `/kontrollpanel/effekt` (sidebar: `Effekt`, group `Administrasjon`, administrators only) shows a heading `Effekt`, a card per ended semester (`Vår 2018`), and a row per measure with its Norwegian definition; the columns are `Alle avdelinger` and each department. Every cell reads `Utilgjengelig: placement is not built (spec 0011)`, and no cell is a bare number.
- `impact-csv` `Last ned CSV` saves `effekt.csv`: the header is `measure,semester,department,school,status,value,coverage,reason,definition`, a row per cell, `status` is `published`, `suppressed` or `unavailable`, a suppressed cell has an empty value and the reason `less than 5`, and every row ends with its measure's definition. Its content is `impactCsv`'s, tested in `packages/domain/test/impact/release.test.ts`; the browser test checks only the saved file's name.
- `impact-refused` anyone who holds no `listImpact` (a leader, a member, an anonymous visitor) gets `403` for the page and its data, and the sidebar has no `Effekt`. The command is held through the admin row alone (spec D9); who else reads is an open item of the spec.
- `impact-close` the command `closeImpact`, run as `System("impactClose")`: with the source that ships it writes nothing (`closed: 0`, the cells counted as `unavailable`); with a source that answers it writes each cell of each ended semester once and never an open semester. **Not drivable in the browser stack**: the job's cadence is proposed (no trigger), and no source answers. `packages/db/test/impactSnapshots.postgres.test.ts` runs it against PostgreSQL with a source that answers.

## How to get to it (user POV)

- Sign in as an administrator, open `Effekt` in the sidebar. The importer's fixture may hold no ended semester; the browser test inserts one (`insert into semester (term, year) values ('VAR', 2018)`), and so can you.

## Driving it with verify-vektorprogrammet

Preconditions:

- `scripts/doctor.sh` printed `DOCTOR OK`; `state.env` names `E2E_BASE_URL` and `E2E_DATABASE_URL`.

Steps:

- **The page.** `scripts/page.sh /kontrollpanel/effekt --as "Ada Admin" --name effekt` prints `200`; `pages/effekt.html` holds the three measure names and `Utilgjengelig: placement is not built (spec 0011)`, and no table cell of a bare number. An ended semester must exist (the importer's fixture may have none; insert one as the browser test does).
- **Refusal.** `scripts/page.sh /kontrollpanel/effekt --as "Lise Leder" --name effekt-leader` prints `403`.
- **The browser test.** `scripts/drive.sh impact.spec.ts` (two tests) passes.
- **No snapshot is written.** `psql "$E2E_DATABASE_URL" -tAc "select count(*) from impact_snapshot"` prints `0`: the page reads and never writes, and the close writes nothing without a source.
- **Proof.** `scripts/report.sh --features "impact-page, impact-csv, impact-refused"`.

## Gotchas

- A page full of `Utilgjengelig` is the correct state today, not a fault. A number on this page means a source answered, which nothing on this stack does yet.
- A number below five is never on the page. If you see `3` in a cell, that is the defect (spec 0027 F3).
- `docs/system/impact.md` is generated (`bun run docs`; `bun run check:docs` fails when it differs from `packages/domain/src/impact/measures.ts`).
