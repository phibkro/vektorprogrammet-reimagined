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

/** Upload directories whose files become registered public files. */
const FILE_ROOTS = ["Offentlige filer/", "images/article_images/", "images/Logo images/"] as const;

/** Other web-root paths that held legacy assets; references to them cannot be mapped. */
const OTHER_ASSET_ROOT = "images/";

/** Hosts that served legacy files. A reference on another host is not a legacy file. */
const LEGACY_HOSTS: Record<string, true> = {
  "vektorprogrammet.no": true,
  "www.vektorprogrammet.no": true,
};

/** What a URL in legacy content refers to. */
export type LegacyReference =
  | { readonly _tag: "NotLegacy" }
  /** A file under an upload root; `path` is the normalised `legacy_path`. */
  | { readonly _tag: "File"; readonly path: string }
  /**
   * A legacy web-root asset the importer cannot map: outside the upload roots,
   * or unsafe (`.`/`..`/empty segments, NUL, malformed percent-encoding).
   */
  | { readonly _tag: "Unmappable"; readonly area: string };

const NOT_LEGACY: LegacyReference = { _tag: "NotLegacy" };

/**
 * The report's coarse location of a legacy file: its directory under the web
 * root (`images/article_images`, `Offentlige filer`). It never contains the
 * file name, which may carry personal data.
 */
export const fileArea = (path: string): string => {
  const segments = path.split("/").filter((segment) => segment !== "");
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
export const classifyReference = (raw: string): LegacyReference => {
  const url = raw.trim().replace(/[?#].*$/s, "");
  const absolute = /^https?:\/\/([^/]+)(.*)$/is.exec(url);
  const sitePath =
    absolute === null
      ? url.startsWith("/") && !url.startsWith("//")
        ? url
        : undefined
      : LEGACY_HOSTS[(absolute[1] ?? "").toLowerCase()] === true
        ? absolute[2] || "/"
        : undefined;
  if (sitePath === undefined) return NOT_LEGACY;
  const relative = sitePath.slice(1);
  const decoded = decodeOrUndefined(relative);
  const candidate = decoded ?? relative;
  const isFileRoot = FILE_ROOTS.some((root) => candidate.startsWith(root));
  if (!isFileRoot && !candidate.startsWith(OTHER_ASSET_ROOT)) return NOT_LEGACY;
  const unsafe =
    decoded === undefined ||
    decoded
      .split("/")
      .some(
        (segment) =>
          segment === "" || segment === "." || segment === ".." || segment.includes("\0"),
      );
  return isFileRoot && !unsafe
    ? { _tag: "File", path: candidate }
    : { _tag: "Unmappable", area: fileArea(candidate) };
};
