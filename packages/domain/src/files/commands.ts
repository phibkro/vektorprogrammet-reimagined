/**
 * C11 upload and serving. An upload is two steps because R2 is provider I/O and
 * the database rule forbids provider I/O inside a transaction:
 *
 *   1. `storeUpload`        outside any transaction: authorize, type by magic
 *                           bytes, hash, `FileStore.put` (idempotent: the key is
 *                           the content hash, so a retried or orphaned put is harmless).
 *   2. `registerPublicFile` inside the transaction: registry row + audit entry.
 */
import { Crypto, DateTime, Effect, Option, Schema } from "effect";
import { recordAudit } from "../audit/auditLog.ts";
import { Capability, requireCapability } from "../shared/capabilities.ts";
import { NotFound, validationFailed } from "../shared/errors.ts";
import { FileKey } from "../shared/ids.ts";
import { InTransaction } from "../shared/transaction.ts";
import { decodeInput, requiredText } from "../shared/validation.ts";
import {
  IMAGE_REQUIRED_MESSAGE,
  classifyUpload,
  fileKeyFor,
  isImageContentType,
  servingHeaders,
  type StoredContentType,
  type UploadAccept,
} from "./fileType.ts";
import { FileStore, PublicFileRepository } from "./services.ts";

/** The result of step 1; the input of step 2. */
export interface StoredUpload {
  readonly key: FileKey;
  readonly name: string;
  readonly contentType: StoredContentType;
  readonly size: number;
}

const decodeFileName = decodeInput(
  Schema.Struct({ name: requiredText({ maxLength: 255, message: "Filen mangler navn." }) }),
);

/** Step 1 (no transaction): RULE-130 type check, content-addressed key, R2 put. */
export const storeUpload = Effect.fn("storeUpload")(function* (upload: {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly accept: UploadAccept;
}) {
  yield* requireCapability(Capability.UploadFiles());
  const { name } = yield* decodeFileName({ name: upload.name });
  const contentType = yield* Effect.fromResult(classifyUpload(upload.bytes, upload.accept));
  const crypto = yield* Crypto.Crypto;
  const digest = yield* crypto.digest("SHA-256", upload.bytes).pipe(Effect.orDie);
  const key = fileKeyFor(digest, contentType);
  const store = yield* FileStore;
  yield* store.put({ key, bytes: upload.bytes, contentType });
  return { key, name, contentType, size: upload.bytes.byteLength } satisfies StoredUpload;
});

/** Step 2 (in the transaction): register the stored object and audit it. */
export const registerPublicFile = Effect.fn("registerPublicFile")(function* (upload: StoredUpload) {
  yield* InTransaction;
  const actor = yield* requireCapability(Capability.UploadFiles());
  const files = yield* PublicFileRepository;
  const registered = yield* files.register({
    key: upload.key,
    name: upload.name,
    contentType: upload.contentType,
    size: upload.size,
    uploadedBy: actor.userId,
    legacyPath: null,
    uploadedAt: yield* DateTime.now,
  });
  yield* recordAudit(actor, "publicFile.registered", "PublicFile", registered.key);
  return registered;
});

const decodeFileKey = Schema.decodeUnknownOption(FileKey);

/**
 * RULE-290 replacement: `/filer/{key}` serves registered public files only.
 * Anything else, including a malformed key or a registered key whose object is
 * missing, is `NotFound`; paths outside the store are unreachable by construction.
 */
export const servePublicFile = Effect.fn("servePublicFile")(function* (rawKey: string) {
  const notFound = new NotFound({ entity: "PublicFile", key: rawKey });
  const key = yield* Option.match(decodeFileKey(rawKey), {
    onNone: () => Effect.fail(notFound),
    onSome: Effect.succeed,
  });
  const files = yield* PublicFileRepository;
  const file = yield* Effect.flatMap(files.findByKey(key), (found) =>
    Option.match(found, { onNone: () => Effect.fail(notFound), onSome: Effect.succeed }),
  );
  const store = yield* FileStore;
  const object = yield* Effect.flatMap(store.get(key), (found) =>
    Option.match(found, { onNone: () => Effect.fail(notFound), onSome: Effect.succeed }),
  );
  return { file, body: object.body, headers: servingHeaders(file) };
});

/** Legacy `/Offentlige filer/{path}` → the key to redirect to (301), when mapped. */
export const resolveLegacyFilePath = Effect.fn("resolveLegacyFilePath")(function* (
  legacyPath: string,
) {
  const files = yield* PublicFileRepository;
  return Option.map(yield* files.findByLegacyPath(legacyPath), (file) => file.key);
});

/**
 * Article images and sponsor logos must be registered images. Fixes the legacy
 * sponsor-logo defect (no file-type check).
 */
export const requireRegisteredImage = Effect.fn("requireRegisteredImage")(function* (
  key: FileKey,
  path: ReadonlyArray<string>,
) {
  const files = yield* PublicFileRepository;
  const file = yield* files.findByKey(key);
  if (Option.isSome(file) && isImageContentType(file.value.contentType)) return file.value;
  return yield* validationFailed(path, IMAGE_REQUIRED_MESSAGE);
});
