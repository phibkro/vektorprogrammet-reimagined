/**
 * Legacy file references. Legacy stored uploads under the public web root and
 * referenced them by site path (`app/config/config.yml`, `Service/FileUploader.php`):
 *
 *   images/article_images/…   article images (`imageLarge`, `imageSmall`, embedded `<img>`)
 *   images/Logo images/…      department and sponsor logos
 *   Offentlige filer/…        elFinder public files linked from rich text (RULE-290)
 *
 * Rich text may hold them as site paths, percent-encoded, or as absolute URLs on
 * the legacy host. This module recognises those forms and normalises them to the
 * one string stored in `public_file.legacy_path` and looked up by `apps/web` for
 * the permanent redirect: the decoded path relative to the web root, without a
 * leading slash (`Offentlige filer/Styret/referat.pdf`).
 */
import { Array as Arr, Data, Schema } from "effect";

/** Upload directories whose files become registered public files. */
const FILE_ROOTS = [
  "Offentlige filer/",
  "images/article_images/",
  "images/Logo images/",
] as const;

/** Other web-root paths that held legacy assets; references to them cannot be mapped. */
const OTHER_ASSET_ROOT = "images/";

/** Hosts that served legacy files. A reference on another host is not a legacy file. */
const LEGACY_HOSTS = Schema.Literals([
  "vektorprogrammet.no",
  "www.vektorprogrammet.no",
]);

/** What a URL in legacy content refers to. */
export type LegacyReference = Data.TaggedEnum<{
  NotLegacy: Record<never, never>;
  File: { readonly path: string };
  Unmappable: { readonly area: string };
}>;

const legacyReference = Data.taggedEnum<LegacyReference>();

const NOT_LEGACY: LegacyReference = legacyReference.NotLegacy();

/**
 * The report's coarse location of a legacy file: its directory under the web
 * root (`images/article_images`, `Offentlige filer`). It never contains the
 * file name, which may carry personal data.
 */
export const fileArea = (path: string): string => {
  const segments = Arr.filter(path.split("/"), (segment) => segment !== "");

  return segments[0] === "images" && segments.length > 2
    ? `images/${segments[1] ?? ""}`
    : (segments[0] ?? "");
};

const decodeOrUndefined = (path: string): string | undefined => {
  try {
    return decodeURIComponent(path);
  } catch {
    // A malformed escape sequence throws URIError.
    return undefined;
  }
};

/** Classifies a URL found in legacy data (an attribute value or a path column). */
const sitePathFromUrl = (url: string): string | undefined => {
  const absolute = /^https?:\/\/(?<host>[^/]+)(?<pathname>.*)$/isu.exec(url);

  if (absolute === null) {
    if (url.startsWith("/") && !url.startsWith("//")) {
      return url;
    }

    return undefined;
  }

  const host = absolute.groups?.host?.toLowerCase();

  if (!Schema.is(LEGACY_HOSTS)(host)) {
    return undefined;
  }

  const pathname = absolute.groups?.pathname;

  if (pathname === undefined || pathname === "") {
    return "/";
  }

  return pathname;
};

const isSafeRelativePath = (path: string | undefined): path is string => {
  if (path === undefined) {
    return false;
  }

  return Arr.every(
    path.split("/"),
    (segment) =>
      segment !== "" &&
      segment !== "." &&
      segment !== ".." &&
      !segment.includes("\0")
  );
};

/** Classifies a URL found in legacy data (an attribute value or a path column). */
export const classifyReference = (raw: string): LegacyReference => {
  const url = raw.trim().replace(/[?#].*$/su, "");
  const sitePath = sitePathFromUrl(url);

  if (sitePath === undefined) {
    return NOT_LEGACY;
  }

  const relative = sitePath.slice(1);
  const decoded = decodeOrUndefined(relative);
  const candidate = decoded ?? relative;
  const isFileRoot = Arr.some(FILE_ROOTS, (root) => candidate.startsWith(root));

  if (!isFileRoot && !candidate.startsWith(OTHER_ASSET_ROOT)) {
    return NOT_LEGACY;
  }

  if (isFileRoot && isSafeRelativePath(decoded)) {
    return legacyReference.File({ path: candidate });
  }

  return legacyReference.Unmappable({ area: fileArea(candidate) });
};
