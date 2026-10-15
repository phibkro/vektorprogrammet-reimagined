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
  type Semester,
} from "@vektorprogrammet/domain";
import { and, eq, sql } from "drizzle-orm";
import { Deferred, Effect, Exit, Option } from "effect";
import { schema, transactional } from "../src/index.ts";
import { Drizzle, postgresDatabase } from "./support/database.ts";
import { AT, fileKey, registerImages } from "./support/fixtures.ts";

const CALLERS = 20;

/** Runs `self` from `CALLERS` fibers released together by one gate. */
const race = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const fibers = Effect.forEach(
      Array.from({ length: CALLERS }),
      () => Effect.andThen(Deferred.await(gate), Effect.exit(self)),
      { concurrency: "unbounded" },
    );
    const [exits] = yield* Effect.all([fibers, Deferred.succeed(gate, undefined)], {
      concurrency: "unbounded",
    });
    return exits;
  });

const semesterRows = Effect.fnUntraced(function* (wanted: Semester) {
  const db = yield* Drizzle;
  return yield* db
    .select()
    .from(schema.semester)
    .where(and(eq(schema.semester.term, wanted.term), eq(schema.semester.year, wanted.year)));
});

/** RULE-237 property: one row, and every caller got that row. */
const ensureRace = Effect.fnUntraced(function* (wanted: Semester) {
  const semesters = yield* SemesterRepository;
  const exits = yield* race(semesters.ensure(wanted));
  const rows = yield* semesterRows(wanted);
  const holds =
    rows.length === 1 &&
    exits.every((exit) => Exit.isSuccess(exit) && exit.value.id === rows[0]?.id);
  return { exits, rows, holds };
});

/** RULE-144 property: exactly one success, every other caller refused with `AlreadyExists`, one row. */
const createRace = Effect.fnUntraced(function* (wanted: Semester) {
  const semesters = yield* SemesterRepository;
  const exits = yield* race(semesters.create(wanted));
  const rows = yield* semesterRows(wanted);
  const successes = exits.filter(Exit.isSuccess);
  const refusals = exits.filter((exit) =>
    Option.exists(Exit.findErrorOption(exit), (error) => error._tag === "AlreadyExists"),
  );
  const holds = rows.length === 1 && successes.length === 1 && refusals.length === CALLERS - 1;
  return { exits, rows, successes, holds };
});

layer(postgresDatabase(), { excludeTestServices: true })(
  "unique (term, year) on PostgreSQL",
  (it) => {
    it.effect("RULE-237: 20 concurrent ensure calls yield exactly one row", () =>
      Effect.gen(function* () {
        const outcome = yield* ensureRace({ term: "HOST", year: 2026 });
        assert.strictEqual(outcome.rows.length, 1);
        assert.isTrue(outcome.exits.every(Exit.isSuccess));
        assert.isTrue(outcome.holds);
      }),
    );

    it.effect("RULE-144: 20 concurrent create calls yield exactly one success", () =>
      Effect.gen(function* () {
        const outcome = yield* createRace({ term: "VAR", year: 2027 });
        assert.strictEqual(outcome.successes.length, 1);
        assert.strictEqual(outcome.rows.length, 1);
        assert.isTrue(outcome.holds);
      }),
    );

    it.effect(
      "RULE-096: concurrent creates of the same slug in separate transactions get distinct slugs",
      () =>
        Effect.gen(function* () {
          yield* registerImages(fileKey("1"), fileKey("2"));
          const articles = yield* ArticleRepository;
          const draft = {
            title: "Opptak åpner",
            slug: Slug.make("opptak-apner"),
            body: sanitizeRichText("<p>Søk nå</p>"),
            imageSmallKey: fileKey("1"),
            imageLargeKey: fileKey("2"),
            sticky: false,
            published: true,
            departmentIds: [],
            authorId: UserId.make(42),
            createdAt: AT,
          };
          // Two editors pick "opptak-apner" from the same read; the constraint and one retry settle it.
          const exits = yield* Effect.all(
            [transactional(articles.create(draft)), transactional(articles.create(draft))],
            { concurrency: "unbounded" },
          ).pipe(Effect.exit);
          assert.isTrue(Exit.isSuccess(exits));
          if (Exit.isSuccess(exits)) {
            assert.deepStrictEqual(exits.value.map((a) => a.slug).sort(), [
              "opptak-apner",
              "opptak-apner-2",
            ]);
          }
        }),
    );
  },
);

layer(postgresDatabase(), { excludeTestServices: true })(
  "negative control: no unique (term, year) constraint",
  (it) => {
    const dropConstraint = Effect.gen(function* () {
      const db = yield* Drizzle;
      yield* db.execute(
        sql`alter table semester drop constraint if exists semester_term_year_unique`,
      );
    });

    it.effect("RULE-237 negative control: without the constraint the ensure race check fails", () =>
      Effect.gen(function* () {
        yield* dropConstraint;
        const outcome = yield* ensureRace({ term: "HOST", year: 2026 });
        // The property the positive test asserts does not hold.
        assert.isFalse(outcome.holds);
        // Why: ON CONFLICT (term, year) has no arbiter, so no caller gets a row.
        assert.isTrue(outcome.exits.some(Exit.hasDies));
        assert.strictEqual(outcome.rows.length, 0);
      }),
    );

    it.effect("RULE-144 negative control: without the constraint the create race check fails", () =>
      Effect.gen(function* () {
        yield* dropConstraint;
        const outcome = yield* createRace({ term: "VAR", year: 2027 });
        assert.isFalse(outcome.holds);
        assert.strictEqual(outcome.successes.length, 0);
      }),
    );
  },
);
