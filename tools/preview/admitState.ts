import { Effect } from "effect";

import { readIdentity } from "./config.ts";
import { runPreview } from "./runtime.ts";
import { admitPreviewState } from "./state.ts";

const program = Effect.gen(function* admitState() {
  yield* readIdentity();
  yield* admitPreviewState();
});

runPreview(program, {
  message:
    "Preview state admission failed; check the dedicated store and its version",
  summary: "Preview state admission failed",
});
