/**
 * RULE-133 replacement (operator, 2026-10-15): rich text passes a maintained
 * allowlist sanitizer on save and on render. Allowed: editor tags, http/https/
 * mailto links, images and tables. Everything else (scripts, event-handler
 * attributes, `javascript:` URLs, svg, object, iframe, style) is removed.
 * Plain-text fields are never rendered as HTML; React escapes them.
 *
 * `SanitizedHtml` can only be produced here: `sanitizeRichText` for fresh input,
 * and the `SanitizedHtmlFromString` codec, which re-sanitizes stored HTML when
 * `packages/db` decodes a row (the "on render" half of the rule).
 */
import { Predicate, Schema, SchemaGetter } from "effect";
import sanitizeHtml from "sanitize-html";

const SanitizedHtmlValue = Schema.String.pipe(Schema.brand("SanitizedHtml"));

/** HTML that went through sanitizeRichText. The brand symbol is not exported. */
export type SanitizedHtml = typeof SanitizedHtmlValue.Type;

const RICH_TEXT_OPTIONS: sanitizeHtml.IOptions = {
  allowProtocolRelative: false,
  allowedAttributes: {
    a: ["href", "title"],
    img: ["src", "alt", "title", "width", "height"],
    td: ["colspan", "rowspan"],
    th: ["colspan", "rowspan", "scope"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesAppliedToAttributes: ["href", "src"],
  allowedSchemesByTag: { img: ["http", "https"] },
  allowedTags: [
    "p",
    "br",
    "hr",
    "h2",
    "h3",
    "h4",
    "strong",
    "b",
    "em",
    "i",
    "u",
    "s",
    "sub",
    "sup",
    "blockquote",
    "pre",
    "code",
    "ul",
    "ol",
    "li",
    "a",
    "img",
    "figure",
    "figcaption",
    "table",
    "caption",
    "thead",
    "tbody",
    "tfoot",
    "tr",
    "th",
    "td",
  ],
  disallowedTagsMode: "discard",
};

/** The only constructor of `SanitizedHtml`. */
export const sanitizeRichText = (html: string): SanitizedHtml =>
  // The brand is a phantom type: the value is exactly the sanitizer's output.
  SanitizedHtmlValue.make(sanitizeHtml(html, RICH_TEXT_OPTIONS));

/** Accepts only strings the sanitizer leaves unchanged. */
export const SanitizedHtml = Schema.declare<SanitizedHtml>(
  (input): input is SanitizedHtml =>
    Predicate.isString(input) && sanitizeRichText(input) === input,
  { expected: "sanitized HTML" }
);

/** Decodes any string by sanitizing it; encodes as the plain string. Use for stored rich text. */
export const SanitizedHtmlFromString = Schema.String.pipe(
  Schema.decodeTo(SanitizedHtml, {
    decode: SchemaGetter.transform(sanitizeRichText),
    encode: SchemaGetter.passthroughSubtype(),
  })
);
