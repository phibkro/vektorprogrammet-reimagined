/** C11 services: the public-file registry (Postgres) and the object store (R2). */
import { Context, type Effect, type Option, type Stream } from "effect";
import type { FileKey } from "../shared/ids.ts";
import type { StoredContentType } from "./fileType.ts";
import type { PublicFile } from "./publicFile.ts";

export class PublicFileRepository extends Context.Service<
  PublicFileRepository,
  {
    findByKey(key: FileKey): Effect.Effect<Option.Option<PublicFile>>;
    findByLegacyPath(legacyPath: string): Effect.Effect<Option.Option<PublicFile>>;
    /**
     * Registers the file; idempotent on `key` (`ON CONFLICT (key) DO NOTHING`,
     * then returns the stored row, which wins over the argument).
     */
    register(file: PublicFile): Effect.Effect<PublicFile>;
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
    put(object: {
      readonly key: FileKey;
      readonly bytes: Uint8Array;
      readonly contentType: StoredContentType;
    }): Effect.Effect<void>;
    get(key: FileKey): Effect.Effect<Option.Option<StoredObject>>;
  }
>()("@vektorprogrammet/domain/files/FileStore") {}
