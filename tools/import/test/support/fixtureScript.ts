/**
 * The shell of the two fixture scripts (`importFixture.ts`, `importFixtureCms.ts`): `LegacyTestDatabase` loads the
 * FAKE legacy fixture into a throwaway MySQL database for the length of the program and drops it afterwards, so
 * nothing of the backup is involved and `legacy` is never touched. The program gets that database's URL and a
 * scratch directory for the importer's report.
 */
import { NodeRuntime } from "@effect/platform-node";
import { Effect, FileSystem, Layer } from "effect";
import type { Redacted, Scope } from "effect";

import { nodeServicesLayer } from "../../src/nodeServices.ts";
import { LegacyTestDatabase } from "./databases.ts";

const FixtureServices = LegacyTestDatabase.layer.pipe(
  Layer.provideMerge(nodeServicesLayer)
);

interface Fixture {
  readonly legacyMysqlUrl: Redacted.Redacted;
  readonly reportDirectory: string;
}

export const runOnFixture = <E>(
  program: (
    fixture: Fixture
  ) => Effect.Effect<
    void,
    E,
    Layer.Success<typeof FixtureServices> | Scope.Scope
  >
) => {
  NodeRuntime.runMain(
    Effect.gen(function* withFixture() {
      const fs = yield* FileSystem.FileSystem;
      const legacy = yield* LegacyTestDatabase;
      const reportDirectory = yield* fs.makeTempDirectoryScoped();

      return yield* program({ legacyMysqlUrl: legacy.url, reportDirectory });
    }).pipe(Effect.scoped, Effect.provide(FixtureServices))
  );
};
