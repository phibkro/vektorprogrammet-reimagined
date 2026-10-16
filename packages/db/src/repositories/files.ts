/** C11 public-file registry (RULE-290 replacement): only registered, undeleted keys resolve. */
import { PublicFile, PublicFileRepository } from "@vektorprogrammet/domain";
import type { FileKey } from "@vektorprogrammet/domain";
import { and, eq, isNull } from "drizzle-orm";
import { DateTime, Effect, Layer, Schema } from "effect";

import {
  Drizzle,
  decodeFirstOption,
  decodeWith,
  single,
} from "../internal/drizzle.ts";
import { publicFile } from "../schema.ts";

/** A public-file row as stored: `uploadedAt` is a `Date` from the driver. */
const PublicFileRow = Schema.Struct({
  ...PublicFile.fields,
  uploadedAt: Schema.DateTimeUtcFromDate,
});

const publicFileColumns = {
  contentType: publicFile.contentType,
  key: publicFile.key,
  legacyPath: publicFile.legacyPath,
  name: publicFile.name,
  size: publicFile.size,
  uploadedAt: publicFile.uploadedAt,
  uploadedBy: publicFile.uploadedBy,
};

/** Content-addressed keys are `<sha256 hex>.<extension>`; the hash is stored separately for lookups. */
const SHA256_HEX_LENGTH = 64;

export const PublicFileRepositoryLive = Layer.effect(
  PublicFileRepository,
  Effect.gen(function* PublicFileRepositoryLive() {
    const db = yield* Drizzle;
    const decode = decodeWith(PublicFileRow);
    const decodeFirst = decodeFirstOption(decode);

    const findByKey = Effect.fn("PublicFileRepository.findByKey")(
      function* findByKey(key: FileKey) {
        const rows = yield* db
          .select(publicFileColumns)
          .from(publicFile)
          .where(and(eq(publicFile.key, key), isNull(publicFile.deletedAt)))
          .pipe(Effect.orDie);

        return yield* decodeFirst(rows);
      }
    );

    const findByLegacyPath = Effect.fn("PublicFileRepository.findByLegacyPath")(
      function* findByLegacyPath(legacyPath: string) {
        const rows = yield* db
          .select(publicFileColumns)
          .from(publicFile)
          .where(
            and(
              eq(publicFile.legacyPath, legacyPath),
              isNull(publicFile.deletedAt)
            )
          )
          .pipe(Effect.orDie);

        return yield* decodeFirst(rows);
      }
    );

    /** Idempotent on `key`: an existing row wins over the argument. */
    const register = Effect.fn("PublicFileRepository.register")(
      function* register(file: PublicFile) {
        yield* db
          .insert(publicFile)
          .values({
            ...file,
            sha256: file.key.slice(0, SHA256_HEX_LENGTH),
            uploadedAt: DateTime.toDateUtc(file.uploadedAt),
          })
          .onConflictDoNothing({ target: publicFile.key })
          .pipe(Effect.orDie);

        const rows = yield* db
          .select(publicFileColumns)
          .from(publicFile)
          .where(eq(publicFile.key, file.key))
          .pipe(Effect.orDie);

        return yield* decode(yield* single(rows));
      }
    );

    return PublicFileRepository.of({ findByKey, findByLegacyPath, register });
  })
);
