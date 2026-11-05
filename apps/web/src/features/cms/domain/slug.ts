/**
 * URL slugs (RULE-096's character mapping): a department's address on the public site, and the check on the
 * slugs of imported legacy articles. The CMS makes the slug of a new article and keeps it unique.
 *
 * Character mapping follows legacy `SlugMaker::replaceCharacters`: Æ/Ø/Å become
 * AE/O/A, soft hyphens, `-`, `!`, `,` and `.` are dropped, then every run of
 * other non-alphanumerics becomes one `-`. Unlike legacy, leading and trailing
 * dashes are trimmed and an empty result falls back to `artikkel`.
 *
 * Approved differences from legacy (operator decision, 2026-10-16):
 * - F20: a real U+00AD soft hyphen is dropped, so "Real\u00ADfag\u00ADtimer" is
 *   `realfagtimer`. Legacy only dropped the HTML entity `&shy;`, so a real soft
 *   hyphen became a stray dash.
 * - F22: a base slug is capped at 240 characters, so a `-NN` suffix still fits
 *   `varchar(255)`. Legacy let a 255-character title fill the column and the
 *   uniqueness suffix overflow it.
 */
import { Array as Arr, Schema } from "effect";

/** Lenient on purpose so imported legacy slugs decode: lowercase ASCII letters, digits and dashes. */
export const Slug = Schema.String.check(
  Schema.isPattern(/^[a-z0-9-]+$/u, { expected: "a URL slug" }),
  Schema.isMaxLength(255)
).pipe(Schema.brand("Slug"));

export type Slug = typeof Slug.Type;

const REPLACEMENTS: readonly (readonly [string, string])[] = [
  ["Æ", "AE"],
  ["Ø", "O"],
  ["Å", "A"],
  ["æ", "ae"],
  ["ø", "o"],
  ["å", "a"],
  ["&shy;", ""],
  // F20: legacy kept the real character, which became a stray dash.
  ["\u00AD", ""],
  ["-", ""],
  ["!", ""],
  [",", ""],
  [".", ""],
];

const FALLBACK_SLUG = "artikkel";

/** F22: room for a `-NN` uniqueness suffix inside the 255-character column. */
const MAX_BASE_LENGTH = 240;

/** The base slug of a title, before uniqueness. */
export const slugify = (title: string): Slug => {
  const replaced = Arr.reduce(REPLACEMENTS, title, (text, [from, to]) =>
    text.replaceAll(from, to)
  );

  const base = replaced
    .replaceAll(/[^A-Za-z0-9-]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .toLowerCase()
    .slice(0, MAX_BASE_LENGTH)
    .replace(/-+$/u, "");

  return Slug.make(base.length > 0 ? base : FALLBACK_SLUG);
};
