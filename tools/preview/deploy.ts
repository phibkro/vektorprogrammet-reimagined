import * as Alchemist from "alchemy/Alchemist";
import { Array as Arr, Effect } from "effect";

import stack from "./alchemy.run.ts";
import {
  STACK_NAME,
  WORKER_ID,
  stageFor,
  validateStage,
} from "./cloudflare.ts";
import { PreviewError, readIdentity } from "./config.ts";
import { readReceipt } from "./contracts.ts";
import {
  inspectPreviewState,
  inspectWorkerRow,
  listPreviewState,
  requirePreviewCI,
  runPreview,
} from "./runtime.ts";
import { admitPreviewState } from "./state.ts";
import { preflight } from "./supabase.ts";

const program = Effect.gen(function* deployPreview() {
  yield* requirePreviewCI("deployment");

  const identity = yield* readIdentity();
  const receipt = yield* readReceipt();
  const stage = stageFor(identity);
  yield* Effect.sync(() => {
    validateStage(receipt, stage);
  });
  yield* preflight(receipt);
  yield* admitPreviewState();

  const plan = yield* Alchemist.plan({
    operation: "deploy",
    stack,
    stage,
    updateStateStore: false,
  });

  if (
    plan.stack.name !== STACK_NAME ||
    plan.stack.stage !== stage ||
    plan.actions.length !== 0 ||
    Arr.some(
      plan.resources,
      (resource) =>
        resource.fqn !== WORKER_ID ||
        resource.logicalId !== WORKER_ID ||
        resource.action === "replace" ||
        resource.resourceType !== "Cloudflare.Worker"
    )
  ) {
    return yield* new PreviewError({
      message: "Refusing unexpected preview plan",
    });
  }

  yield* Effect.gen(function* checkOwnedState() {
    const state = yield* listPreviewState(stage);

    if (!state.owned) {
      return yield* new PreviewError({
        message: "Refusing unexpected preview state",
      });
    }

    // Alchemy resumes interrupted creates using its ownership-aware read.
    yield* inspectPreviewState(state, identity.workerName, true);
    const node = plan.native.resources[WORKER_ID];

    if (node?.state !== undefined) {
      yield* inspectWorkerRow(identity.workerName, true)(node.state);
    }

    return yield* Effect.void;
  }).pipe(Effect.provide(plan.context));

  // Applying this one plan is the CI approval; it does not authorize store updates.
  return yield* Alchemist.apply(plan);
});

if (import.meta.main) {
  runPreview(program, {
    message:
      "Preview deployment failed; check preview identity, preflight, and the separately provisioned state store",
    summary: "Preview deployment failed",
  });
}
