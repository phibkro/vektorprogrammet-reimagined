/**
 * Per-run databases for the round trip, created on the devenv services and
 * dropped afterwards (also when a test fails):
 *
 * - `LegacyTestDatabase`: a MySQL database created with `mysql -uroot` over the
 *   socket `$MYSQL_UNIX_PORT`, loaded with the Phase 1 table definitions taken
 *   verbatim from `../fixtures/legacy-phase1-schema.sql` (vendored from the production structure dump) and the FAKE rows
 *   of `fixture.ts`. `legacy_reader` is granted SELECT on it, so the importer
 *   reads through the same SELECT-only user as against the restored backup.
 *
 * The PostgreSQL side of the round trip is `TestDatabaseUrl` from `@vektorprogrammet/db/testing`: a
 * migrated disposable database, the one definition `packages/db`'s tests and the browser tests use too.
 * Neither database ever touches `legacy` or `vektorprogrammet`.
 */
import {
  Array as Arr,
  Config,
  Context,
  Effect,
  FileSystem,
  Layer,
  Path,
  Redacted,
  Stream,
} from "effect";
import { SecureRandom } from "effect/crypto";
import { encode as hexEncode } from "effect/encoding/Hex";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { FIXTURE_SQL, PHASE_1_LEGACY_TABLES } from "./fixture.ts";

/** The Phase 1 table definitions, vendored verbatim from the 2024-08-22 structure-only dump (provenance in its header). */
const PROD_SCHEMA = new URL(
  "../fixtures/legacy-phase1-schema.sql",
  import.meta.url
);

const uniqueName = Effect.gen(function* uniqueName() {
  const random = yield* SecureRandom.SecureRandom;

  return `import_test_${hexEncode(yield* random.randomBytes(6))}`;
});

const withDatabase = (url: string, name: string): Redacted.Redacted => {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;

  return Redacted.make(parsed.toString());
};

/** Runs a SQL script through `mysql -uroot` over the socket; a non-zero exit is a defect. */
const mysqlRoot = Effect.fn("mysqlRoot")(function* mysqlRoot(script: string) {
  const socket = yield* Config.String("MYSQL_UNIX_PORT");
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const command = ChildProcess.make(
    "mysql",
    [
      "-uroot",
      `--socket=${socket}`,
      "--default-character-set=utf8mb4",
      "--batch",
    ],
    { stdin: { stream: Stream.succeed(new TextEncoder().encode(script)) } }
  );

  const { exitCode, stderr } = yield* Effect.scoped(
    Effect.gen(function* runSubprocess() {
      const handle = yield* spawner.spawn(command);

      return yield* Effect.all(
        {
          exitCode: handle.exitCode,
          stderr: handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
          stdout: Stream.runDrain(handle.stdout),
        },
        { concurrency: "unbounded" }
      );
    })
  );

  return yield* Effect.when(
    Effect.die(`mysql -uroot exited with ${exitCode}: ${stderr}`),
    Effect.succeed(exitCode !== ChildProcessSpawner.ExitCode(0))
  ).pipe(Effect.asVoid);
});

/** The `CREATE TABLE` statements of the Phase 1 legacy tables, verbatim from the dump. */
const legacyTableDefinitions = (
  dump: string
): Effect.Effect<readonly string[]> =>
  Effect.forEach(PHASE_1_LEGACY_TABLES, (table) => {
    const start = dump.indexOf(`CREATE TABLE \`${table}\` (`);
    const end = start === -1 ? -1 : dump.indexOf(";", start);

    return end < 0
      ? Effect.die(`legacy-phase1-schema.sql has no definition of ${table}`)
      : Effect.succeed(dump.slice(start, end + 1));
  });

export class LegacyTestDatabase extends Context.Service<
  LegacyTestDatabase,
  { readonly name: string; readonly url: Redacted.Redacted }
>()("@vektorprogrammet/import/test/LegacyTestDatabase") {
  static readonly layer = Layer.effect(
    LegacyTestDatabase,
    Effect.gen(function* buildLegacyDatabase() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const readerUrl = yield* Config.Redacted("LEGACY_MYSQL_URL");
      const name = yield* uniqueName;

      const dump = yield* fs.readFileString(
        yield* path.fromFileUrl(PROD_SCHEMA)
      );

      const definitions = yield* legacyTableDefinitions(dump);
      const database = `\`${name}\``;
      yield* Effect.acquireRelease(
        mysqlRoot(
          Arr.join(
            [
              `CREATE DATABASE ${database} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
              `USE ${database};`,
              // The dump's foreign keys name tables outside Phase 1 (user, role, infomeeting);
              // with checks off MySQL accepts them, and the orphan rows below stay loadable.
              "SET FOREIGN_KEY_CHECKS = 0;",
              ...definitions,
              FIXTURE_SQL,
              `GRANT SELECT ON ${database}.* TO 'legacy_reader'@'localhost';`,
            ],
            "\n\n"
          )
        ),
        () =>
          mysqlRoot(
            Arr.join(
              [
                `DROP DATABASE IF EXISTS ${database};`,
                `REVOKE IF EXISTS SELECT ON ${database}.* FROM 'legacy_reader'@'localhost' IGNORE UNKNOWN USER;`,
              ],
              "\n"
            )
          ).pipe(Effect.orDie)
      );

      return { name, url: withDatabase(Redacted.value(readerUrl), name) };
    }).pipe(Effect.orDie)
  );
}
