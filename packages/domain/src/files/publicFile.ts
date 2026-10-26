/** C11 registered public files. Only registered keys are reachable (RULE-290 replacement). */
import { Schema } from "effect";

import { FileKey, PersonId } from "../shared/ids.ts";
import { StoredContentType } from "./fileType.ts";

export const PublicFile = Schema.Struct({
  contentType: StoredContentType,
  key: FileKey,
  /** Legacy `Offentlige filer/` path, for the permanent redirect; null for new uploads. */
  legacyPath: Schema.NullOr(Schema.String),
  /** Original file name, used for `Content-Disposition`. */
  name: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(255)),
  size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  uploadedAt: Schema.DateTimeUtc,
  /** The person who registered it; null for imported legacy files and for files a job registered. */
  uploadedBy: Schema.NullOr(PersonId),
});

export type PublicFile = typeof PublicFile.Type;
