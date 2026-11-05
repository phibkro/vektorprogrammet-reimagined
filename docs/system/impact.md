# Evidence of operations

What Vektorprogrammet can show about what it delivers: the distinct assistants placed, the schools served and the placements of each ended semester, by department. Spec 0027 builds it; the sponsor team and the board still confirm the definitions (the open items of the spec).

The marked blocks are generated from `apps/web/src/features/impact/domain/measures.ts` and checked by `vp run check:docs`. The sponsor pipeline stays in Notion and Drive (decision 0005); telemetry and site analytics are separate concerns.

## What it shows today

**The shipped source counts nothing.** Placement tables do not exist yet (spec 0011), so live cells answer **Unavailable** with a reason. A zero would falsely claim that a count was made. Existing snapshots are rechecked under the current release rules. New snapshots require a complete source answer and an accepted privacy check for the whole lattice.

## How to read it

- **Small counts are never published.** Accepted lattices use primary and complementary suppression. A hidden label carries no explicit size bound: complementary suppression can hide a large count too. The checks assume a reader who independently knows which hidden cells are primary.
- **Coverage is part of every cell:** complete, incomplete (a number that says "at least", with the reason) or unavailable (with the reason).
- **The standard audience sees departments and the total of all departments.** A school's cell is a grain of its own for a restricted audience, and no output of the standard audience holds one.
- **Who reads:** administrators today. Who else is an open item of the spec.
- **Privacy refusal is not missing source data.** If suppression cannot satisfy the checks, the whole measure/semester lattice is explicitly refused and has no cells. The page shows a refusal notice; its CSV has a `refused` row with empty value and coverage. The close job writes no new snapshots for that lattice and records a separate refused count. Other accepted lattices remain available.
- **Limits:** refusal cannot erase external knowledge. The checks cover the implemented elimination and bounded narrowing attacks, not all integer inference, inference from the selection algorithm, or refusal side channels.

## The measures

<!-- docgen:begin measures -->

| Measure | Definition (English) | Definisjon (norsk) | Parts | Grains |
| --- | --- | --- | --- | --- |
| `assistantsPlaced`: Assistants placed | The distinct people placed at a school in the semester: a person placed twice counts once. | Antall ulike personer som er plassert på en skole i semesteret: en person som er plassert to ganger telles én gang. | The total is at least the largest part and at most the sum of the parts. | department (standard), school (restricted) |
| `placements`: Placements | The placements of the semester: one assistant at one school is one placement. | Antall plasseringer i semesteret: én assistent på én skole er én plassering. | The total is the sum of the parts. | department (standard), school (restricted) |
| `schoolsServed`: Schools served | The distinct schools with at least one placement in the semester. | Antall ulike skoler med minst én plassering i semesteret. | The total is at least the largest part and at most the sum of the parts. | department (standard) |

<!-- docgen:end measures -->

## The rules

<!-- docgen:begin rules -->

| Rule | Value |
| --- | --- |
| Minimum: a count from 1 to the minimum less one is suppressed | 5 (proposed: awaiting operator approval) |
| What a hidden cell says | hidden: A count below 5 is hidden, and so is a neighbouring cell when it would otherwise give that count away: a hidden cell may be small or large. |
| The reason of a cell that no source answers | `placement is not built (spec 0011)` |
| When a lattice cannot be protected | This report cannot be released safely. |

<!-- docgen:end rules -->
