/** C11 registered public files. Only registered keys are reachable (RULE-290 replacement). */
import { Schema } from "effect";
import { FileKey, UserId } from "../shared/ids.ts";
import { StoredContentType } from "./fileType.ts";

export const PublicFile = Schema.Struct({
  key: FileKey,
  /** Original file name, used for `Content-Disposition`. */
  name: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(255)),
  contentType: StoredContentType,
  size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** Null for imported legacy files. */
  uploadedBy: Schema.NullOr(UserId),
  /** Legacy `Offentlige filer/` path, for the permanent redirect; null for new uploads. */
  legacyPath: Schema.NullOr(Schema.String),
  uploadedAt: Schema.DateTimeUtc,
});
export type PublicFile = typeof PublicFile.Type;
