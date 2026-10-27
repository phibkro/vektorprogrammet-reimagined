/**
 * Spec 0007b R3 item 29: the two derivations that the migration `person_last_activity_end` adds and that Drizzle cannot
 * model. `semester_end` is a second copy of RULE-022 (the end of `semesterWindow`), and the retention triggers, the alumni
 * candidates and the view of a person's last activity all take part in decisions that the domain's copy also makes
 * (`leftAt`, `stillAsked`). The migration says that this file checks the two against each other over a range of years; it
 * does, for both terms and every year of the range, and against the two instants that the Oslo calendar gives for one
 * year, so that two copies that were wrong in the same way would not pass. The domain's copy is read through `leftAt`,
 * the exported rule that decides who has left: the window arithmetic itself is not exported (`oneDefinition.test.ts`).
 */
import { assert, layer } from "@effect/vitest";
import { leftAt } from "@vektorprogrammet/domain";
import type { Term } from "@vektorprogrammet/domain";
import { Array as Arr, DateTime, Effect, Option } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { postgresDatabase } from "./support/database.ts";

const FIRST_YEAR = 2000;
const LAST_YEAR = 2100;
const TERMS = ["VAR", "HOST"] as const;

/** Later than every end that the range has, so that a person whose only membership ends in it has left. */
const LONG_AFTER = DateTime.makeUnsafe("2200-01-01T00:00:00Z");

/** The end of a semester by the domain: the end of a membership that ends in it, which is when the person has left. */
const domainEnd = (term: Term, year: number): number =>
  DateTime.toEpochMillis(
    Option.getOrThrow(leftAt([{ end: { term, year } }], LONG_AFTER))
  );

/** `semester_end` of one term for every year of the range, in year order. */
const endsOf = Effect.fnUntraced(function* endsOf(term: Term) {
  const sql = yield* SqlClient;

  return yield* sql<{
    readonly ends: Date;
    readonly year: number;
  }>`select y.year, semester_end(${term}::semester_term, y.year) as ends
    from generate_series(${FIRST_YEAR}, ${LAST_YEAR}) as y(year) order by y.year`;
});

/** The end of the term in 2026 as the function gives it, in ISO text. */
const endIn2026 = Effect.fnUntraced(function* endIn2026(term: Term) {
  const rows = yield* endsOf(term);

  return Option.map(
    Arr.findFirst(rows, ({ year }) => year === 2026),
    ({ ends }) => ends.toISOString()
  );
});

layer(postgresDatabase(), { excludeTestServices: true })(
  "spec 0007b R3 item 29: semester_end is the end of the semester's window",
  (it) => {
    it.effect(
      `both terms, every year from ${FIRST_YEAR} to ${LAST_YEAR}: the function and the domain give the same instant`,
      () =>
        Effect.gen(function* sameInstants() {
          for (const term of TERMS) {
            const rows = yield* endsOf(term);

            assert.strictEqual(rows.length, LAST_YEAR - FIRST_YEAR + 1);

            for (const { ends, year } of rows) {
              assert.strictEqual(
                ends.getTime(),
                domainEnd(term, year),
                `${term} ${year}`
              );
            }
          }
        })
    );

    it.effect(
      "the ends of 2026 are the instants that the Oslo calendar gives: Vår on 1 August at midnight (22:00 UTC the day before, in summer time), Høst on 1 January 2027 (23:00 UTC the day before)",
      () =>
        Effect.gen(function* byTheCalendar() {
          assert.deepStrictEqual(
            yield* endIn2026("VAR"),
            Option.some("2026-07-31T22:00:00.000Z")
          );

          assert.deepStrictEqual(
            yield* endIn2026("HOST"),
            Option.some("2026-12-31T23:00:00.000Z")
          );
        })
    );

    it.effect(
      "negative control: a function that ends a term at UTC midnight and not Oslo midnight differs from the domain in every year, so the comparison can fail",
      () =>
        Effect.gen(function* inUtc() {
          const sql = yield* SqlClient;

          const springs = yield* sql<{
            readonly ends: Date;
            readonly year: number;
          }>`select y.year, make_timestamptz(y.year, 8, 1, 0, 0, 0, 'UTC') as ends
            from generate_series(${FIRST_YEAR}, ${LAST_YEAR}) as y(year)`;

          const differing = Arr.filter(
            springs,
            ({ ends, year }) => ends.getTime() !== domainEnd("VAR", year)
          );

          assert.strictEqual(differing.length, LAST_YEAR - FIRST_YEAR + 1);
        })
    );
  }
);
