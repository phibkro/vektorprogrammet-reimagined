/** C4 editable static text blocks, keyed by the legacy `html_id` (≤ 50 characters). */
import { Schema } from "effect";
import { requiredText } from "../shared/validation.ts";
import { SanitizedHtmlFromString } from "./sanitizer.ts";

export const StaticContentKey = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(50),
).pipe(Schema.brand("StaticContentKey"));
export type StaticContentKey = typeof StaticContentKey.Type;

export const StaticContent = Schema.Struct({
  key: StaticContentKey,
  html: SanitizedHtmlFromString,
});
export type StaticContent = typeof StaticContent.Type;

export const EDITOR_ID_REQUIRED_MESSAGE = "Mangler editorID.";

/**
 * RULE-296 request body. `editorId` is required (legacy answered HTTP 400 when
 * it was missing); `html` defaults to empty like legacy `editabledata`.
 */
export const StaticContentUpdate = Schema.Struct({
  editorId: requiredText({ maxLength: 50, message: EDITOR_ID_REQUIRED_MESSAGE })
    .pipe(Schema.decodeTo(StaticContentKey))
    .annotateKey({ messageMissingKey: EDITOR_ID_REQUIRED_MESSAGE }),
  html: Schema.optionalKey(Schema.String),
});
export type StaticContentUpdate = typeof StaticContentUpdate.Type;
