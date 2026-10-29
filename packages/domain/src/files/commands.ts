/**
 * C11 upload and serving. An upload is two steps because R2 is provider I/O and
 * the database rule forbids provider I/O inside a transaction:
 *
 *   1. `storeUpload`        outside any transaction: ask the grant of `createPublicFile`, type by magic
 *                           bytes, hash, `FileStore.put` (idempotent: the key is the content hash, so a
 *                           retried or orphaned put is harmless).
 *   2. `createPublicFile`   inside the transaction, as the command of `FilesRpc`: registry row + audit entry.
 */
import { DateTime, Effect, Option, Predicate, Schema } from "effect";
import { Digest } from "effect/crypto";

import { recordAudit } from "../audit/auditLog.ts";
import * as Commands from "../kernel/commands.ts";
import { NotFound, validationFailed } from "../shared/errors.ts";
import { FileKey } from "../shared/ids.ts";
import { InTransaction } from "../shared/transaction.ts";
import { decodeInput, requiredText } from "../shared/validation.ts";
import { FilesDomain, FilesRpc, createPublicFile } from "./declaration.ts";
import type { StoredUpload } from "./declaration.ts";
import {
  IMAGE_REQUIRED_MESSAGE,
  classifyUpload,
  fileKeyFor,
  isImageContentType,
  servingHeaders,
} from "./fileType.ts";
import type { UploadAccept } from "./fileType.ts";
import { FileStore, PublicFileRepository } from "./services.ts";

const decodeFileName = decodeInput(
  Schema.Struct({
    name: requiredText({ maxLength: 255, message: "Filen mangler navn." }),
  })
);

/** Step 1 (no transaction): RULE-130 type check, content-addressed key, R2 put. */
export const storeUpload = Effect.fn("storeUpload")(
  function* storeUpload(upload: {
    readonly name: string;
    readonly bytes: Uint8Array;
    readonly accept: UploadAccept;
  }) {
    yield* FilesDomain.requireGrant("createPublicFile", {});
    const { name } = yield* decodeFileName({ name: upload.name });

    const contentType = yield* Effect.fromResult(
      classifyUpload(upload.bytes, upload.accept)
    );

    const digests = yield* Digest.Digest;
    const digest = yield* digests.digest(Digest.sha256, upload.bytes);

    const key = fileKeyFor(digest, contentType);
    const store = yield* FileStore;
    yield* store.put({ bytes: upload.bytes, contentType, key });

    return {
      contentType,
      key,
      name,
      size: upload.bytes.byteLength,
    } satisfies StoredUpload;
  }
);

export const FilesHandlers = FilesRpc.toLayer({
  /** Step 2 (in the transaction): register the stored object and audit it. */
  createPublicFile: FilesDomain.handle(createPublicFile, {
    resource: () => Effect.succeed({}),
    run: (upload, principal) =>
      Effect.gen(function* run() {
        yield* InTransaction;
        const files = yield* PublicFileRepository;

        const registered = yield* files.register({
          contentType: upload.contentType,
          key: upload.key,
          legacyPath: null,
          name: upload.name,
          size: upload.size,
          uploadedAt: yield* DateTime.now,
          uploadedBy: Predicate.isTagged(principal, "Person")
            ? principal.personId
            : null,
        });

        yield* recordAudit(
          principal,
          "publicFile.registered",
          "PublicFile",
          registered.key
        );

        return registered;
      }),
  }),
});

/** The file commands behind the in-process client; see `Commands.inProcess`. */
export const withFiles = Commands.inProcess(FilesRpc, FilesHandlers);

/** The server functions' entries: untrusted input in, the command's own result out (`Commands.endpoint`). */
export const FilesEndpoints = {
  createPublicFile: Commands.endpoint(createPublicFile, (payload) =>
    withFiles((client) => client.createPublicFile(payload))
  ),
};

const decodeFileKey = Schema.decodeUnknownOption(FileKey);

/**
 * RULE-290 replacement: `/filer/{key}` serves registered public files only.
 * Anything else, including a malformed key or a registered key whose object is
 * missing, is `NotFound`; paths outside the store are unreachable by construction.
 */
export const servePublicFile = Effect.fn("servePublicFile")(
  function* servePublicFile(rawKey: string) {
    const notFound = new NotFound({ entity: "PublicFile", key: rawKey });

    const key = yield* Effect.fromOption(decodeFileKey(rawKey), () => notFound);

    const files = yield* PublicFileRepository;

    const file = yield* Effect.flatMap(files.findByKey(key), (found) =>
      Effect.fromOption(found, () => notFound)
    );

    const store = yield* FileStore;

    const object = yield* Effect.flatMap(store.get(key), (found) =>
      Effect.fromOption(found, () => notFound)
    );

    return { body: object.body, file, headers: servingHeaders(file) };
  }
);

/** Legacy `/Offentlige filer/{path}` → the key to redirect to (301), when mapped. */
export const resolveLegacyFilePath = Effect.fn("resolveLegacyFilePath")(
  function* resolveLegacyFilePath(legacyPath: string) {
    const files = yield* PublicFileRepository;

    return Option.map(
      yield* files.findByLegacyPath(legacyPath),
      (file) => file.key
    );
  }
);

/**
 * Article images and sponsor logos must be registered images. Fixes the legacy
 * sponsor-logo defect (no file-type check).
 */
export const requireRegisteredImage = Effect.fn("requireRegisteredImage")(
  function* requireRegisteredImage(key: FileKey, path: readonly string[]) {
    const files = yield* PublicFileRepository;
    const file = yield* files.findByKey(key);

    if (Option.isSome(file) && isImageContentType(file.value.contentType)) {
      return file.value;
    }

    return yield* validationFailed(path, IMAGE_REQUIRED_MESSAGE);
  }
);
