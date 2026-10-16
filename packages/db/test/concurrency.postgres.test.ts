/**
 * Constraint-backed concurrency on real PostgreSQL (devenv), each suite on its
 * own disposable database:
 * - RULE-237: 20 concurrent `ensure` calls yield exactly one row.
 * - RULE-144: 20 concurrent `create` calls yield exactly one success.
 * - Negative control: the same checks against a schema without the unique
 *   (term, year) constraint must fail, proving the constraint carries them.
 * - RULE-096: concurrent article creates with the same slug both succeed with distinct slugs.
 */
import { assert, layer } from "@effect/vitest";
import {
  ArticleRepository,
  SemesterRepository,
  Slug,
  UserId,
  sanitizeRichText,
} from "@vektorprogrammet/domain";
import type { Semester } from "@vektorprogrammet/domain";
import { and, eq, sql } from "drizzle-orm";
import {
  Array as Arr,
  Deferred,
  Effect,
  Exit,
  Option,
  Order,
  Predicate,
  pipe,
} from "effect";

import { schema, transactional } from "../src/index.ts";
import { Drizzle, postgresDatabase } from "./support/database.ts";
import { AT, fileKey, registerImages } from "./support/fixtures.ts";

const CALLERS = 20;

/** Runs `self` from `CALLERS` fibers released together by one gate. */
const race = <A, E, R>(
  self: Effect.Effect<A, E, R>
): Effect.Effect<readonly Exit.Exit<A, E>[], never, R> =>
  Effect.gen(function* raceProgram() {
    const gate = yield* Deferred.make<null>();

    const fibers = Effect.forEach(
      Array.from({ length: CALLERS }),
      () => Effect.andThen(Deferred.await(gate), Effect.exit(self)),
      { concurrency: "unbounded" }
    );

    const [exits] = yield* Effect.all([fibers, Deferred.succeed(gate, null)], {
      concurrency: "unbounded",
    });

    return exits;
  });

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
  const exits = yield* race(semesters.ensure(wanted));
  const rows = yield* semesterRows(wanted);

  const holds =
    rows.length === 1 &&
    pipe(
      exits,
      Arr.every((exit) => Exit.isSuccess(exit) && exit.value.id === rows[0]?.id)
    );

  return { exits, holds, rows };
});

/** RULE-144 property: exactly one success, every other caller refused with `AlreadyExists`, one row. */
const createRace = Effect.fnUntraced(function* createRace(wanted: Semester) {
  const semesters = yield* SemesterRepository;
  const exits = yield* race(semesters.create(wanted));
  const rows = yield* semesterRows(wanted);
  const successes = pipe(exits, Arr.filter(Exit.isSuccess));

  const refusals = pipe(
    exits,
    Arr.filter((exit) =>
      pipe(
        Exit.findErrorOption(exit),
        Option.exists(Predicate.isTagged("AlreadyExists"))
      )
    )
  );

  const holds =
    rows.length === 1 &&
    successes.length === 1 &&
    refusals.length === CALLERS - 1;

  return { exits, holds, rows, successes };
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

    it.effect(
      "RULE-144: 20 concurrent create calls yield exactly one success",
      () =>
        Effect.gen(function* effectProgram() {
          const outcome = yield* createRace({ term: "VAR", year: 2027 });
          assert.strictEqual(outcome.successes.length, 1);
          assert.strictEqual(outcome.rows.length, 1);
          assert.isTrue(outcome.holds);
        })
    );

    it.effect(
      "RULE-096: concurrent creates of the same slug in separate transactions get distinct slugs",
      () =>
        Effect.gen(function* effectProgram() {
          yield* registerImages(fileKey("1"), fileKey("2"));
          const articles = yield* ArticleRepository;

          const draft = {
            authorId: UserId.make(42),
            body: sanitizeRichText("<p>Søk nå</p>"),
            createdAt: AT,
            departmentIds: [],
            imageLargeKey: fileKey("2"),
            imageSmallKey: fileKey("1"),
            published: true,
            slug: Slug.make("opptak-apner"),
            sticky: false,
            title: "Opptak åpner",
          };

          // Two editors pick "opptak-apner" from the same read; the constraint and one retry settle it.
          const exits = yield* Effect.all(
            [
              transactional(articles.create(draft)),
              transactional(articles.create(draft)),
            ],
            { concurrency: "unbounded" }
          ).pipe(Effect.exit);

          assert.isTrue(Exit.isSuccess(exits));

          if (Exit.isSuccess(exits)) {
            assert.deepStrictEqual(
              pipe(
                exits.value,
                Arr.map((article) => article.slug),
                Arr.sortBy<readonly string[]>(Order.String)
              ),
              ["opptak-apner", "opptak-apner-2"]
            );
          }
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

    it.effect(
      "RULE-144 negative control: without the constraint the create race check fails",
      () =>
        Effect.gen(function* effectProgram() {
          yield* dropConstraint;
          const outcome = yield* createRace({ term: "VAR", year: 2027 });
          assert.isFalse(outcome.holds);
          assert.strictEqual(outcome.successes.length, 0);
        })
    );
  }
);
