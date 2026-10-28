import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Array as Arr, Effect, Schema } from "effect";

import { boundaryFindings, scanRepository } from "./storeBoundaryCheck.ts";

export class StoreBoundaryViolations extends Schema.TaggedError<
  StoreBoundaryViolations,
  { readonly brand: unique symbol }
>()("StoreBoundaryViolations", {
  message: Schema.String,
}) {}

const main = Effect.gen(function* checkStoreBoundary() {
  const { paths, sites } = yield* scanRepository(".");
  const findings = boundaryFindings(paths, sites);

  if (Arr.isReadonlyArrayNonEmpty(findings)) {
    const report = Arr.join(findings, "\n");

    yield* Effect.logError(report);

    return yield* new StoreBoundaryViolations({ message: report });
  }

  return yield* Effect.log(
    `Store boundary clean (${sites.length} restricted imports in ${paths.length} files, all covered).`
  );
});

NodeRuntime.runMain(main.pipe(Effect.provide(NodeServices.layer)), {
  disableErrorReporting: true,
});
