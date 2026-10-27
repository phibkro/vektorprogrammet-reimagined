import { Context, Layer } from "effect";

import type { Runtime } from "../support/runtime.ts";
import { base } from "./base.ts";
import { start } from "./steps.ts";

/** The runtime that (a), (c) and (d) share: one `alchemy dev`, one Worker, several instances. */
export class SharedRuntime extends Context.Service<SharedRuntime, Runtime>()(
  "test/SharedRuntime"
) {}

export const sharedRuntime = Layer.effect(SharedRuntime, start("shared")).pipe(
  Layer.provideMerge(base)
);
