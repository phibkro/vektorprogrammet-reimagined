/**
 * CLI composition root: `bun src/main.ts --report-dir <dir> [--allow-dev-database]`.
 *
 * Reads the connection settings from the environment (`config.ts`), refuses to
 * truncate the development database unless told to, runs the import and writes
 * the reconciliation report. The operator runbook is `README.md`.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect, Option } from "effect";
import { Command, Flag } from "effect/cli";
import { ImportConfig, checkTarget } from "./config.ts";
import { importLayer, runImport } from "./pipeline.ts";

const command = Command.make(
  "vektorprogrammet-import",
  {
    reportDir: Flag.Directory("report-dir").pipe(
      Flag.withDescription(
        "Directory for reconciliation.json and reconciliation.md (created if missing)",
      ),
    ),
    allowDevDatabase: Flag.Boolean("allow-dev-database").pipe(
      Flag.withDescription("Allow IMPORT_TARGET_DATABASE_URL to be the development DATABASE_URL"),
      Flag.withDefault(false),
    ),
  },
  Effect.fn(function* ({ reportDir, allowDevDatabase }) {
    const config = yield* ImportConfig;
    const refused = checkTarget(config, allowDevDatabase);
    if (Option.isSome(refused)) return yield* refused.value;

    const { report, written } = yield* runImport(reportDir).pipe(
      Effect.provide(importLayer(config)),
    );
    for (const table of report.tables) {
      yield* Console.log(
        `${table.table}: ${table.rowsIn} in, ${table.rowsOut} out, ${table.quarantined} quarantined`,
      );
    }
    yield* Console.log(
      `collapsed semesters: ${report.collapsedSemesters.length}; missing files: ${report.missingFiles.distinctFiles}; broken references: ${report.brokenReferences.length}`,
    );
    yield* Console.log(`report: ${written.json}, ${written.markdown}`);
  }),
).pipe(Command.withDescription("Import the Phase 1 legacy tables into a PostgreSQL target"));

command.pipe(
  Command.run({ version: "0.0.0" }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
