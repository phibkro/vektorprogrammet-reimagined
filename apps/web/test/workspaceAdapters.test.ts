/**
 * The Workspace adapters' gates (spec 0008, falsifiers 5 and 10), without a database.
 *
 * Falsifier 5: a write reaches the directory only when `WORKSPACE_MODE` says exactly `write` and the deployment is not
 * production; in every other combination the writer refuses. The negative control is the one combination that does
 * not refuse (`write` outside production), so the refusals cannot be a writer that fails on everything.
 *
 * Falsifier 10 (the part that does not need the operator): production has no directory until the Google adapter and
 * its credentials exist, and says so with a typed error; it neither guesses an empty directory nor calls Google.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  CompanyEmail,
  WorkspaceChange,
  WorkspaceDirectory,
  WorkspaceModeSetting,
  WorkspaceNotConfigured,
  WorkspaceWriteRefused,
  WorkspaceWriter,
} from "@vektorprogrammet/domain";
import {
  Array as Arr,
  Effect,
  Layer,
  Logger,
  Predicate,
  String as Str,
} from "effect";

import type { Deployment } from "../src/server/deployment";
import {
  workspaceConfigFromEnv,
  workspaceDirectoryLayer,
  workspaceModeLayer,
  workspaceWriterLayer,
} from "../src/server/workspace";

const DEPLOYMENTS: readonly Deployment[] = ["local", "preview", "production"];

const address = CompanyEmail.make("kari.nordmann@vektorprogrammet.no");
const group = CompanyEmail.make("team1@vektorprogrammet.no");

const CHANGES: readonly WorkspaceChange[] = [
  WorkspaceChange.cases.EnsureAccount.make({ address, name: "Kari Nordmann" }),
  WorkspaceChange.cases.EnsureGroup.make({ address: group, name: "Team 1" }),
  WorkspaceChange.cases.EnsureMember.make({ group, member: address }),
  WorkspaceChange.cases.EnsureAbsent.make({ group, member: address }),
];

const apply = (change: WorkspaceChange) =>
  Effect.gen(function* applyChange() {
    return yield* (yield* WorkspaceWriter).apply(change);
  });

describe("spec 0008 falsifier 5: the Workspace write gate", () => {
  it("WORKSPACE_MODE is write only when it says exactly write", () => {
    assert.deepStrictEqual(
      Arr.map(
        [undefined, "", "WRITE", "writes", "dry-run", "write"],
        (setting) =>
          workspaceConfigFromEnv("local", { WORKSPACE_MODE: setting }).mode
      ),
      ["dry-run", "dry-run", "dry-run", "dry-run", "dry-run", "write"]
    );
  });

  it.effect(
    "in dry-run every change is refused in every deployment, and the mode setting says dry-run",
    () =>
      Effect.gen(function* dryRunRefuses() {
        for (const deployment of DEPLOYMENTS) {
          const config = workspaceConfigFromEnv(deployment, {});

          assert.strictEqual(
            yield* WorkspaceModeSetting.pipe(
              Effect.provide(workspaceModeLayer(config))
            ),
            "dry-run"
          );

          for (const change of CHANGES) {
            const exit = yield* apply(change).pipe(
              Effect.provide(workspaceWriterLayer(config)),
              Effect.flip
            );

            assert.isTrue(
              Predicate.isTagged(exit, "WorkspaceWriteRefused"),
              `${deployment}: ${change._tag} is refused`
            );
          }
        }
      })
  );

  it.effect(
    "write in production refuses too: the operator's switch cannot reach Google before the adapter exists",
    () =>
      Effect.gen(function* writeInProduction() {
        const config = workspaceConfigFromEnv("production", {
          WORKSPACE_MODE: "write",
        });

        assert.strictEqual(config.mode, "write");

        for (const change of CHANGES) {
          const refused = yield* apply(change).pipe(
            Effect.provide(workspaceWriterLayer(config)),
            Effect.flip
          );

          assert.instanceOf(refused, WorkspaceWriteRefused);
          assert.include(refused.reason, "adapter");
        }
      })
  );

  it.effect(
    "negative control: write outside production is the one combination that does not refuse, and it logs the kind and no address",
    () =>
      Effect.gen(function* captured() {
        const seen: string[] = [];

        const logs = Logger.layer([
          Logger.make((options) => {
            seen.push(Logger.formatLogFmt.log(options));
          }),
        ]);

        for (const deployment of ["local", "preview"] as const) {
          const config = workspaceConfigFromEnv(deployment, {
            WORKSPACE_MODE: "write",
          });

          for (const change of CHANGES) {
            yield* apply(change).pipe(
              Effect.provide(Layer.mergeAll(workspaceWriterLayer(config), logs))
            );
          }
        }

        assert.strictEqual(
          seen.length,
          2 * CHANGES.length,
          "each change was captured once"
        );
        assert.isTrue(
          Arr.every(seen, (line) => Str.includes("kind=Ensure")(line)),
          "the log names the kind of the change"
        );
        assert.isFalse(
          Arr.some(seen, (line) => Str.includes("vektorprogrammet.no")(line)),
          "and no address: an address is personal data"
        );
      })
  );
});

describe("spec 0008 falsifier 10: the directory that production has before the operator provisions Google", () => {
  it.effect(
    "production's directory fails every read with WorkspaceNotConfigured",
    () =>
      Effect.gen(function* unconfigured() {
        const directory = yield* WorkspaceDirectory.pipe(
          Effect.provide(
            workspaceDirectoryLayer(workspaceConfigFromEnv("production", {}))
          )
        );

        const failures = yield* Effect.forEach(
          [directory.accounts, directory.groups, directory.members(group)],
          (read) => Effect.flip(read)
        );

        assert.deepStrictEqual(
          Arr.map(failures, (failure) => failure._tag),
          [
            "WorkspaceNotConfigured",
            "WorkspaceNotConfigured",
            "WorkspaceNotConfigured",
          ]
        );
        assert.instanceOf(failures[0], WorkspaceNotConfigured);
      })
  );

  it.effect(
    "negative control: local and Preview have an empty directory, which succeeds",
    () =>
      Effect.gen(function* empty() {
        for (const deployment of ["local", "preview"] as const) {
          const directory = yield* WorkspaceDirectory.pipe(
            Effect.provide(
              workspaceDirectoryLayer(workspaceConfigFromEnv(deployment, {}))
            )
          );

          assert.deepStrictEqual(yield* directory.accounts, []);
          assert.deepStrictEqual(yield* directory.groups, []);
          assert.strictEqual(yield* directory.members(group), "missing");
        }
      })
  );
});
