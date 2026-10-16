/**
 * The disposable PostgreSQL database the browser tests run against, and the data in it. `packages/db`'s
 * shared `migratedTestDatabase` creates and migrates it (and drops it when the scope closes); the real
 * importer then fills it from its fake legacy fixture (`tools/import`, script `import:fixture`). So the
 * browser tests run on migrated data. The spec processes read it back through `probes.ts`.
 */
import {
  TestDatabaseUrl,
  migratedTestDatabase,
} from "@vektorprogrammet/db/testing";
import { Context, Effect, Layer, Redacted } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const importerDirectory = new URL("../../../../tools/import/", import.meta.url)
  .pathname;

/** Runs the importer's `import:fixture` script into `url`: the fake legacy rows, through the real pipeline. */
const importFixture = (url: Redacted.Redacted) =>
  Effect.gen(function* importFixtureInto() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const importer = yield* spawner.spawn(
      ChildProcess.make("bun", ["run", "import:fixture"], {
        cwd: importerDirectory,
        env: { IMPORT_TARGET_DATABASE_URL: Redacted.value(url) },
        extendEnv: true,
        stderr: "inherit",
        stdin: "ignore",
        stdout: "inherit",
      })
    );

    const exitCode = yield* importer.exitCode;

    return yield* Effect.when(
      Effect.die(`the fixture import exited with code ${exitCode}`),
      Effect.succeed(exitCode !== ChildProcessSpawner.ExitCode(0))
    ).pipe(Effect.asVoid);
  }).pipe(Effect.scoped);

/**
 * A migrated disposable database holding the imported fixture; returns its URL. The Layer is built in the
 * caller's scope (`Layer.build`, not `Effect.provide`), so the database lives until that scope closes.
 */
export const disposableDatabase = Effect.gen(function* disposableDatabase() {
  const database = yield* Layer.build(migratedTestDatabase);
  const url = Context.get(database, TestDatabaseUrl);
  yield* importFixture(url);

  return url;
});
