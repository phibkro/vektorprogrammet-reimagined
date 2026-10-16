/**
 * CLI composition root: `bun src/cms.ts --report-dir <dir>`.
 *
 * Reads the legacy articles, static texts and sponsors from the restored backup and creates what the CMS lacks
 * (spec 0005, D5). Settings come from the environment (`emdash/config.ts`). It never overwrites an entry that
 * exists, so it is safe to run again. The operator runbook is `README.md`.
 */
import { NodeRuntime } from "@effect/platform-node";
import { Console, Effect } from "effect";
import { Command, Flag } from "effect/cli";

import { CmsImportConfig } from "./emdash/config.ts";
import { cmsImportLayer, runCmsImport } from "./emdash/pipeline.ts";
import { nodeServicesLayer } from "./nodeServices.ts";

const command = Command.make(
  "vektorprogrammet-import-cms",
  {
    reportDir: Flag.Directory("report-dir").pipe(
      Flag.withDescription(
        "Directory for emdash-reconciliation.json and emdash-reconciliation.md (created if missing)"
      )
    ),
  },
  Effect.fn(function* command({ reportDir }) {
    const { legacyMysqlUrl, target } = yield* CmsImportConfig;

    const { report, written } = yield* runCmsImport(reportDir).pipe(
      Effect.provide(cmsImportLayer({ legacyMysqlUrl, ...target }))
    );

    for (const c of report.collections) {
      yield* Console.log(
        `${c.collection}: ${c.rowsIn} in, ${c.quarantined} quarantined, ${c.drafted + c.published} created, ${c.unchanged} already there; in the CMS: ${c.inCms.published} published, ${c.inCms.draft} drafts`
      );
    }

    return yield* Console.log(`report: ${written.json}, ${written.markdown}`);
  })
).pipe(
  Command.withDescription(
    "Create the legacy articles, texts and sponsors in the CMS (EmDash)"
  )
);

NodeRuntime.runMain(
  command.pipe(
    Command.run({ version: "0.0.0" }),
    Effect.provide(nodeServicesLayer)
  )
);
