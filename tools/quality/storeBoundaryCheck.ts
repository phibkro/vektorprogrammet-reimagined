import { Array as Arr, Effect, FileSystem, Option, Path } from "effect";

import { importSpecifiers, resolveFrom } from "./importSpecifiers.ts";
import {
  allowances,
  coveredBy,
  globToRegExp,
  groupOf,
} from "./storeBoundary.ts";
import type { Group } from "./storeBoundary.ts";
import { workingTreePaths } from "./workingTree.ts";

export interface ImportSite {
  readonly path: string;
  readonly line: number;
  readonly specifier: string;
  readonly group: Group;
}

const sourcePattern = /\.[cm]?[jt]sx?$/u;

/**
 * The group of a module specifier written in the file `importer`. A relative specifier is also resolved against the
 * importer, so a package beside `packages/db` that writes `../../db/src/schema.ts` is found: resolved, that is
 * `packages/db/src/schema.ts`. Only the adapter is looked for in a resolved path, which names no package of its own.
 */
const groupOfImport = (
  importer: string,
  specifier: string
): Option.Option<Group> =>
  specifier.startsWith(".")
    ? Option.orElse(groupOf(specifier), () =>
        Option.filter(
          groupOf(resolveFrom(importer, specifier)),
          (group) => group === "db"
        )
      )
    : groupOf(specifier);

/** Every import, `export … from` and `import("…")` of `text` that names a restricted module. */
export const restrictedImports = (
  path: string,
  text: string
): readonly ImportSite[] =>
  Arr.flatMap(importSpecifiers(path, text), ({ line, specifier }) =>
    Option.match(groupOfImport(path, specifier), {
      onNone: () => [],
      onSome: (group): ImportSite[] => [{ group, line, path, specifier }],
    })
  );

/**
 * What is wrong with the allowances and the imports found in the repository: a restricted import that no allowance
 * covers or allows, a file that two allowances cover, and an allowance that no file needs.
 */
export const boundaryFindings = (
  paths: readonly string[],
  sites: readonly ImportSite[]
): readonly string[] => {
  const importsOf = (path: string) =>
    Arr.filter(sites, (site) => site.path === path);

  const uncovered = Arr.flatMap(sites, (site) => {
    const [only, ...others] = coveredBy(site.path);

    if (only === undefined) {
      return [
        `${site.path}:${site.line}: imports ${site.specifier} (${site.group}) and no allowance covers it`,
      ];
    }

    if (others.length === 0 && !only.allows.includes(site.group)) {
      return [
        `${site.path}:${site.line}: imports ${site.specifier} (${site.group}), which its allowance does not allow (${only.reason})`,
      ];
    }

    return [];
  });

  const overlapping = Arr.flatMap(paths, (path) =>
    coveredBy(path).length > 1
      ? [`${path}: covered by more than one allowance`]
      : []
  );

  const stale = Arr.flatMap(allowances, (allowance) =>
    Arr.flatMap(allowance.files, (glob) => {
      const pattern = globToRegExp(glob);
      const matching = Arr.filter(paths, (path) => pattern.test(path));

      const needed = Arr.some(matching, (path) =>
        Arr.some(importsOf(path), (site) =>
          allowance.allows.includes(site.group)
        )
      );

      return needed
        ? []
        : [
            `${glob}: allowance is not needed: no matching file imports ${Arr.join(allowance.allows, ", ")}`,
          ];
    })
  );

  return [...uncovered, ...overlapping, ...stale];
};

/** The source files of the working tree at `root` (tracked and untracked, not ignored) and their restricted imports. */
export const scanRepository = Effect.fn("scanRepository")(
  function* scanRepository(root: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const paths = yield* workingTreePaths(root, (file) =>
      sourcePattern.test(file)
    );

    const sites = Arr.flatten(
      yield* Effect.forEach(paths, (file) =>
        Effect.map(fs.readFileString(path.join(root, file)), (text) =>
          restrictedImports(file, text)
        )
      )
    );

    return { paths, sites };
  }
);
