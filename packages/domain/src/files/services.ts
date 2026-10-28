/** C11 services: the public-file registry and the object store (R2). */
import { Context } from "effect";
import type { Effect, Option, Stream } from "effect";

import type { FileKey } from "../shared/ids.ts";
import type { StoredContentType } from "./fileType.ts";
import type { PublicFile } from "./publicFile.ts";

export class PublicFileRepository extends Context.Service<
  PublicFileRepository,
  {
    readonly findByKey: (
      key: FileKey
    ) => Effect.Effect<Option.Option<PublicFile>>;
    readonly findByLegacyPath: (
      legacyPath: string
    ) => Effect.Effect<Option.Option<PublicFile>>;
    /**
     * Registers the file; idempotent on `key` (UK3): a second call changes nothing and returns the stored record, which
     * wins over the argument.
     */
    readonly register: (file: PublicFile) => Effect.Effect<PublicFile>;
  }
>()("@vektorprogrammet/domain/files/PublicFileRepository") {}

export interface StoredObject {
  readonly body: Stream.Stream<Uint8Array>;
  readonly size: number;
}

/**
 * R2 bucket `vp-public-files` (no public access). Keys are content-addressed
 * and immutable, so `put` is idempotent. Provider I/O: never call it inside a
 * database transaction.
 */
export class FileStore extends Context.Service<
  FileStore,
  {
    readonly put: (object: {
      readonly key: FileKey;
      readonly bytes: Uint8Array;
      readonly contentType: StoredContentType;
    }) => Effect.Effect<void>;
    readonly get: (key: FileKey) => Effect.Effect<Option.Option<StoredObject>>;
  }
>()("@vektorprogrammet/domain/files/FileStore") {}
