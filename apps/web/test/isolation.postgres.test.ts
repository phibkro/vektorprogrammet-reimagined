/**
 * Spec 0018 R10, falsifier 4, the deployed path: what `GET /api/isolation` answers, and the check that the pull request's
 * Preview job relies on (`.github/workflows/preview.yml` asks the same route of the Worker Preview, through Hyperdrive).
 *
 * - On a database whose role defaults to READ COMMITTED, a preview and a local deployment report the three levels
 *   (`read committed`, `serializable`, `read committed`) and the route answers 200.
 * - On one whose role defaults to SERIALIZABLE, the transactions of the adapter still read `read committed` and the
 *   SERIALIZABLE probe still reads `serializable`, and the route answers 500 naming the role's default: the check can
 *   fail on the deployed role's default, which standalone statements run at.
 * - A report in which the probe reads `read committed` (what a platform that drops the clause makes it read), one in
 *   which a `Transactor.run` transaction reads `serializable`, and an empty answer each fail `isolationProblems`: the
 *   check cannot pass by luck.
 * - A production deployment answers an empty 404 and never asks the store.
 */
import { assert, describe, it as plain, layer } from "@effect/vitest";
import {
  TestDatabaseUrl,
  migratedTestDatabase,
  serializableByDefault,
} from "@vektorprogrammet/db/testing";
import { IsolationProbe } from "@vektorprogrammet/domain";
import type { IsolationReport } from "@vektorprogrammet/domain";
import { Effect, Option, Schema } from "effect";

import { success } from "../src/lib/outcome";
import {
  isolationProblems,
  isolationReport,
  isolationResponse,
} from "../src/server/isolation";
import {
  assertEmpty404,
  assertFailureStatus,
  bodyOf,
  databaseAt,
} from "./support/diagnosticRoute";

const GOOD: IsolationReport = {
  probe: "serializable",
  roleDefault: "read committed",
  transactor: "read committed",
};

/** What the route sends: the report and the problems that `isolationProblems` found in it. */
const Body = Schema.Struct({
  probe: Schema.String,
  problems: Schema.Array(Schema.String),
  roleDefault: Schema.String,
  transactor: Schema.String,
});

/** A probe that fails the test when it is used: production must never reach the store. */
const untouchable = IsolationProbe.of({
  report: Effect.die("a production deployment reached the store"),
});

layer(migratedTestDatabase, { excludeTestServices: true })(
  "GET /api/isolation on a role that defaults to read committed (spec 0018 R10)",
  (it) => {
    it.effect(
      "falsifier 4: a preview and a local deployment report the three levels, and the route answers 200",
      () =>
        Effect.gen(function* reportsTheThreeLevels() {
          const database = databaseAt(yield* TestDatabaseUrl);

          for (const deployment of ["preview", "local"]) {
            const report = yield* isolationReport(deployment).pipe(
              Effect.provide(database)
            );

            // The check first: a report that is not the promised one answers 500 and says why.
            const response = isolationResponse(success(report));
            assert.deepStrictEqual(yield* bodyOf(Body, response), {
              ...GOOD,
              problems: [],
            });

            assert.strictEqual(response.status, 200);
            assert.deepStrictEqual(report, Option.some(GOOD));
          }
        })
    );

    it.effect(
      "falsifier 4: a production deployment answers an empty 404 and never asks the store",
      () =>
        Effect.gen(function* answersNothing() {
          const database = databaseAt(yield* TestDatabaseUrl);

          const report = yield* isolationReport("production").pipe(
            Effect.provideService(IsolationProbe, untouchable),
            Effect.provide(database)
          );

          assert.deepStrictEqual(report, Option.none());

          yield* assertEmpty404(isolationResponse(success(report)));
        })
    );

    it.effect(
      "falsifier 4: the failure of the request answers with its own status",
      () => assertFailureStatus(isolationResponse)
    );
  }
);

layer(migratedTestDatabase, { excludeTestServices: true })(
  "GET /api/isolation on a role that defaults to SERIALIZABLE (spec 0018 R10)",
  (it) => {
    it.effect(
      "falsifier 4: the adapter's transactions still read read committed, and the route answers 500 naming the role's default",
      () =>
        Effect.gen(function* failsOnTheRoleDefault() {
          const database = databaseAt(yield* serializableByDefault);

          const report = yield* isolationReport("preview").pipe(
            Effect.provide(database)
          );

          assert.deepStrictEqual(
            report,
            Option.some({ ...GOOD, roleDefault: "serializable" })
          );

          const response = isolationResponse(success(report));
          assert.strictEqual(response.status, 500);

          const { problems } = yield* bodyOf(Body, response);
          assert.lengthOf(problems, 1);
          assert.include(problems[0] ?? "", "the role's default");
        })
    );
  }
);

describe("isolationProblems (spec 0018 R10)", () => {
  plain(
    "falsifier 4: a report that is what the domain promises has no problem",
    () => {
      assert.deepStrictEqual(isolationProblems(GOOD), []);
    }
  );

  plain(
    "falsifier 4, control: a platform that drops the clause makes the probe read the role's default, and the check fails",
    () => {
      const problems = isolationProblems({ ...GOOD, probe: "read committed" });
      assert.lengthOf(problems, 1);
      assert.include(problems[0] ?? "", "does not forward the clause");
    }
  );

  plain(
    "falsifier 4, control: a Transactor.run transaction at another level, and an empty answer, each fail the check",
    () => {
      assert.lengthOf(
        isolationProblems({ ...GOOD, transactor: "serializable" }),
        1
      );

      assert.lengthOf(
        isolationProblems({
          probe: "no answer",
          roleDefault: "no answer",
          transactor: "no answer",
        }),
        3
      );
    }
  );
});
