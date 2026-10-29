import { detectContentType, fileKeyFor } from "@vektorprogrammet/domain";
import type { FileKey, StoredContentType } from "@vektorprogrammet/domain";
/**
 * Legacy file bytes and their content-addressed keys.
 *
 * `LegacyFiles` is the read-only source of the legacy web root (`LEGACY_FILES_DIR`,
 * the directory holding `images/` and `Offentlige filer/`). Copying the
 * production file directories is not authorised yet (Checkpoint 2), so the
 * default Layer is `LegacyFiles.none`: every referenced file is reported missing.
 */
import {
  Array as Arr,
  Context,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Order,
  Path,
  Predicate,
  Schema,
  String as Str,
} from "effect";
import { Digest } from "effect/crypto";
import { encode as hexEncode } from "effect/encoding/Hex";

export class LegacyFilesError extends Schema.TaggedError<
  LegacyFilesError,
  { readonly brand: unique symbol }
>()("LegacyFilesError", {
  cause: Schema.Defect(),
  /** The reason only; the path may carry personal data and stays out of logs and reports. */
  reason: Schema.String,
}) {}

export interface LegacyFileBytes {
  readonly bytes: Uint8Array;
  readonly modifiedAt: DateTime.Utc;
}

const fileReadFailure = (reason: string) => (cause: unknown) =>
  new LegacyFilesError({ cause, reason });

export class LegacyFiles extends Context.Service<
  LegacyFiles,
  {
    /** `directory` when a legacy web root was given, `none` otherwise (reported). */
    readonly source: "directory" | "none";
    /** The file at a normalised legacy path (`images/…`); `None` when it does not exist. */
    readonly read: (
      legacyPath: string
    ) => Effect.Effect<Option.Option<LegacyFileBytes>, LegacyFilesError>;
  }
>()("@vektorprogrammet/import/LegacyFiles") {
  /** No file source: every file is missing. */
  static readonly none = Layer.succeed(
    LegacyFiles,
    LegacyFiles.of({ read: () => Effect.succeedNone, source: "none" })
  );

  /**
   * Reads files below `root`. A path that resolves outside the root (through a
   * symlink) is treated as missing, so the source can never be used to read
   * other files on the operator's machine.
   */
  static readonly fromDirectory = (root: string) =>
    Layer.effect(
      LegacyFiles,
      Effect.gen(function* fromDirectory() {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        const realRoot = yield* fs.realPath(root).pipe(
          Effect.mapError(
            (cause) =>
              new LegacyFilesError({
                cause,
                reason: "LEGACY_FILES_DIR is not readable",
              })
          )
        );

        const read = Effect.fn("LegacyFiles.read")(function* read(
          legacyPath: string
        ) {
          const candidate = path.join(
            realRoot,
            ...Arr.filter(Str.split(legacyPath, "/"), (s) => s !== "")
          );

          const located = yield* fs.realPath(candidate).pipe(
            Effect.asSome,
            Effect.catchTag("PlatformError", (error) =>
              Predicate.isTagged(error.reason, "NotFound")
                ? Effect.succeedNone
                : Effect.fail(
                    new LegacyFilesError({
                      cause: error,
                      reason: "stat failed",
                    })
                  )
            )
          );

          if (Option.isNone(located)) {
            return Option.none<LegacyFileBytes>();
          }

          const relative = path.relative(realRoot, located.value);

          if (Str.startsWith("..")(relative) || path.isAbsolute(relative)) {
            return Option.none<LegacyFileBytes>();
          }

          const info = yield* fs
            .stat(located.value)
            .pipe(Effect.mapError(fileReadFailure("stat failed")));

          if (info.type !== "File") {
            return Option.none<LegacyFileBytes>();
          }

          const bytes = yield* fs
            .readFile(located.value)
            .pipe(Effect.mapError(fileReadFailure("read failed")));

          // The modification time is the upload time legacy recorded on disk; it
          // keeps `public_file.uploaded_at` identical across reruns.
          const modifiedAt = Option.match(info.mtime, {
            onNone: () => DateTime.makeUnsafe(0),
            onSome: (mtime) => DateTime.fromDateUnsafe(mtime),
          });

          return Option.some<LegacyFileBytes>({ bytes, modifiedAt });
        });

        return LegacyFiles.of({ read, source: "directory" });
      })
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
export const resolveLegacyFiles = Effect.fn("resolveLegacyFiles")(
  function* resolveLegacyFiles(paths: Iterable<string>) {
    const files = yield* LegacyFiles;
    const digests = yield* Digest.Digest;
    const unique = Arr.sort([...new Set(paths)], Order.String);

    const resolved = yield* Effect.forEach(
      unique,
      (legacyPath) =>
        files.read(legacyPath).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeedNone,
              onSome: ({ bytes, modifiedAt }) =>
                digests.digest(Digest.sha256, bytes).pipe(
                  Effect.map((digest) => {
                    const contentType = detectContentType(bytes);

                    const base = Option.match(
                      Str.lastIndexOf("/")(legacyPath),
                      {
                        onNone: () => legacyPath,
                        onSome: (at) => Str.slice(at + 1)(legacyPath),
                      }
                    );

                    const name = Str.slice(0, 255)(base);

                    return Option.some<ResolvedFile>({
                      contentType,
                      key: fileKeyFor(digest, contentType),
                      legacyPath,
                      name,
                      sha256: hexEncode(digest),
                      size: bytes.byteLength,
                      uploadedAt: modifiedAt,
                    });
                  })
                ),
            })
          )
        ),
      { concurrency: 8 }
    );

    return new Map(
      Arr.flatMap(resolved, (file) =>
        Option.isSome(file) ? [[file.value.legacyPath, file.value]] : []
      )
    );
  }
);
