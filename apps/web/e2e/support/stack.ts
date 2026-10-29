/**
 * The stack the browser tests run against, built once by whoever needs it: `run.ts` (the tests) and `serve.ts` (the
 * verification skill's long-lived instance). Everything is owned by the caller's scope and released in reverse order:
 *
 *   disposable PostgreSQL database (migrated, seeded by the importer and the local seed, including a public file)
 *     →  the CMS (`astro dev` on the database's `emdash` schema, its default copy, the importer's fixture, twice)
 *     →  `vp dev` on a free port, reading that database and that CMS
 */
import { NodeCrypto, NodeServices } from "@effect/platform-node";
import { Effect, Layer, Random } from "effect";

import { importFixtureTwice, startCms } from "./cms.ts";
import { disposableDatabase } from "./database.ts";
import { startDevServer } from "./devServer.ts";
import { seedPublicFile } from "./publicFile.ts";

/** What the stack's programs need of the platform: `NodeServices` carries no crypto service since Effect 4.1. */
export const stackServices = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layerDigest
);

export const startStack = Effect.fn("startStack")(function* startStack(
  webDirectory: string
) {
  const databaseUrl = yield* disposableDatabase;
  const publicFileKey = yield* seedPublicFile(databaseUrl, webDirectory);
  // Two ranges, so the two servers can never draw the same port.
  const cmsPort = yield* Random.nextIntBetween(30_000, 40_000);
  const cms = yield* startCms({ databaseUrl, port: cmsPort });
  yield* Effect.log(`the CMS answers on ${cms.origin}; importing the fixture`);
  yield* importFixtureTwice(cms);

  const port = yield* Random.nextIntBetween(40_000, 50_000);

  const origin = yield* startDevServer({
    cms,
    databaseUrl,
    port,
    webDirectory,
  });

  yield* Effect.log(`vp dev answers on ${origin}`);

  return { cms, databaseUrl, origin, publicFileKey };
});
