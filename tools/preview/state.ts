import * as Cloudflare from "@alchemy.run/cloudflare";
import * as workers from "@distilled.cloud/cloudflare/workers";
import { buildWithoutProgram } from "alchemy/Alchemist/Operations";
import { State } from "alchemy/State/State";
import { Config, Effect, Layer } from "effect";

import stack from "./alchemy.run.ts";
import { stageFor } from "./cloudflare.ts";
import { PreviewError, readIdentity } from "./config.ts";
import { requirePreviewCI } from "./runtime.ts";

/** Initialize only the configured store, never the application program or plan. */
export const admitPreviewState = Effect.fnUntraced(
  function* admitPreviewState() {
    yield* requirePreviewCI("state admission");

    const identity = yield* readIdentity();
    const expectedAccount = yield* Config.String("CLOUDFLARE_ACCOUNT_ID");

    const built = yield* buildWithoutProgram(stack, {
      stage: stageFor(identity),
      updateStateStore: false,
    });

    return yield* Effect.gen(function* initializeState() {
      const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;

      if (!expectedAccount || accountId !== expectedAccount) {
        return yield* new PreviewError({
          message: "Preview state account does not match configuration",
        });
      }

      const { subdomain } = yield* workers.getSubdomain({ accountId });

      if (
        identity.siteUrl !==
        `https://${identity.workerName}.${subdomain}.workers.dev`
      ) {
        return yield* new PreviewError({
          message: "Preview hostname does not match the Cloudflare account",
        });
      }

      const store = yield* yield* State;
      yield* store.getVersion();

      return yield* Effect.void;
    }).pipe(
      Effect.provide(
        Cloudflare.CloudflareApiLive().pipe(
          Layer.provideMerge(Layer.succeedContext(built.context))
        )
      )
    );
  },
  Effect.scoped
);
