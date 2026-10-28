/**
 * The transaction on real PostgreSQL, through `transactional` and through the domain's `Transactor` (spec 0017: the
 * port that the web app declared, now in the domain, over the same runner): commit, and rollback of domain rows, audit
 * rows and outbox rows on a typed failure, a defect and an interruption; a nested run is a savepoint.
 */
import { assert, layer } from "@effect/vitest";
import {
  AuditLog,
  AuditPrincipal,
  InTransaction,
  Outbox,
  OutboxMessage,
  SemesterRepository,
  SlackTarget,
  Transactor,
  validationFailed,
} from "@vektorprogrammet/domain";
import type { Semester } from "@vektorprogrammet/domain";
import { and, eq } from "drizzle-orm";
import { Array as Arr, Deferred, Effect, Exit, Fiber, pipe } from "effect";
import type { SqlClient } from "effect/sql/SqlClient";

import { transactional } from "../src/index.ts";
import * as schema from "../src/schema.ts";
import { Drizzle, postgresDatabase } from "./support/database.ts";
import { AT } from "./support/fixtures.ts";

/** A way to run a program as one transaction. */
type Run = <A, E, R>(
  program: Effect.Effect<A, E, R>
) => Effect.Effect<A, E, Exclude<R, InTransaction> | SqlClient | Transactor>;

const viaTransactor: Run = (program) =>
  Transactor.use((transactor) => transactor.run(program));

/** One semester row, its audit row and one outbox row, all keyed by the year. */
const writeAll = Effect.fnUntraced(function* writeAll(semester: Semester) {
  yield* InTransaction;
  const created = yield* (yield* SemesterRepository).ensure(semester);
  yield* (yield* AuditLog).record({
    action: "department.created",
    at: AT,
    client: "scheduler",
    entity: "Semester",
    entityKey: String(semester.year),
    principal: AuditPrincipal.cases.System.make({ job: "semesters" }),
    sessionId: null,
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

const contract = (name: string, run: Run) => {
  layer(postgresDatabase(), { excludeTestServices: true })(name, (it) => {
    it.effect("commits domain, audit and outbox rows together", () =>
      Effect.gen(function* effectProgram() {
        const semester: Semester = { term: "HOST", year: 2040 };
        yield* run(writeAll(semester));
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
          run(
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
          run(Effect.andThen(writeAll(semester), Effect.die("boom")))
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
          run(
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
      "a nested run is a savepoint: its rollback keeps the outer writes",
      () =>
        Effect.gen(function* effectProgram() {
          const outer: Semester = { term: "VAR", year: 2044 };
          const inner: Semester = { term: "VAR", year: 2045 };
          yield* run(
            Effect.gen(function* savepointProgram() {
              yield* writeAll(outer);
              yield* Effect.exit(
                run(
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
  });
};

contract("transactional on PostgreSQL", transactional);

contract("the domain's Transactor on PostgreSQL", viaTransactor);
