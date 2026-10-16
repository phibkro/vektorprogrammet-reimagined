/**
 * `transactional` on real PostgreSQL: commit, and rollback of domain rows,
 * audit rows and outbox rows on a typed failure, a defect and an interruption;
 * a nested `transactional` is a savepoint.
 */
import { assert, layer } from "@effect/vitest";
import {
  AuditLog,
  InTransaction,
  Outbox,
  OutboxMessage,
  SemesterRepository,
  SlackTarget,
  UserId,
  validationFailed,
} from "@vektorprogrammet/domain";
import type { Semester } from "@vektorprogrammet/domain";
import { and, eq } from "drizzle-orm";
import { Array as Arr, Deferred, Effect, Exit, Fiber, pipe } from "effect";

import { schema, transactional } from "../src/index.ts";
import { Drizzle, postgresDatabase } from "./support/database.ts";
import { AT } from "./support/fixtures.ts";

/** One semester row, its audit row and one outbox row, all keyed by the year. */
const writeAll = Effect.fnUntraced(function* writeAll(semester: Semester) {
  yield* InTransaction;
  const created = yield* (yield* SemesterRepository).ensure(semester);
  yield* (yield* AuditLog).record({
    action: "department.created",
    actorId: UserId.make(1),
    at: AT,
    entity: "Semester",
    entityKey: String(semester.year),
  });
  yield* (yield* Outbox).enqueue([
    OutboxMessage.cases.SlackPost.make({
      target: SlackTarget.cases.Notifications.make({}),
      text: `semester ${semester.year}`,
    }),
  ]);

  return created;
});

const counts = Effect.fnUntraced(function* counts(semester: Semester) {
  const db = yield* Drizzle;

  const semesters = yield* db
    .select()
    .from(schema.semester)
    .where(
      and(
        eq(schema.semester.term, semester.term),
        eq(schema.semester.year, semester.year)
      )
    );

  const audits = yield* db
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.entityKey, String(semester.year)));

  const outbox = pipe(
    yield* db.select().from(schema.outbox),
    Arr.filter((row) =>
      JSON.stringify(row.payload).includes(`semester ${semester.year}`)
    )
  );

  return {
    audits: audits.length,
    outbox: outbox.length,
    semesters: semesters.length,
  };
});

const assertNoWrites = Effect.fnUntraced(function* assertNoWrites(
  semester: Semester
) {
  assert.deepStrictEqual(yield* counts(semester), {
    audits: 0,
    outbox: 0,
    semesters: 0,
  });
});

layer(postgresDatabase(), { excludeTestServices: true })(
  "transactional on PostgreSQL",
  (it) => {
    it.effect("commits domain, audit and outbox rows together", () =>
      Effect.gen(function* effectProgram() {
        const semester: Semester = { term: "HOST", year: 2040 };
        yield* transactional(writeAll(semester));
        assert.deepStrictEqual(yield* counts(semester), {
          audits: 1,
          outbox: 1,
          semesters: 1,
        });
      })
    );

    it.effect("a typed failure rolls back domain, audit and outbox rows", () =>
      Effect.gen(function* effectProgram() {
        const semester: Semester = { term: "HOST", year: 2041 };

        const exit = yield* Effect.exit(
          transactional(
            Effect.andThen(
              writeAll(semester),
              Effect.fail(validationFailed(["year"], "nei"))
            )
          )
        );

        assert.isTrue(Exit.hasFails(exit));
        yield* assertNoWrites(semester);
      })
    );

    it.effect("a defect rolls back everything", () =>
      Effect.gen(function* effectProgram() {
        const semester: Semester = { term: "HOST", year: 2042 };

        const exit = yield* Effect.exit(
          transactional(Effect.andThen(writeAll(semester), Effect.die("boom")))
        );

        assert.isTrue(Exit.hasDies(exit));
        yield* assertNoWrites(semester);
      })
    );

    it.effect("an interruption after the writes rolls back everything", () =>
      Effect.gen(function* effectProgram() {
        const semester: Semester = { term: "HOST", year: 2043 };
        const written = yield* Deferred.make<null>();

        const fiber = yield* Effect.forkChild(
          transactional(
            Effect.andThen(
              writeAll(semester),
              Effect.andThen(Deferred.succeed(written, null), Effect.never)
            )
          )
        );

        yield* Deferred.await(written);
        yield* Fiber.interrupt(fiber);
        yield* assertNoWrites(semester);
      })
    );

    it.effect(
      "a nested transactional is a savepoint: its rollback keeps the outer writes",
      () =>
        Effect.gen(function* effectProgram() {
          const outer: Semester = { term: "VAR", year: 2044 };
          const inner: Semester = { term: "VAR", year: 2045 };
          yield* transactional(
            Effect.gen(function* savepointProgram() {
              yield* writeAll(outer);
              yield* Effect.exit(
                transactional(
                  Effect.andThen(
                    writeAll(inner),
                    Effect.fail(validationFailed([], "nei"))
                  )
                )
              );
            })
          );
          assert.deepStrictEqual(yield* counts(outer), {
            audits: 1,
            outbox: 1,
            semesters: 1,
          });
          yield* assertNoWrites(inner);
        })
    );
  }
);
