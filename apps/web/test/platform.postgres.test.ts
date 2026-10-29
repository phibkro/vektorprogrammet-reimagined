/**
 * Spec 0025 R5, falsifier 1: what `GET /api/platform` answers, and the check that the pull request's Preview job relies on
 * (`.github/workflows/preview.yml` asks the same route of the Worker Preview, through Hyperdrive).
 *
 * - On a migrated database a preview and a local deployment report every check that the domain requires, each held, with the
 *   profile and the deployment, and the route answers 200.
 * - A report with one check that did not hold, one with a check missing and an empty one each answer 500 naming the check:
 *   the route cannot answer 200 by leaving a check out.
 * - A production deployment answers an empty 404 and never asks the store.
 * - The failure of the request answers with its own status.
 */
import { assert, layer } from "@effect/vitest";
import { DatabaseLive } from "@vektorprogrammet/db";
import {
  TestDatabaseUrl,
  migratedTestDatabase,
} from "@vektorprogrammet/db/testing";
import {
  Forbidden,
  PlatformProbe,
  requiredChecks,
} from "@vektorprogrammet/domain";
import type { PlatformReport } from "@vektorprogrammet/domain";
import { Array as Arr, Effect, Layer, Option, Schema } from "effect";
import type { Redacted } from "effect";

import { success } from "../src/lib/outcome";
import { failureOf } from "../src/server/errors";
import { platformReport, platformResponse } from "../src/server/platform";

const Body = Schema.Struct({
  checks: Schema.Array(
    Schema.Struct({
      detail: Schema.String,
      held: Schema.Boolean,
      id: Schema.String,
    })
  ),
  deployment: Schema.String,
  problems: Schema.Array(Schema.String),
  profile: Schema.String,
});

const bodyOf = (response: Response) =>
  Effect.flatMap(
    Effect.promise(() => response.text()),
    Schema.decodeUnknownEffect(Schema.fromJsonString(Body))
  );

const databaseAt = (url: Redacted.Redacted) =>
  DatabaseLive({ url }).pipe(Layer.orDie);

/** A probe that fails the test when it is used: production must never reach the store. */
const untouchable = PlatformProbe.of({
  report: Effect.die("a production deployment reached the store"),
});

const holding: PlatformReport = {
  checks: Arr.map(requiredChecks, ({ id }) => ({
    detail: "as asked",
    held: true,
    id,
  })),
  profile: "test",
};

const answerFor = (report: PlatformReport) =>
  platformResponse(success(Option.some({ deployment: "preview", report })));

layer(migratedTestDatabase, { excludeTestServices: true })(
  "GET /api/platform (spec 0025 R5)",
  (it) => {
    it.effect(
      "F1: a preview and a local deployment report every required check, held, and the route answers 200",
      () =>
        Effect.gen(function* reportsEveryCheck() {
          const database = databaseAt(yield* TestDatabaseUrl);

          for (const deployment of ["preview", "local"]) {
            const report = yield* platformReport(deployment).pipe(
              Effect.provide(database)
            );

            const response = platformResponse(success(report));
            const body = yield* bodyOf(response);

            assert.strictEqual(response.status, 200);
            assert.deepStrictEqual(body.problems, []);
            assert.strictEqual(body.deployment, deployment);
            assert.strictEqual(body.profile, "hyperdrive");

            for (const { id } of requiredChecks) {
              assert.isTrue(
                Arr.some(body.checks, (check) => check.id === id && check.held),
                id
              );
            }
          }
        }),
      { timeout: 60_000 }
    );

    it.effect(
      "F1: a production deployment answers an empty 404 and never asks the store",
      () =>
        Effect.gen(function* answersNothing() {
          const database = databaseAt(yield* TestDatabaseUrl);

          const report = yield* platformReport("production").pipe(
            Effect.provideService(PlatformProbe, untouchable),
            Effect.provide(database)
          );

          assert.deepStrictEqual(report, Option.none());

          const response = platformResponse(success(report));
          assert.strictEqual(response.status, 404);
          assert.strictEqual(yield* Effect.promise(() => response.text()), "");
        })
    );

    it.effect(
      "F1: the failure of the request answers with its own status",
      () =>
        Effect.sync(() => {
          const refused = platformResponse(
            failureOf(new Forbidden({ command: "createDepartment" }))
          );

          assert.strictEqual(refused.status, 403);
        })
    );
  }
);

layer(migratedTestDatabase, { excludeTestServices: true })(
  "the route cannot answer 200 by leaving a check out (spec 0025 F1, F2)",
  (it) => {
    it.effect(
      "control: the complete report answers 200; one check that did not hold, one that is missing and an empty report each answer 500 and name it",
      () =>
        Effect.gen(function* answers500() {
          const [first] = requiredChecks;
          const id = first?.id ?? "";

          assert.strictEqual(answerFor(holding).status, 200);

          const didNotHold = answerFor({
            ...holding,
            checks: Arr.map(holding.checks, (check) =>
              check.id === id
                ? {
                    ...check,
                    detail: "the second transaction took the lock",
                    held: false,
                  }
                : check
            ),
          });

          assert.strictEqual(didNotHold.status, 500);
          const failed = yield* bodyOf(didNotHold);
          assert.lengthOf(failed.problems, 1);
          assert.include(
            failed.problems[0] ?? "",
            "the second transaction took the lock"
          );

          const missing = answerFor({
            ...holding,
            checks: Arr.filter(holding.checks, (check) => check.id !== id),
          });

          assert.strictEqual(missing.status, 500);
          const absent = yield* bodyOf(missing);
          assert.lengthOf(absent.problems, 1);
          assert.include(absent.problems[0] ?? "", id);

          const empty = answerFor({ checks: [], profile: "test" });
          assert.strictEqual(empty.status, 500);
          assert.lengthOf(
            (yield* bodyOf(empty)).problems,
            requiredChecks.length
          );
        })
    );
  }
);
