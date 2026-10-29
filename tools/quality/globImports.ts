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

/** The pattern as a path from the repository root, or none when it climbs out of the repository. */
const fromRoot = (importer: string, pattern: string): Option.Option<string> =>
  Option.map(
    Arr.reduce(
      pattern.split("/"),
      Option.some(Arr.dropRight(importer.split("/"), 1)),
      (parts, segment) =>
        Option.flatMap(parts, (names) => {
          if (segment === ".") {
            return Option.some(names);
          }

          return segment === ".."
            ? Option.liftPredicate(
                Arr.dropRight(names, 1),
                () => names.length > 0
              )
            : Option.some(Arr.append(names, segment));
        })
    ),
    (names) => Arr.join(names, "/")
  );

/** Glob syntax beyond `*`, `**` and `{a,b}`: classes, extended groups and `?`, which the matcher does not read. */
const unsupported = /[()?[\]]/u;

/**
 * The patterns written in `importer` (the argument of `import.meta.glob`), each as a path-from-the-root glob with its
 * braces expanded; none when the pattern cannot be placed (a root-relative or aliased pattern, glob syntax that the
 * matcher does not read, a path out of the repository). A `!` pattern only removes files from the others, so it
 * places none.
 */
const placed = (
  importer: string,
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
    Arr.map(expandBraces(pattern), (expanded) => fromRoot(importer, expanded))
  );
};

/** The files among `paths` (paths from the repository root) that the pattern names; none when it cannot be placed. */
export const globMatches = (
  importer: string,
  pattern: string,
  paths: readonly string[]
): Option.Option<readonly string[]> =>
  Option.map(placed(importer, pattern), (globs) =>
    Arr.filter(paths, (path) =>
      Arr.some(globs, (glob) => globToRegExp(glob).test(path))
    )
  );

/**
 * Where the pattern reaches, whatever it matches: the literal part of each brace alternative, the directories before
 * the first segment that holds a wildcard (`apps/cms/seed` for `../../../cms/seed/*.json` written in `apps/web/src/x.ts`),
 * or the file itself when there is no wildcard. The empty string is the repository root. None when the pattern cannot
 * be placed.
 */
export const globBases = (
  importer: string,
  pattern: string
): Option.Option<readonly string[]> =>
  Option.map(placed(importer, pattern), (globs) =>
    Arr.dedupe(
      Arr.map(globs, (glob) =>
        Arr.join(
          Arr.takeWhile(glob.split("/"), (segment) => !segment.includes("*")),
          "/"
        )
      )
    )
  );
