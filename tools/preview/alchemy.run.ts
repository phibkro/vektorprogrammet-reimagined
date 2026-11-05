import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import { Effect } from "effect";

import {
  PREVIEW_STATE_WORKER,
  STACK_NAME,
  WORKER_ID,
  validateStage,
  workerProperties,
} from "./cloudflare.ts";
import { readReceipt } from "./contracts.ts";
import { preflight } from "./supabase.ts";

const preview = Effect.gen(function* preview() {
  const receipt = yield* readReceipt();
  const stage = yield* Alchemy.Stage;
  yield* Effect.sync(() => {
    validateStage(receipt, stage);
  });
  // Recheck ownership and the configured capture SMTP immediately before deployment.
  yield* preflight(receipt);
  const properties = yield* workerProperties(receipt);
  const worker = yield* Cloudflare.Worker(WORKER_ID, properties);

  return { headSha: receipt.headSha, url: worker.url };
}).pipe(Effect.orDie);

export default Alchemy.Stack(
  STACK_NAME,
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state({ workerName: PREVIEW_STATE_WORKER }),
  },
  preview
);
