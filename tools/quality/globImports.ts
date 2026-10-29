import { Array as Arr, Option } from "effect";

import { globToRegExp } from "./storeBoundary.ts";

/** `{a,b}` alternatives of a Vite glob, innermost first: `./x.{ts,tsx}` is `./x.ts` and `./x.tsx`. */
const expandBraces = (pattern: string): readonly string[] => {
  const inner = /\{(?<options>[^{}]*)\}/u.exec(pattern);

  return inner === null
    ? [pattern]
    : Arr.flatMap((inner.groups?.options ?? "").split(","), (option) =>
        expandBraces(
          `${pattern.slice(0, inner.index)}${option}${pattern.slice(inner.index + inner[0].length)}`
        )
      );
};

/** The path `relative` leads to from the directory `start` (path segments from the repository root), or none when it climbs out of the repository. */
const walk = (
  start: readonly string[],
  relative: string
): Option.Option<readonly string[]> =>
  Arr.reduce(relative.split("/"), Option.some(start), (parts, segment) =>
    Option.flatMap(parts, (names) => {
      if (segment === "." || segment === "") {
        return Option.some(names);
      }

      return segment === ".."
        ? Option.liftPredicate(Arr.dropRight(names, 1), () => names.length > 0)
        : Option.some(Arr.append(names, segment));
    })
  );

/**
 * The directory that the patterns of an `import.meta.glob` written in `importer` start from, as path segments from the
 * repository root: the importer's directory, or `base` from it (Vite's `base` option), or, when `base` starts with `/`,
 * from `viteRoot` (the directory of the importer's package, Vite's project root; none when it has none). None when the
 * directory climbs out of the repository.
 */
export const globStart = (
  importer: string,
  base: Option.Option<string>,
  viteRoot: Option.Option<string>
): Option.Option<readonly string[]> => {
  const own = Arr.dropRight(importer.split("/"), 1);

  return Option.match(base, {
    onNone: () => Option.some(own),
    onSome: (written) =>
      written.startsWith("/")
        ? Option.flatMap(viteRoot, (root) =>
            walk(root === "" ? [] : root.split("/"), written.slice(1))
          )
        : walk(own, written),
  });
};

/** Glob syntax beyond `*`, `**` and `{a,b}`: classes, extended groups and `?`, which the matcher does not read. */
const unsupported = /[()?[\]]/u;

/**
 * The patterns of an `import.meta.glob` that starts in the directory `start` (`globStart`), each as a path-from-the-root
 * glob with its braces expanded; none when the pattern cannot be placed (a root-relative or aliased pattern, glob syntax
 * that the matcher does not read, a path out of the repository). A `!` pattern only removes files from the others, so it
 * places none.
 */
export const globsOf = (
  start: readonly string[],
  pattern: string
): Option.Option<readonly string[]> => {
  if (pattern.startsWith("!")) {
    return Option.some([]);
  }

  if (
    !(pattern.startsWith("./") || pattern.startsWith("../")) ||
    unsupported.test(pattern)
  ) {
    return Option.none();
  }

  return Option.all(
    Arr.map(expandBraces(pattern), (expanded) =>
      Option.map(walk(start, expanded), (names) => Arr.join(names, "/"))
    )
  );
};

/** The files among `paths` (paths from the repository root) that the globs (`globsOf`) name. */
export const globMatches = (
  globs: readonly string[],
  paths: readonly string[]
): readonly string[] =>
  Arr.filter(paths, (path) =>
    Arr.some(globs, (glob) => globToRegExp(glob).test(path))
  );

/**
 * One glob split where it starts to use a wildcard: the literal directories before the first segment that holds one
 * (`apps/cms/seed` for `apps/cms/seed/*.json`; the file itself when there is no wildcard, and the empty string is the
 * repository root), and the segments from that one on.
 */
export const globParts = (glob: string) => {
  const segments = glob.split("/");
  const literal = Arr.takeWhile(segments, (segment) => !segment.includes("*"));

  return {
    base: Arr.join(literal, "/"),
    wildcards: Arr.drop(segments, literal.length),
  };
};

/** Where the globs reach, whatever they match: the literal directory of each one (`globParts`). */
export const globBases = (globs: readonly string[]): readonly string[] =>
  Arr.dedupe(Arr.map(globs, (glob) => globParts(glob).base));
