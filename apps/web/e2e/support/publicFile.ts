import type { R2Bucket } from "@cloudflare/workers-types";
import { PgClient } from "@effect/sql-pg";
/** Seeds one disposable public-file row and object in the local R2 store used by vp dev. */
import { fileKeyFor } from "@vektorprogrammet/domain";
import type { Redacted } from "effect";
import { Array as Arr, Effect, FileSystem, Path, String as Str } from "effect";
import { Digest } from "effect/crypto";
import { SqlClient } from "effect/sql/SqlClient";
import { getPlatformProxy } from "wrangler";

import { COMPATIBILITY_DATE, publicFilesBucket } from "../../worker.config.ts";

export const PUBLIC_FILE_FIXTURE_TEXT =
  "Vektorprogrammet local public-file fixture.\n";

const PUBLIC_FILE_NAME = "vektorprogrammet-e2e-fixture.bin";
const FILE_BYTES = new TextEncoder().encode(PUBLIC_FILE_FIXTURE_TEXT);

interface SeedBindings {
  readonly PUBLIC_FILES: R2Bucket;
}

export const seedPublicFile = Effect.fn("seedPublicFile")(
  function* seedPublicFile(
    databaseUrl: Redacted.Redacted,
    webDirectory: string
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const digests = yield* Digest.Digest;
    const digest = yield* digests.digest(Digest.sha256, FILE_BYTES);

    const publicFileKey = fileKeyFor(digest, "application/octet-stream");

    // Outside the worktree: a stack stopped without finalizers must not leave an untracked file in it.
    const configDirectory = yield* fs.makeTempDirectoryScoped({
      prefix: "vk-r2-seed-",
    });

    const configPath = path.join(configDirectory, "wrangler.json");

    const configContents = Arr.join(
      [
        "{",
        `  "compatibility_date": "${COMPATIBILITY_DATE}",`,
        `  "main": "${path.join(webDirectory, "e2e", "support", "r2SeedWorker.ts")}",`,
        '  "name": "vektorprogrammet-e2e-r2-seed",',
        '  "r2_buckets": [{',
        '    "binding": "PUBLIC_FILES",',
        `    "bucket_name": "${publicFilesBucket("local")}"`,
        "  }]",
        "}",
      ],
      "\n"
    );

    yield* fs.writeFileString(configPath, configContents);

    const platform = yield* Effect.acquireRelease(
      Effect.tryPromise(
        // oxlint-disable-next-line effecttsgo/async-function -- EX-0023: Wrangler exposes only a Promise API.
        async () =>
          await getPlatformProxy<SeedBindings>({
            configPath,
            persist: {
              path: path.join(webDirectory, ".wrangler", "state", "v3"),
            },
            remoteBindings: false,
          })
      ).pipe(Effect.orDie),
      (proxy) =>
        // oxlint-disable-next-line effecttsgo/async-function -- EX-0023: Wrangler exposes only a Promise API.
        Effect.promise(async () => {
          await proxy.dispose();
        })
    );

    yield* Effect.promise(
      // oxlint-disable-next-line effecttsgo/async-function -- EX-0023: R2Bucket exposes only a Promise API.
      async () =>
        await platform.env.PUBLIC_FILES.put(publicFileKey, FILE_BYTES, {
          httpMetadata: { contentType: "application/octet-stream" },
        })
    );

    yield* Effect.gen(function* insertFileRecord() {
      const sql = yield* SqlClient;
      yield* sql`insert into public_file
        (key, sha256, content_type, name, size, uploaded_at)
        values (${publicFileKey}, ${Str.slice(0, 64)(publicFileKey)},
          'application/octet-stream', ${PUBLIC_FILE_NAME}, ${FILE_BYTES.byteLength}, now())
        on conflict (key) do nothing`;
    }).pipe(
      Effect.provide(PgClient.layer({ maxConnections: 1, url: databaseUrl }))
    );

    return publicFileKey;
  }
);
