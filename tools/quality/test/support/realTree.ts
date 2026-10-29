import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";

import { scanImports } from "../../moduleGraphCheck.ts";

const root = new URL("../../../../", import.meta.url).pathname;

/** The source files of the real tree, as the module graph check reads them (resolved imports and text). */
export const realTree = scanImports(root).pipe(
  Effect.provide(NodeServices.layer)
);
