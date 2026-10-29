import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Array as Arr, Effect, Schema } from "effect";

import { declaration } from "./moduleGraph.ts";
import { moduleGraphFindings, scanImports } from "./moduleGraphCheck.ts";

export class ModuleGraphViolations extends Schema.TaggedError<
  ModuleGraphViolations,
  { readonly brand: unique symbol }
>()("ModuleGraphViolations", {
  message: Schema.String,
}) {}

const main = Effect.gen(function* checkModuleGraph() {
  const files = yield* scanImports(".");
  const findings = moduleGraphFindings(declaration, files);

  if (Arr.isReadonlyArrayNonEmpty(findings)) {
    const report = Arr.join(findings, "\n");

    yield* Effect.logError(report);

    return yield* new ModuleGraphViolations({ message: report });
  }

  return yield* Effect.log(
    `Module graph clean (${files.length} source files, ${declaration.modules.length} modules, ${declaration.baseline.length} tolerated imports).`
  );
});

NodeRuntime.runMain(main.pipe(Effect.provide(NodeServices.layer)), {
  disableErrorReporting: true,
});
