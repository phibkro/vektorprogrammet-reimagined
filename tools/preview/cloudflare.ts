import * as Cloudflare from "@alchemy.run/cloudflare";
import {
  Array as Arr,
  Effect,
  FileSystem,
  Path,
  Redacted,
  Schema,
} from "effect";

import { TURNSTILE_TEST_KEYS } from "../../apps/web/worker.config.ts";
import type { PreviewIdentity } from "./config.ts";
import type { PreviewReceipt } from "./contracts.ts";

export const STACK_NAME = "vektorprogrammet-preview";
export const WORKER_ID = "Worker";
export const PREVIEW_STATE_WORKER = "vektor-preview-state";

export const isOwnedWorkerSet = (
  rows: readonly string[],
  hasReplacements: boolean
): boolean => !hasReplacements && Arr.every(rows, (row) => row === WORKER_ID);

export const stageFor = (receipt: PreviewIdentity): string =>
  `pr-${receipt.pullRequest}`;

export const GeneratedConfig = Schema.Struct({
  assets: Schema.Struct({ directory: Schema.String }),
  compatibility_date: Schema.String,
  compatibility_flags: Schema.Array(Schema.String),
  main: Schema.String,
  ratelimits: Schema.Array(
    Schema.Struct({
      name: Schema.Literal("CONTACT_RATE_LIMIT"),
      namespace_id: Schema.String,
      simple: Schema.Struct({
        limit: Schema.Int,
        period: Schema.Literals([10, 60]),
      }),
    })
  ),
  triggers: Schema.Struct({ crons: Schema.Array(Schema.String) }),
});

export const validateStage = (
  receipt: PreviewIdentity,
  stage: string
): void => {
  if (
    !Number.isSafeInteger(receipt.pullRequest) ||
    receipt.pullRequest < 1 ||
    stage !== stageFor(receipt) ||
    receipt.workerName !== `vektorprogrammet-pr-${receipt.pullRequest}` ||
    receipt.branchName !== receipt.workerName
  ) {
    throw new Error("Preview stage and receipt identity do not match");
  }
};

/** Read the Cloudflare Vite plugin's actual output rather than rebuilding it. */
export const workerProperties = Effect.fn("preview.workerProperties")(
  function* workerProperties(receipt: PreviewReceipt) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const server = path.resolve("apps/web/dist/server");
    const dist = path.resolve("apps/web/dist");
    const json = yield* fs.readFileString(path.join(server, "wrangler.json"));

    const generated = yield* Schema.decodeEffect(
      Schema.fromJsonString(GeneratedConfig)
    )(json);

    const main = path.resolve(server, generated.main);
    const assets = path.resolve(server, generated.assets.directory);

    if (
      !main.startsWith(`${server}/`) ||
      !assets.startsWith(`${dist}/`) ||
      generated.ratelimits.length !== 1
    ) {
      return yield* Effect.die(
        new Error("Unexpected generated Worker artifact configuration")
      );
    }

    const [rate] = generated.ratelimits;

    if (rate === undefined) {
      return yield* Effect.die(new Error("Missing contact rate limit"));
    }

    return {
      assets,
      bundle: false as const,
      compatibility: {
        date: generated.compatibility_date,
        flags: [...generated.compatibility_flags],
      },
      crons: [...generated.triggers.crons],
      env: {
        CONTACT_RATE_LIMIT: Cloudflare.RateLimit("CONTACT_RATE_LIMIT", {
          namespaceId: rate.namespace_id,
          simple: rate.simple,
        }),
        DATABASE_URL: receipt.runtimeDatabaseUrl,
        DEPLOYMENT: "preview",
        PREVIEW_HEAD_SHA: receipt.headSha,
        SITE_URL: receipt.siteUrl,
        SUPABASE_PUBLISHABLE_KEY: receipt.publishableKey,
        SUPABASE_SECRET_KEY: receipt.secretKey,
        SUPABASE_URL: receipt.supabaseUrl,
        TURNSTILE_SECRET_KEY: Redacted.make(TURNSTILE_TEST_KEYS.secretKey),
        TURNSTILE_SITE_KEY: TURNSTILE_TEST_KEYS.siteKey,
      },
      main,
      name: receipt.workerName,
      tags: [
        `commit:${receipt.headSha}`,
        `pull-request:${receipt.pullRequest}`,
      ],
      workersDev: true,
    };
  }
);
