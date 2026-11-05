import { NodeCrypto, NodeRuntime, NodeServices } from "@effect/platform-node";
import {
  Config,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
} from "effect";
import { Mac } from "effect/crypto";
import { FetchHttpClient } from "effect/http";

import { PreviewError, readIdentity } from "./config.ts";
import { writeReceipt } from "./contracts.ts";
import type { PreviewReceipt } from "./contracts.ts";
import { runtimePassword } from "./prepareSupport.ts";
import {
  branchCredentials,
  configureServices,
  createOrReuseBranch,
  probeCapture,
  waitForBranch,
} from "./supabase.ts";

const program = Effect.gen(function* program() {
  const identity = yield* readIdentity();
  const seed = yield* Config.Redacted("PREVIEW_CREDENTIAL_SEED");

  if (new TextEncoder().encode(Redacted.value(seed)).length < 32) {
    return yield* new PreviewError({
      message: "PREVIEW_CREDENTIAL_SEED must contain at least 32 bytes",
    });
  }

  const created = yield* createOrReuseBranch();
  const branch = yield* waitForBranch(created.project_ref);
  const credentials = yield* branchCredentials(branch);
  yield* configureServices(branch, identity.siteUrl);

  const password = yield* runtimePassword(
    seed,
    identity.repository,
    branch.project_ref
  );

  const runtime = new URL(Redacted.value(credentials.database));
  runtime.username = `vektor_runtime.${branch.project_ref}`;
  runtime.password = Redacted.value(password);
  runtime.search = "?sslmode=require";

  const receipt: PreviewReceipt = {
    ...identity,
    branchRef: branch.project_ref,
    migrationDatabaseUrl: credentials.database,
    publishableKey: credentials.publishable,
    runtimeDatabaseUrl: Redacted.make(runtime.toString()),
    secretKey: credentials.secret,
    supabaseUrl: `https://${branch.project_ref}.supabase.co`,
  };

  yield* probeCapture(receipt);
  yield* writeReceipt(receipt);
  const githubOutput = yield* Config.option(Config.String("GITHUB_OUTPUT"));

  if (Option.isSome(githubOutput)) {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;

    if (!path.isAbsolute(githubOutput.value)) {
      return yield* new PreviewError({
        message: "GITHUB_OUTPUT must be an absolute path",
      });
    }

    const info = yield* fs.lstat(githubOutput.value);

    if (info.type !== "File") {
      return yield* new PreviewError({
        message: "GITHUB_OUTPUT must be a regular file",
      });
    }

    yield* fs.writeFileString(githubOutput.value, `url=${receipt.siteUrl}\n`, {
      flag: "a",
    });
  }

  return yield* Effect.void;
});

NodeRuntime.runMain(
  program.pipe(
    Effect.provide([
      NodeServices.layer,
      NodeCrypto.layerSecureRandom,
      FetchHttpClient.layer,
      Mac.layerWebCrypto.pipe(Layer.provide(NodeCrypto.layerSecureRandom)),
    ]),
    Effect.catch(() =>
      Effect.die(
        "Preview preparation failed; verify the designated synthetic project and private sandbox configuration"
      )
    )
  )
);
