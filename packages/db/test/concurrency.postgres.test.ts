/**
 * Constraint-backed concurrency on real PostgreSQL (devenv), each suite on its
 * own disposable database:
 * - RULE-237: 20 concurrent `ensure` calls yield exactly one row.
 * - Negative control: the same check against a schema without the unique
 *   (term, year) constraint must fail, proving the constraint carries it.
 */
import { assert, layer } from "@effect/vitest";
import { SemesterRepository } from "@vektorprogrammet/domain";
import type { Semester } from "@vektorprogrammet/domain";
import { and, eq, sql } from "drizzle-orm";
import { Array as Arr, Effect, Exit, pipe } from "effect";

import * as schema from "../src/schema.ts";
import { Drizzle, postgresDatabase } from "./support/database.ts";
import { race } from "./support/race.ts";

const CALLERS = 20;

const semesterRows = Effect.fnUntraced(function* semesterRows(
  wanted: Semester
) {
  const db = yield* Drizzle;

  return yield* db
    .select()
    .from(schema.semester)
    .where(
      and(
        eq(schema.semester.term, wanted.term),
        eq(schema.semester.year, wanted.year)
      )
    );
});

/** RULE-237 property: one row, and every caller got that row. */
const ensureRace = Effect.fnUntraced(function* ensureRace(wanted: Semester) {
  const semesters = yield* SemesterRepository;

  const exits = yield* race(
    Arr.makeBy(CALLERS, () => semesters.ensure(wanted))
  );

  const rows = yield* semesterRows(wanted);

  const holds =
    rows.length === 1 &&
    pipe(
      exits,
      Arr.every((exit) => Exit.isSuccess(exit) && exit.value.id === rows[0]?.id)
    );

  return { exits, holds, rows };
});

layer(postgresDatabase(), { excludeTestServices: true })(
  "unique (term, year) on PostgreSQL",
  (it) => {
    it.effect(
      "RULE-237: 20 concurrent ensure calls on an empty table yield exactly one row",
      () =>
        Effect.gen(function* effectProgram() {
          const db = yield* Drizzle;
          assert.strictEqual(yield* db.$count(schema.semester), 0);

          const outcome = yield* ensureRace({ term: "HOST", year: 2026 });
          assert.strictEqual(outcome.rows.length, 1);
          assert.strictEqual(yield* db.$count(schema.semester), 1);
          assert.isTrue(pipe(outcome.exits, Arr.every(Exit.isSuccess)));
          assert.isTrue(outcome.holds);
        })
    );
  }
);

layer(postgresDatabase(), { excludeTestServices: true })(
  "negative control: no unique (term, year) constraint",
  (it) => {
    const dropConstraint = Effect.gen(function* dropConstraint() {
      const db = yield* Drizzle;
      yield* db.execute(
        sql`alter table semester drop constraint if exists semester_term_year_unique`
      );
    });

    it.effect(
      "RULE-237 negative control: without the constraint the ensure race check fails",
      () =>
        Effect.gen(function* effectProgram() {
          yield* dropConstraint;
          const outcome = yield* ensureRace({ term: "HOST", year: 2026 });
          // The property the positive test asserts does not hold.
          assert.isFalse(outcome.holds);
          // Why: ON CONFLICT (term, year) has no arbiter, so no caller gets a row.
          assert.isTrue(
            pipe(
              outcome.exits,
              Arr.some((exit) => Exit.hasDies(exit))
            )
          );
          assert.strictEqual(outcome.rows.length, 0);
        })
    );
  }
);
