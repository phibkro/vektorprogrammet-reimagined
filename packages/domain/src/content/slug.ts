/**
 * Article URL slugs (RULE-096). A slug is unique and immutable once saved.
 *
 * Character mapping follows legacy `SlugMaker::replaceCharacters`: Æ/Ø/Å become
 * AE/O/A, soft hyphens, `-`, `!`, `,` and `.` are dropped, then every run of
 * other non-alphanumerics becomes one `-`. Unlike legacy, leading and trailing
 * dashes are trimmed and an empty result falls back to `artikkel`.
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
  ["\u00AD", ""],
  ["-", ""],
  ["!", ""],
  [",", ""],
  [".", ""],
];

const FALLBACK_SLUG = "artikkel";

/** The base slug of a title, before uniqueness. */
export const slugify = (title: string): Slug => {
  const replaced = Arr.reduce(REPLACEMENTS, title, (text, [from, to]) =>
    text.replaceAll(from, to)
  );

  const base = replaced
    .replaceAll(/[^A-Za-z0-9-]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .toLowerCase()
    .slice(0, 240)
    .replace(/-+$/u, "");

  return Slug.make(base.length > 0 ? base : FALLBACK_SLUG);
};

/** RULE-096: the base slug, or `base-2`, `base-3`, … whichever is first free. */
export const uniqueSlug = (title: string, existing: Iterable<string>): Slug => {
  const taken = new Set(existing);
  const base = slugify(title);

  if (!taken.has(base)) {
    return base;
  }

  let suffix = 2;

  while (taken.has(`${base}-${suffix}`)) {
    suffix += 1;
  }

  return Slug.make(`${base}-${suffix}`);
};
