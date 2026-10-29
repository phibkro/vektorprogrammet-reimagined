/**
 * Spec 0025, falsifiers 1, 3 and 6: the platform probe on a real PostgreSQL (the platform that a developer machine and the
 * test server have; the deployed run is the pull request's Preview job).
 *
 * - F1: with the settings of the `hyperdrive` profile the probe shows every check that the domain requires, and leaves
 *   nothing behind in the fake mailbox.
 * - F6: the settings are the profile's. A client that names its statements fails `statements-follow-the-profile` under the
 *   `hyperdrive` profile and holds it under the `direct` one; a client that sends none by name does the opposite.
 * - F3: the probe can fail. With a pool of one connection the second transaction of the lock checks cannot run, and the
 *   three lock checks say so while the other checks are still reported. (The mutations that break the probe's own
 *   mechanism are recorded in the spec's Revisions.)
 */
import { PgClient } from "@effect/sql-pg";
import { assert, layer } from "@effect/vitest";
import {
  PlatformProbe,
  platformProblems,
  requiredChecks,
} from "@vektorprogrammet/domain";
import { Array as Arr, Effect, Layer } from "effect";

import { DatabaseLive } from "../src/index.ts";
import { PlatformProbeLive } from "../src/platform/probe.ts";
import type { PlatformProbeOptions } from "../src/platform/probe.ts";
import { direct, hyperdrive } from "../src/platform/profiles.ts";
import {
  TestDatabaseUrl,
  migratedTestDatabase,
  withClient,
} from "./support/disposableDatabase.ts";

const LOCK_IDS = [
  "lock-excludes-second-holder",
  "lock-ends-with-its-transaction",
  "held-record-is-not-handed-on",
];

/** The probe of `profile` over a client with these settings, and what it reports. */
const reportOf = (
  profile: typeof direct | typeof hyperdrive,
  client: { readonly maxConnections: number; readonly prepare: boolean },
  options?: PlatformProbeOptions
) =>
  Effect.gen(function* report() {
    const url = yield* TestDatabaseUrl;

    return yield* PlatformProbe.use((probe) => probe.report).pipe(
      Effect.provide(
        PlatformProbeLive(profile, options).pipe(
          Layer.provide(
            PgClient.layer({
              maxConnections: client.maxConnections,
              prepare: client.prepare,
              url,
            })
          )
        )
      )
    );
  });

const failing = (report: {
  readonly checks: readonly { readonly id: string; readonly held: boolean }[];
}) =>
  Arr.map(
    Arr.filter(report.checks, ({ held }) => !held),
    ({ id }) => id
  );

layer(migratedTestDatabase, { excludeTestServices: true })(
  "spec 0025: the platform probe on PostgreSQL",
  (it) => {
    it.effect(
      "F1: with the hyperdrive profile's settings every required check holds, the report names the profile, and nothing is left behind",
      () =>
        Effect.gen(function* everyCheckHolds() {
          const report = yield* reportOf(hyperdrive, hyperdrive.client);

          assert.deepStrictEqual(platformProblems(report), []);
          assert.strictEqual(report.profile, "hyperdrive");

          for (const { id } of requiredChecks) {
            assert.include(
              Arr.map(report.checks, (check) => check.id),
              id
            );
          }

          for (const check of report.checks) {
            assert.isAbove(check.detail.length, 10, check.id);
          }

          const url = yield* TestDatabaseUrl;

          const left = yield* withClient(
            url,
            (client) =>
              client<{
                readonly n: number;
              }>`select count(*)::int as n from captured_mail where delivery_key like 'platform-probe-%'`
          );

          assert.strictEqual(left[0]?.n, 0);
        }),
      { timeout: 60_000 }
    );

    it.effect(
      "F6: a client that names its statements fails the hyperdrive profile's check and holds the direct profile's; a client that names none does the opposite",
      () =>
        Effect.gen(function* statementsFollowTheProfile() {
          const named = { maxConnections: 2, prepare: true };
          const unnamed = { maxConnections: 2, prepare: false };

          assert.deepStrictEqual(failing(yield* reportOf(hyperdrive, named)), [
            "statements-follow-the-profile",
          ]);

          assert.deepStrictEqual(failing(yield* reportOf(direct, named)), []);

          assert.deepStrictEqual(failing(yield* reportOf(direct, unnamed)), [
            "statements-follow-the-profile",
          ]);

          assert.deepStrictEqual(
            failing(yield* reportOf(hyperdrive, unnamed)),
            []
          );
        }),
      { timeout: 60_000 }
    );

    it.effect(
      "F6: `DatabaseLive`'s settings are the hyperdrive profile's (its probe holds on the layer that the apps build)",
      () =>
        Effect.gen(function* theAppsLayer() {
          const url = yield* TestDatabaseUrl;

          const report = yield* PlatformProbe.use((probe) => probe.report).pipe(
            Effect.provide(DatabaseLive({ url }).pipe(Layer.orDie))
          );

          assert.deepStrictEqual(platformProblems(report), []);
          assert.strictEqual(report.profile, "hyperdrive");

          // Decision D7: the Worker's client names no statement. The probe shows that the layer follows the profile; this
          // is the decision itself, so a profile that changed it fails here and not only by agreeing with the layer.
          assert.isFalse(hyperdrive.client.prepare);
          assert.isFalse(hyperdrive.client.multiplex);
        }),
      { timeout: 60_000 }
    );

    it.effect(
      "F3: with a pool of one connection the lock checks cannot run and say so, and the other checks are still reported",
      () =>
        Effect.gen(function* poolOfOne() {
          const report = yield* reportOf(
            hyperdrive,
            { maxConnections: 1, prepare: false },
            { checkTimeout: "2 seconds" }
          );

          assert.sameMembers(failing(report), LOCK_IDS);

          for (const check of report.checks) {
            if (LOCK_IDS.includes(check.id)) {
              assert.include(check.detail, "could not run");
            }
          }

          assert.strictEqual(platformProblems(report).length, LOCK_IDS.length);

          assert.isAtLeast(report.checks.length, requiredChecks.length);
        }),
      { timeout: 60_000 }
    );
  }
);
