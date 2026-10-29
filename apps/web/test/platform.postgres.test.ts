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
import {
  TestDatabaseUrl,
  migratedTestDatabase,
} from "@vektorprogrammet/db/testing";
import { PlatformProbe, requiredChecks } from "@vektorprogrammet/domain";
import type { PlatformReport } from "@vektorprogrammet/domain";
import { Array as Arr, Effect, Option, Redacted, Schema } from "effect";

import { success } from "../src/lib/outcome";
import {
  platformReport,
  platformResponse,
  runPlatformRoute,
} from "../src/server/platform";
import type { RequestScope } from "../src/server/runtime";
import {
  assertEmpty404,
  assertFailureStatus,
  bodyOf,
  databaseAt,
} from "./support/diagnosticRoute";
import { workerEnv } from "./support/workerEnv";

const scopeOf = (env: RequestScope["env"]): RequestScope => ({
  ctx: { waitUntil: () => {} },
  env,
  headers: new Headers(),
  signal: new AbortController().signal,
  testActor: undefined,
});

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

const readBody = (response: Response) => bodyOf(Body, response);

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
            const body = yield* readBody(response);

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

          yield* assertEmpty404(platformResponse(success(report)));
        })
    );

    it.effect(
      "F1: what the route runs: production answers an empty 404, a preview answers 200",
      () =>
        Effect.gen(function* theRoute() {
          const url = yield* TestDatabaseUrl;

          // A report is a 200 or a 500 with a body, so an empty 404 is an answer that ran no probe. (The request still
          // resolves its principal, which reads the session: that is the database, and it is not the probe.)
          const production = yield* Effect.promise(() =>
            runPlatformRoute(
              scopeOf({
                ...workerEnv(Redacted.value(url)),
                DEPLOYMENT: "production",
              })
            )
          );

          yield* assertEmpty404(production);

          const preview = yield* Effect.promise(() =>
            runPlatformRoute(
              scopeOf({
                ...workerEnv(Redacted.value(url)),
                DEPLOYMENT: "preview",
              })
            )
          );

          assert.strictEqual(preview.status, 200);
          assert.deepStrictEqual((yield* readBody(preview)).problems, []);
        }),
      { timeout: 60_000 }
    );

    it.effect(
      "F1: the failure of the request answers with its own status",
      () => assertFailureStatus(platformResponse)
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
          const failed = yield* readBody(didNotHold);
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
          const absent = yield* readBody(missing);
          assert.lengthOf(absent.problems, 1);
          assert.include(absent.problems[0] ?? "", id);

          const empty = answerFor({ checks: [], profile: "test" });
          assert.strictEqual(empty.status, 500);
          assert.lengthOf(
            (yield* readBody(empty)).problems,
            requiredChecks.length
          );
        })
    );
  }
);
