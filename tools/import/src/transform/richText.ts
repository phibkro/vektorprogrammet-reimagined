/**
 * Rich text import (RULE-133 replacement, architecture §6): legacy HTML goes
 * through the domain sanitizer, `src`/`href` values that point at legacy upload
 * paths are rewritten to `/filer/{key}`, and the result is sanitized again so the
 * stored value is the sanitizer's own output (`SanitizedHtml`).
 *
 * Sanitizing first means only references that survive the allowlist count:
 * a `<script src="/images/…">` is removed, not reported as a missing file. The
 * sanitizer serialises every attribute as `name="value"` with `&`, `<`, `>`
 * and `"` escaped, which is what the attribute pattern below relies on.
 */
import { type FileKey, type SanitizedHtml, sanitizeRichText } from "@vektorprogrammet/domain";
import { classifyReference } from "./legacyPath.ts";

const URL_ATTRIBUTE = /(\s(?:src|href)=")([^"]*)(")/g;

/** Reverses the sanitizer's attribute escaping (`&amp;` last). */
const unescapeAttribute = (value: string): string =>
  value
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

/** The legacy upload paths a rich-text value references after sanitizing. */
export const richTextFilePaths = (html: string): ReadonlyArray<string> =>
  Array.from(sanitizeRichText(html).matchAll(URL_ATTRIBUTE), (match) =>
    classifyReference(unescapeAttribute(match[2] ?? "")),
  ).flatMap((ref) => (ref._tag === "File" ? [ref.path] : []));

export interface ImportedRichText {
  readonly html: SanitizedHtml;
  /** The sanitizer removed or changed markup (scripts, handlers, styles, …). */
  readonly sanitizerChanged: boolean;
  /** References rewritten to `/filer/{key}`. */
  readonly rewritten: number;
  /** Upload paths without a resolved file; the original reference is kept. */
  readonly missing: ReadonlyArray<string>;
  /** Areas of legacy asset references that cannot be mapped; kept unchanged. */
  readonly unmappable: ReadonlyArray<string>;
}

/** Sanitizes legacy HTML and rewrites resolved upload references to `/filer/{key}`. */
export const importRichText = (
  html: string,
  keyFor: (legacyPath: string) => FileKey | undefined,
): ImportedRichText => {
  const clean = sanitizeRichText(html);
  const missing: Array<string> = [];
  const unmappable: Array<string> = [];
  let rewritten = 0;
  const replaced = clean.replace(
    URL_ATTRIBUTE,
    (whole, open: string, value: string, close: string) => {
      const reference = classifyReference(unescapeAttribute(value));
      switch (reference._tag) {
        case "NotLegacy":
          return whole;
        case "Unmappable":
          unmappable.push(reference.area);
          return whole;
        case "File": {
          const key = keyFor(reference.path);
          if (key === undefined) {
            missing.push(reference.path);
            return whole;
          }
          rewritten += 1;
          return `${open}/filer/${key}${close}`;
        }
      }
    },
  );
  return {
    html: sanitizeRichText(replaced),
    sanitizerChanged: clean !== html,
    rewritten,
    missing,
    unmappable,
  };
};
