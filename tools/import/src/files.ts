/**
 * Legacy file bytes and their content-addressed keys.
 *
 * `LegacyFiles` is the read-only source of the legacy web root (`LEGACY_FILES_DIR`,
 * the directory holding `images/` and `Offentlige filer/`). Copying the
 * production file directories is not authorised yet (Checkpoint 2), so the
 * default Layer is `LegacyFiles.none`: every referenced file is reported missing.
 */
import { Context, Crypto, DateTime, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
import { encode as hexEncode } from "effect/encoding/Hex";
import {
  type FileKey,
  type StoredContentType,
  detectContentType,
  fileKeyFor,
} from "@vektorprogrammet/domain";

export class LegacyFilesError extends Schema.TaggedError<LegacyFilesError>()("LegacyFilesError", {
  /** The reason only; the path may carry personal data and stays out of logs and reports. */
  reason: Schema.String,
  cause: Schema.Defect(),
}) {}

export interface LegacyFileBytes {
  readonly bytes: Uint8Array;
  readonly modifiedAt: DateTime.Utc;
}

export class LegacyFiles extends Context.Service<
  LegacyFiles,
  {
    /** `directory` when a legacy web root was given, `none` otherwise (reported). */
    readonly source: "directory" | "none";
    /** The file at a normalised legacy path (`images/…`); `None` when it does not exist. */
    read(legacyPath: string): Effect.Effect<Option.Option<LegacyFileBytes>, LegacyFilesError>;
  }
>()("@vektorprogrammet/import/LegacyFiles") {
  /** No file source: every file is missing. */
  static readonly none = Layer.succeed(
    LegacyFiles,
    LegacyFiles.of({ source: "none", read: () => Effect.succeedNone }),
  );

  /**
   * Reads files below `root`. A path that resolves outside the root (through a
   * symlink) is treated as missing, so the source can never be used to read
   * other files on the operator's machine.
   */
  static readonly fromDirectory = (root: string) =>
    Layer.effect(
      LegacyFiles,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const realRoot = yield* fs
          .realPath(root)
          .pipe(
            Effect.mapError(
              (cause) =>
                new LegacyFilesError({ reason: "LEGACY_FILES_DIR is not readable", cause }),
            ),
          );

        const read = Effect.fn("LegacyFiles.read")(function* (legacyPath: string) {
          const candidate = path.join(realRoot, ...legacyPath.split("/").filter((s) => s !== ""));
          const located = yield* fs.realPath(candidate).pipe(
            Effect.map(Option.some),
            Effect.catchTag("PlatformError", (error) =>
              error.reason._tag === "NotFound"
                ? Effect.succeedNone
                : Effect.fail(new LegacyFilesError({ reason: "stat failed", cause: error })),
            ),
          );
          if (Option.isNone(located)) return Option.none<LegacyFileBytes>();
          const relative = path.relative(realRoot, located.value);
          if (relative.startsWith("..") || path.isAbsolute(relative)) {
            return Option.none<LegacyFileBytes>();
          }
          const failed = (reason: string) => (cause: unknown) =>
            new LegacyFilesError({ reason, cause });
          const info = yield* fs.stat(located.value).pipe(Effect.mapError(failed("stat failed")));
          if (info.type !== "File") return Option.none<LegacyFileBytes>();
          const bytes = yield* fs
            .readFile(located.value)
            .pipe(Effect.mapError(failed("read failed")));
          // The modification time is the upload time legacy recorded on disk; it
          // keeps `public_file.uploaded_at` identical across reruns.
          const modifiedAt = Option.match(info.mtime, {
            onNone: () => DateTime.makeUnsafe(0),
            onSome: (mtime) => DateTime.fromDateUnsafe(mtime),
          });
          return Option.some<LegacyFileBytes>({ bytes, modifiedAt });
        });

        return LegacyFiles.of({ source: "directory", read });
      }),
    );
}

/** A legacy file that exists, typed and keyed like a fresh upload (`storeUpload`). */
export interface ResolvedFile {
  readonly legacyPath: string;
  readonly key: FileKey;
  readonly name: string;
  readonly contentType: StoredContentType;
  readonly size: number;
  readonly sha256: string;
  readonly uploadedAt: DateTime.Utc;
}

/** Decoded legacy site path → the resolved file. A path that is absent is missing. */
export type FileIndex = ReadonlyMap<string, ResolvedFile>;

/**
 * Reads, types (by magic bytes, RULE-130) and hashes every referenced legacy
 * file. `paths` are decoded site paths; the result is independent of their order.
 */
export const resolveLegacyFiles = Effect.fn("resolveLegacyFiles")(function* (
  paths: Iterable<string>,
) {
  const files = yield* LegacyFiles;
  const crypto = yield* Crypto.Crypto;
  const unique = Array.from(new Set(paths)).sort();
  const resolved = yield* Effect.forEach(
    unique,
    (legacyPath) =>
      files.read(legacyPath).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeedNone,
            onSome: ({ bytes, modifiedAt }) =>
              crypto.digest("SHA-256", bytes).pipe(
                Effect.orDie,
                Effect.map((digest) => {
                  const contentType = detectContentType(bytes);
                  const name = legacyPath.slice(legacyPath.lastIndexOf("/") + 1).slice(0, 255);
                  return Option.some<ResolvedFile>({
                    legacyPath,
                    key: fileKeyFor(digest, contentType),
                    name,
                    contentType,
                    size: bytes.byteLength,
                    sha256: hexEncode(digest),
                    uploadedAt: modifiedAt,
                  });
                }),
              ),
          }),
        ),
      ),
    { concurrency: 8 },
  );
  return new Map(
    resolved.flatMap((file) => (Option.isSome(file) ? [[file.value.legacyPath, file.value]] : [])),
  ) as FileIndex;
});
