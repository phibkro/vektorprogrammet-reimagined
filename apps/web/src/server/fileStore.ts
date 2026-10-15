/**
 * `FileStore` over the R2 binding (bucket `vp-public-files`, no public
 * access): objects are only ever read through `/filer/{key}`. Keys are
 * content-addressed, so `put` is idempotent. R2 failures are defects: the
 * domain contract gives `FileStore` no error channel.
 */
import type { R2Bucket } from "@cloudflare/workers-types";
import { FileStore } from "@vektorprogrammet/domain";
import { Effect, Layer, Option, Stream } from "effect";

export const r2FileStoreLayer = (bucket: R2Bucket): Layer.Layer<FileStore> =>
  Layer.succeed(
    FileStore,
    FileStore.of({
      put: ({ key, bytes, contentType }) =>
        Effect.promise(() => bucket.put(key, bytes, { httpMetadata: { contentType } })).pipe(
          Effect.asVoid,
          Effect.withSpan("FileStore.put"),
        ),
      get: (key) =>
        Effect.promise(() => bucket.get(key)).pipe(
          Effect.map((object) =>
            object === null
              ? Option.none()
              : Option.some({
                  size: object.size,
                  body: Stream.fromReadableStream({
                    // Same runtime object; workers-types and lib.dom declare ReadableStream separately.
                    evaluate: () => object.body as unknown as ReadableStream<Uint8Array>,
                    onError: (cause) => cause,
                  }).pipe(Stream.orDie),
                }),
          ),
          Effect.withSpan("FileStore.get"),
        ),
    }),
  );
