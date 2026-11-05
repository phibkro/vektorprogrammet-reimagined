import * as Cloudflare from "@alchemy.run/cloudflare";
import * as workers from "@distilled.cloud/cloudflare/workers";
import { buildWithoutProgram } from "alchemy/Alchemist/Operations";
import { applyAndRender } from "alchemy/Deploy";
import * as Plan from "alchemy/Plan";
import { Effect, Layer, Option, Stream } from "effect";

import stack from "./alchemy.run.ts";
import { stageFor, validateStage } from "./cloudflare.ts";
import { readIdentity } from "./config.ts";
import { assertTeardownAuthority } from "./lifecycleGuard.ts";
import {
  inspectPreviewState,
  listPreviewState,
  requirePreviewCI,
  runPreview,
} from "./runtime.ts";
import { admitPreviewState } from "./state.ts";
import { deleteBranch } from "./supabase.ts";

const program = Effect.gen(function* program() {
  yield* requirePreviewCI("teardown");

  const identity = yield* readIdentity();
  yield* assertTeardownAuthority(identity);
  const stage = stageFor(identity);
  yield* Effect.sync(() => {
    validateStage(identity, stage);
  });
  yield* admitPreviewState();

  const built = yield* buildWithoutProgram(stack, {
    stage,
    updateStateStore: false,
  });

  yield* Effect.gen(function* destroyOwnedWorker() {
    const state = yield* listPreviewState(stage);

    if (!state.owned) {
      return yield* Effect.die(
        new Error("Refusing teardown: unexpected preview state resources")
      );
    }

    if (state.rows.length === 0) {
      const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;

      const script = yield* workers.listScripts.items({ accountId }).pipe(
        Stream.filter((candidate) => candidate.id === identity.workerName),
        Stream.runHead
      );

      const exists = Option.isSome(script);

      if (exists) {
        return yield* Effect.die(
          new Error("Refusing teardown: Worker exists without owned state")
        );
      }
    }

    // An attribute-less create needs reconciliation: provider recovery can
    // discover live routes or domains not authorized by the persisted row.
    yield* inspectPreviewState(state, identity.workerName, false);

    yield* assertTeardownAuthority(identity);

    return yield* Plan.destroy(built.stack).pipe(
      Effect.flatMap(applyAndRender)
    );
  }).pipe(
    Effect.provide(
      Cloudflare.CloudflareApiLive().pipe(
        Layer.provideMerge(Layer.succeedContext(built.context))
      )
    )
  );
  yield* assertTeardownAuthority(identity);

  return yield* deleteBranch(identity);
});

if (import.meta.main) {
  runPreview(program);
}
