/**
 * Legacy URLs keep working (spec §4 "URLs"). Fixed aliases live in ONE table
 * here; legacy file and image paths are resolved through
 * `PublicFileRepository.findByLegacyPath` (the importer stores the same
 * string form: URL-decoded, relative to the legacy web root, no leading slash).
 */
import { resolveLegacyFilePath } from "@vektorprogrammet/domain";
import { Effect, Option } from "effect";

/** The fixed legacy aliases, answered with 301. `to` receives the regex match. */
export const LEGACY_ALIASES: ReadonlyArray<{
  readonly from: RegExp;
  readonly to: (match: RegExpExecArray) => string;
}> = [
  { from: /^\/om\/?$/, to: () => "/omvektor" },
  { from: /^\/bedrifter\/?$/, to: () => "/omvektor" },
  { from: /^\/faq\/?$/, to: () => "/omvektor" },
  { from: /^\/artikkel\/([^/]+)\/?$/, to: (match) => `/nyhet/${match[1]}` },
];

/** Legacy public file directories (relative to the legacy web root). */
export const LEGACY_FILE_PREFIXES = [
  "Offentlige filer/",
  "images/article_images/",
  "images/Logo images/",
] as const;

export type LegacyPath =
  | { readonly _tag: "Alias"; readonly location: string }
  | { readonly _tag: "LegacyFile"; readonly legacyPath: string }
  | { readonly _tag: "None" };

const NONE: LegacyPath = { _tag: "None" };

/** A legacy file path the importer could have registered: no empty, `.`, `..` segments or NUL. */
const isPlainRelativePath = (path: string): boolean =>
  !path.includes("\0") &&
  path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");

/** Classifies a request path (pure; the file lookup happens in `legacyFileLocation`). */
export const classifyLegacyPath = (pathname: string, search: string): LegacyPath => {
  for (const alias of LEGACY_ALIASES) {
    const match = alias.from.exec(pathname);
    if (match !== null) return { _tag: "Alias", location: `${alias.to(match)}${search}` };
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname.slice(1));
  } catch {
    return NONE;
  }
  return LEGACY_FILE_PREFIXES.some((prefix) => decoded.startsWith(prefix)) &&
    isPlainRelativePath(decoded)
    ? { _tag: "LegacyFile", legacyPath: decoded }
    : NONE;
};

/** `/filer/{key}` for a registered legacy file, or `None` (then the request falls through to 404). */
export const legacyFileLocation = (legacyPath: string) =>
  Effect.map(
    resolveLegacyFilePath(legacyPath),
    Option.map((key) => `/filer/${key}`),
  );

export const permanentRedirect = (location: string): Response =>
  new Response(null, { status: 301, headers: { Location: location } });
