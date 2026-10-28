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
import { DatabaseLive } from "@vektorprogrammet/db";
import {
  TestDatabaseUrl,
  migratedTestDatabase,
  serializableByDefault,
} from "@vektorprogrammet/db/testing";
import { Forbidden, IsolationProbe } from "@vektorprogrammet/domain";
import type { IsolationReport } from "@vektorprogrammet/domain";
import { Effect, Layer, Option, Schema } from "effect";
import type { Redacted } from "effect";

import { success } from "../src/lib/outcome";
import { failureOf } from "../src/server/errors";
import {
  isolationProblems,
  isolationReport,
  isolationResponse,
} from "../src/server/isolation";

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

const bodyOf = (response: Response) =>
  Effect.flatMap(
    Effect.promise(() => response.text()),
    Schema.decodeUnknownEffect(Schema.fromJsonString(Body))
  );

const databaseAt = (url: Redacted.Redacted) =>
  DatabaseLive({ maxConnections: 2, url }).pipe(Layer.orDie);

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
            assert.deepStrictEqual(yield* bodyOf(response), {
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

          const response = isolationResponse(success(report));
          assert.strictEqual(response.status, 404);
          assert.strictEqual(yield* Effect.promise(() => response.text()), "");
        })
    );

    it.effect(
      "falsifier 4: the failure of the request answers with its own status",
      () =>
        Effect.sync(() => {
          const refused = isolationResponse(
            failureOf(new Forbidden({ command: "createDepartment" }))
          );

          assert.strictEqual(refused.status, 403);
        })
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

          const { problems } = yield* bodyOf(response);
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
