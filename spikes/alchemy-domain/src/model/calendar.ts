/**
 * The domain's calendar rules, from the one module that owns them.
 *
 * `@vektorprogrammet/domain` exports the answers to calendar questions and not the arithmetic they are built from
 * (`semesterForDate`, `semesterWindow`: `oneDefinition.test.ts` pins that surface), so that no caller assembles a
 * second "current semester". An aggregate's `decide` must compute the current semester from the platform's `now`
 * (`ctx.now`), not from the clock of whatever fiber runs it, so it needs the pure functions. The spike therefore
 * imports the same source file by path: one definition, not a copy.
 *
 * Relaxation (REPORT.md "Relaxations"): the `no-restricted-imports` source-path rule is off for this file only.
 */
export {
  semesterForDate,
  semesterWindow,
} from "../../../../packages/domain/src/organisation/semester.ts";
