/**
 * Legacy URLs keep working (spec §4 "URLs"). Fixed aliases live in ONE table
 * here; legacy file and image paths are resolved through
 * `PublicFileRepository.findByLegacyPath` (the importer stores the same
 * string form: URL-decoded, relative to the legacy web root, no leading slash).
 */
import { resolveLegacyFilePath } from "@vektorprogrammet/domain";
import { Array as Arr, Effect, Option, Schema, String as Str } from "effect";

/** The fixed legacy aliases, answered with 301. `to` receives the regex match. */
export const LEGACY_ALIASES: readonly {
  readonly from: RegExp;
  readonly to: (match: RegExpExecArray) => string;
}[] = [
  // /om, /bedrifter and /faq were three legacy pages; /omvektor was this repository's Phase 1 path. Om oss is one page.
  { from: /^\/(?:om|bedrifter|faq|omvektor)\/?$/u, to: () => "/om-oss" },
  {
    from: /^\/artikkel\/(?<slug>[^/]+)\/?$/u,
    to: (match) => `/nyhet/${match.groups?.slug ?? match[1]}`,
  },
  // Phase 1 listed a department's news at /nyheter/{department}; the department is now a search parameter.
  {
    from: /^\/nyheter\/(?<department>[^/]+)\/?$/u,
    to: (match) => `/nyheter?avdeling=${match.groups?.department ?? match[1]}`,
  },
];

/** The request's query string after the alias's own: `?side=2` joins `?avdeling=x` as `&side=2`. */
const withSearch = (location: string, search: string): string => {
  if (search === "") {
    return location;
  }

  return Str.includes("?")(location)
    ? `${location}&${Str.slice(1)(search)}`
    : `${location}${search}`;
};

/** Legacy public file directories (relative to the legacy web root). */
export const LEGACY_FILE_PREFIXES = [
  "Offentlige filer/",
  "images/article_images/",
  "images/Logo images/",
] as const;

export const LegacyPathSchema = Schema.TaggedUnion({
  Alias: { location: Schema.String },
  LegacyFile: { legacyPath: Schema.String },
  None: {},
});

export type LegacyPath = typeof LegacyPathSchema.Type;

const NONE: LegacyPath = LegacyPathSchema.cases.None.make({});

/** A legacy file path the importer could have registered: no empty, `.`, `..` segments or NUL. */
const isPlainRelativePath = (path: string): boolean =>
  !Str.includes("\0")(path) &&
  Arr.every(
    Str.split(path, "/"),
    (segment) => segment !== "" && segment !== "." && segment !== ".."
  );

/** Classifies a request path (pure; the file lookup happens in `legacyFileLocation`). */
export const classifyLegacyPath = (
  pathname: string,
  search: string
): LegacyPath => {
  for (const alias of LEGACY_ALIASES) {
    const match = alias.from.exec(pathname);

    if (match !== null) {
      return LegacyPathSchema.cases.Alias.make({
        location: withSearch(alias.to(match), search),
      });
    }
  }

  let decoded: string;

  try {
    decoded = decodeURIComponent(Str.slice(1)(pathname));
  } catch {
    return NONE;
  }

  return Arr.some(LEGACY_FILE_PREFIXES, (prefix) =>
    Str.startsWith(prefix)(decoded)
  ) && isPlainRelativePath(decoded)
    ? LegacyPathSchema.cases.LegacyFile.make({ legacyPath: decoded })
    : NONE;
};

/** `/filer/{key}` for a registered legacy file, or `None` (then the request falls through to 404). */
export const legacyFileLocation = (legacyPath: string) =>
  Effect.map(
    resolveLegacyFilePath(legacyPath),
    Option.map((key) => `/filer/${key}`)
  );

export const permanentRedirect = (location: string): Response =>
  new Response(null, { headers: { Location: location }, status: 301 });
