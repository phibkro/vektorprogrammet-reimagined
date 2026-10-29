import { Array as Arr, Option, Result } from "effect";

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
 * The one pattern that the check places, as a grammar and not as a model of Vite's matcher: `./` or one or more `../`;
 * literal directories of letters, digits, `_` and `-` (so no `.` or `..` segment and no wildcard); optionally one `**\/`;
 * and a last segment `*.ext` or `*.{ext,ext}` with `ext` letters and digits. Nothing else is read: no other brace, no
 * range, no `?`, `[]`, `()`, `!`, no backslash, no `base`.
 */
const grammar =
  /^(?<directory>(?:\.\/|(?:\.\.\/)+)(?:[A-Za-z0-9_-]+\/)*)(?<deep>\*\*\/)?\*\.(?:(?<one>[A-Za-z0-9]+)|\{(?<many>[A-Za-z0-9]+(?:,[A-Za-z0-9]+)*)\})$/u;

/** A pattern of the grammar: the directory it starts in (from the importer's), whether it descends, and the extensions. */
export interface Glob {
  readonly directory: string;
  readonly deep: boolean;
  readonly extensions: readonly string[];
}

/** The pattern as a `Glob`, or why the check does not place it. */
const parseGlob = (pattern: string): Result.Result<Glob, string> => {
  if (Arr.contains(pattern.split("/"), "node_modules")) {
    return Result.fail("a segment of its pattern is node_modules");
  }

  const found = grammar.exec(pattern)?.groups;

  if (found?.directory === undefined) {
    return Result.fail(
      `its pattern ${pattern} is not ./ or ../, literal directories of letters, digits, _ and -, an optional **/, and *.ext or *.{ext,ext}`
    );
  }

  return Result.succeed({
    deep: found.deep !== undefined,
    directory: found.directory,
    extensions: (found.one ?? found.many ?? "").split(","),
  });
};

/** The pattern written in `importer`, as a `Glob` and the directory it starts in (from the repository root: `""` is the root itself), or why the check does not place it. */
export const placeGlob = (
  importer: string,
  pattern: string
): Result.Result<
  { readonly glob: Glob; readonly directory: string },
  string
> => {
  if (pattern.startsWith("!")) {
    return Result.fail("a negated pattern is not read");
  }

  return Result.flatMap(parseGlob(pattern), (glob) =>
    Option.match(walk(Arr.dropRight(importer.split("/"), 1), glob.directory), {
      onNone: () => Result.fail("its pattern leaves the repository"),
      onSome: (names) =>
        Result.succeed({ directory: Arr.join(names, "/"), glob }),
    })
  );
};

/** The files among `paths` (paths from the repository root) that the glob, placed at `directory`, names. */
export const globMatches = (
  directory: string,
  { deep, extensions }: Glob,
  paths: readonly string[]
): readonly string[] =>
  Arr.filter(paths, (path) => {
    const inside = directory === "" || path.startsWith(`${directory}/`);
    const rest = path.slice(directory === "" ? 0 : directory.length + 1);

    return (
      inside &&
      (deep || !rest.includes("/")) &&
      Arr.some(extensions, (extension) => rest.endsWith(`.${extension}`))
    );
  });
