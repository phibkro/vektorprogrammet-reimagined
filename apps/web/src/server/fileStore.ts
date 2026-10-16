/**
 * `FileStore` over the R2 binding (bucket `vp-public-files`, no public
 * access): objects are only ever read through `/filer/{key}`. Keys are
 * content-addressed, so `put` is idempotent. R2 failures are defects: the
 * domain contract gives `FileStore` no error channel.
 */
import type { R2Bucket } from "@cloudflare/workers-types";
import { FileStore } from "@vektorprogrammet/domain";
import { Effect, Layer, Option, Schema, Stream } from "effect";

const decodeR2Chunk = Schema.decodeUnknownEffect(Schema.instanceOf(Uint8Array));

export const r2FileStoreLayer = (bucket: R2Bucket): Layer.Layer<FileStore> =>
  Layer.succeed(
    FileStore,
    FileStore.of({
      get: (key) =>
        Effect.promise(() => bucket.get(key)).pipe(
          Effect.map((object) =>
            object === null
              ? Option.none()
              : Option.some({
                  body: Stream.fromAsyncIterable(
                    object.body,
                    (cause) => cause
                  ).pipe(
                    Stream.mapEffect((chunk) => decodeR2Chunk(chunk)),
                    Stream.orDie
                  ),
                  size: object.size,
                })
          ),
          Effect.withSpan("FileStore.get")
        ),
      put: ({ key, bytes, contentType }) =>
        Effect.promise(() =>
          bucket.put(key, bytes, { httpMetadata: { contentType } })
        ).pipe(Effect.asVoid, Effect.withSpan("FileStore.put")),
    })
  );
