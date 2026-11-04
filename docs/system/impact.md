# Evidence of operations

What Vektorprogrammet can show about what it delivers: the distinct assistants placed, the schools served and the placements of each ended semester, by department. Spec 0027 builds it; the sponsor team and the board still confirm the definitions (the open items of the spec).

The page is generated from `packages/domain/src/impact/measures.ts` (the measures, their definitions, grains and audiences, and the minimum) and checked by `bun run check:docs`. The sponsor pipeline stays in Notion and Drive (decision 0005); telemetry and site analytics are other channels with other guarantees.

## What it shows today

**Nothing is counted.** The tables that placement would fill (a school, a placement) do not exist (spec 0011 is not built), so every cell answers **Unavailable** with a reason, and the control panel page `Effekt` and its CSV say so. A zero would say that the system counted and found nobody; an unavailable cell says that nothing was counted. The day a source answers, the cells fill in. A closed semester's cells are written once into `impact_snapshot` with their provenance, and only from a source that answered.

## How to read it

- **A count below the minimum is never output.** The cell reads `hidden` (the minimum is a proposal), and so does a neighbouring cell when the small count could otherwise be calculated from the published ones: a total can be published beside a hidden part only when the part cannot be recovered from it. A hidden cell therefore says nothing about its size; it may be small or large. The reader of the release is assumed to know which hidden cells hold a small count, and the release holds back what that reader could still calculate exactly; a reader may still narrow a small count to a shorter range than "below the minimum".
- **Coverage is part of every cell:** complete, incomplete (a number that says "at least", with the reason) or unavailable (with the reason).
- **The standard audience sees departments and the total of all departments.** A school's cell is a grain of its own for a restricted audience, and no output of the standard audience holds one.
- **Who reads:** administrators today. Who else is an open item of the spec.

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

<!-- docgen:end rules -->
