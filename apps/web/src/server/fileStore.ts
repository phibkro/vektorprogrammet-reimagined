/** Supabase SDK boundary. The private bucket is served only through the domain file registry. */
import { FileStore } from "@vektorprogrammet/domain";
import { Effect, Layer, Option, Stream } from "effect";

import type { WorkerEnv } from "./env";
import { createAdminClient } from "./supabase";

export const PUBLIC_FILES_BUCKET = "public-files";

export const supabaseFileStoreLayer = (
  config: Pick<
    WorkerEnv,
    "SUPABASE_URL" | "SUPABASE_PUBLISHABLE_KEY" | "SUPABASE_SECRET_KEY"
  >
): Layer.Layer<FileStore> =>
  Layer.sync(FileStore, () => {
    const bucket = createAdminClient(config).storage.from(PUBLIC_FILES_BUCKET);

    return FileStore.of({
      get: (key) =>
        Effect.gen(function* getStoredFile() {
          const result = yield* Effect.promise((signal) =>
            bucket.download(key, {}, { signal })
          );

          if (result.error !== null) {
            if (
              "statusCode" in result.error &&
              result.error.statusCode === "404"
            ) {
              return Option.none();
            }

            return yield* Effect.die(result.error);
          }

          const blob = result.data;

          return Option.some({
            body: Stream.fromAsyncIterable(
              blob.stream(),
              (cause) => cause
            ).pipe(Stream.orDie),
            size: blob.size,
          });
        }),
      put: ({ key, bytes, contentType }) =>
        Effect.gen(function* putStoredFile() {
          const result = yield* Effect.promise(() =>
            bucket.upload(key, bytes, {
              contentType,
              upsert: true,
            })
          );

          if (result.error !== null) {
            return yield* Effect.die(result.error);
          }

          return yield* Effect.void;
        }),
    });
  });
