/**
 * C11 file typing by magic bytes (never by the client's claimed type or name)
 * and the serving policy for `/filer/{key}` (RULE-290 replacement, architecture §4):
 * only JPEG, PNG, WebP, GIF and PDF are served inline; everything else is an
 * attachment; every response carries `nosniff` and `CSP: sandbox; default-src 'none'`.
 */
import {
  Array as Arr,
  Match,
  Option,
  Result,
  Schema,
  String as Str,
} from "effect";
import { encode as hexEncode } from "effect/encoding/Hex";

import { validationFailed } from "../shared/errors.ts";
import type { ValidationFailed } from "../shared/errors.ts";
import { FileKey } from "../shared/ids.ts";
import type { FileExtension } from "../shared/ids.ts";

export const ImageContentType = Schema.Literals([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

export type ImageContentType = typeof ImageContentType.Type;

export const InlineContentType = Schema.Literals([
  ...ImageContentType.literals,
  "application/pdf",
]);

export type InlineContentType = typeof InlineContentType.Type;

/** Every content type the store records: the inline allowlist or opaque bytes. */
export const StoredContentType = Schema.Literals([
  ...InlineContentType.literals,
  "application/octet-stream",
]);

export type StoredContentType = typeof StoredContentType.Type;

const startsWith = (
  bytes: Uint8Array,
  offset: number,
  signature: readonly number[]
): boolean =>
  bytes.length >= offset + signature.length &&
  Arr.every(signature, (byte, index) => bytes[offset + index] === byte);

const ascii = (text: string): readonly number[] =>
  Array.from(text, (char) =>
    Option.getOrElse(Str.codePointAt(char, 0), () => 0)
  );

/** Detects the content type from the leading bytes. Unknown → `application/octet-stream`. */
export const detectContentType = (bytes: Uint8Array): StoredContentType => {
  if (startsWith(bytes, 0, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }

  if (startsWith(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }

  if (
    startsWith(bytes, 0, ascii("GIF87a")) ||
    startsWith(bytes, 0, ascii("GIF89a"))
  ) {
    return "image/gif";
  }

  if (
    startsWith(bytes, 0, ascii("RIFF")) &&
    startsWith(bytes, 8, ascii("WEBP"))
  ) {
    return "image/webp";
  }

  if (startsWith(bytes, 0, ascii("%PDF-"))) {
    return "application/pdf";
  }

  return "application/octet-stream";
};

export const isImageContentType = (
  contentType: StoredContentType
): contentType is ImageContentType => Schema.is(ImageContentType)(contentType);

export const isInlineContentType = (
  contentType: StoredContentType
): contentType is InlineContentType =>
  Schema.is(InlineContentType)(contentType);

/** What an upload slot accepts. */
export const UploadAccept = Schema.Literals(["any", "image", "imageOrPdf"]);

export type UploadAccept = typeof UploadAccept.Type;

/** RULE-130 (legacy text kept). */
export const IMAGE_OR_PDF_REQUIRED_MESSAGE =
  "Filtypen må være et bilde eller PDF.";

export const IMAGE_REQUIRED_MESSAGE =
  "Filtypen må være et bilde (JPEG, PNG, WebP eller GIF).";

/**
 * RULE-130: classify an upload and check it against the slot. `imageOrPdf`
 * accepts the inline allowlist only (legacy accepted any `image/*`, including
 * SVG; SVG is now refused).
 */
export const classifyUpload = (
  bytes: Uint8Array,
  accept: UploadAccept
): Result.Result<StoredContentType, ValidationFailed> => {
  const contentType = detectContentType(bytes);

  return Match.value(accept).pipe(
    Match.when("any", () => Result.succeed(contentType)),
    Match.when("image", () =>
      isImageContentType(contentType)
        ? Result.succeed(contentType)
        : Result.fail(validationFailed(["file"], IMAGE_REQUIRED_MESSAGE))
    ),
    Match.when("imageOrPdf", () =>
      isInlineContentType(contentType)
        ? Result.succeed(contentType)
        : Result.fail(validationFailed(["file"], IMAGE_OR_PDF_REQUIRED_MESSAGE))
    ),
    Match.exhaustive
  );
};

const EXTENSION: Record<StoredContentType, FileExtension> = {
  "application/octet-stream": "bin",
  "application/pdf": "pdf",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/** Content-addressed key from a SHA-256 digest and the detected type. */
export const fileKeyFor = (
  sha256: Uint8Array,
  contentType: StoredContentType
): FileKey => FileKey.make(`${hexEncode(sha256)}.${EXTENSION[contentType]}`);

/** `filename*` per RFC 6266/5987 plus an ASCII fallback. */
const contentDisposition = (
  disposition: "inline" | "attachment",
  fileName: string
): string => {
  const fallback = Str.replaceAll(/[^\u0020-\u007E]|["\\]/gu, "_")(fileName);

  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
};

type ServingHeaders = Readonly<{
  "Cache-Control": string;
  "Content-Disposition": string;
  "Content-Length": string;
  "Content-Security-Policy": string;
  "Content-Type": string;
  "X-Content-Type-Options": string;
}>;

/** RULE-290 replacement: response headers for a registered public file. */
export const servingHeaders = (file: {
  readonly name: string;
  readonly contentType: StoredContentType;
  readonly size: number;
}): ServingHeaders => ({
  "Cache-Control": "public, max-age=31536000, immutable",
  "Content-Disposition": contentDisposition(
    isInlineContentType(file.contentType) ? "inline" : "attachment",
    file.name
  ),
  "Content-Length": String(file.size),
  "Content-Security-Policy": "sandbox; default-src 'none'",
  "Content-Type": file.contentType,
  "X-Content-Type-Options": "nosniff",
});
