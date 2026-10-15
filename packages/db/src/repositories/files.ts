/** C11 public-file registry (RULE-290 replacement): only registered, undeleted keys resolve. */
import { PublicFile, PublicFileRepository, type FileKey } from "@vektorprogrammet/domain";
import { and, eq, isNull } from "drizzle-orm";
import { DateTime, Effect, Layer, Option, Schema } from "effect";
import { Drizzle, decodeWith, single } from "../internal/drizzle.ts";
import { publicFile } from "../schema.ts";

/** A public-file row as stored: `uploadedAt` is a `Date` from the driver. */
const PublicFileRow = Schema.Struct({
  ...PublicFile.fields,
  uploadedAt: Schema.DateTimeUtcFromDate,
});

const publicFileColumns = {
  key: publicFile.key,
  name: publicFile.name,
  contentType: publicFile.contentType,
  size: publicFile.size,
  uploadedBy: publicFile.uploadedBy,
  legacyPath: publicFile.legacyPath,
  uploadedAt: publicFile.uploadedAt,
};

/** Content-addressed keys are `<sha256 hex>.<extension>`; the hash is stored separately for lookups. */
const SHA256_HEX_LENGTH = 64;

export const PublicFileRepositoryLive = Layer.effect(
  PublicFileRepository,
  Effect.gen(function* () {
    const db = yield* Drizzle;
    const decode = decodeWith(PublicFileRow);

    const findByKey = Effect.fn("PublicFileRepository.findByKey")(function* (key: FileKey) {
      const rows = yield* db
        .select(publicFileColumns)
        .from(publicFile)
        .where(and(eq(publicFile.key, key), isNull(publicFile.deletedAt)))
        .pipe(Effect.orDie);
      const row = rows[0];
      return row === undefined ? Option.none() : Option.some(yield* decode(row));
    });

    const findByLegacyPath = Effect.fn("PublicFileRepository.findByLegacyPath")(function* (
      legacyPath: string,
    ) {
      const rows = yield* db
        .select(publicFileColumns)
        .from(publicFile)
        .where(and(eq(publicFile.legacyPath, legacyPath), isNull(publicFile.deletedAt)))
        .pipe(Effect.orDie);
      const row = rows[0];
      return row === undefined ? Option.none() : Option.some(yield* decode(row));
    });

    /** Idempotent on `key`: an existing row wins over the argument. */
    const register = Effect.fn("PublicFileRepository.register")(function* (file: PublicFile) {
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
    });

    return PublicFileRepository.of({ findByKey, findByLegacyPath, register });
  }),
);
