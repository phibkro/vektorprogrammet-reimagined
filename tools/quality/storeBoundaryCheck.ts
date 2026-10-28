import {
  Array as Arr,
  Effect,
  FileSystem,
  Option,
  Path,
  Predicate,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { parseSync } from "oxc-parser";

import {
  allowances,
  coveredBy,
  globToRegExp,
  groupOf,
} from "./storeBoundary.ts";
import type { Group } from "./storeBoundary.ts";

export interface ImportSite {
  readonly path: string;
  readonly line: number;
  readonly specifier: string;
  readonly group: Group;
}

const sourcePattern = /\.[cm]?[jt]sx?$/u;

const stringLiteral = /^(?<quote>["'`])(?<value>[^"'`$]*)\k<quote>$/u;

/** The specifier of an `import(…)` whose argument is a plain string; a computed one is not a specifier the lint can read. */
const literalOf = (argument: string): Option.Option<string> =>
  Option.fromNullishOr(stringLiteral.exec(argument.trim())?.groups?.value);

/** Every import, `export … from` and `import("…")` of `text` that names a restricted module. */
export const restrictedImports = (
  path: string,
  text: string
): readonly ImportSite[] => {
  const { module } = parseSync(path, text);
  const lineOf = (offset: number) => text.slice(0, offset).split("\n").length;

  const requests = [
    ...Arr.map(module.staticImports, ({ moduleRequest }) => moduleRequest),
    ...Arr.flatMap(module.staticExports, ({ entries }) =>
      Arr.flatMap(entries, ({ moduleRequest }) =>
        Predicate.isNotNull(moduleRequest) ? [moduleRequest] : []
      )
    ),
    ...Arr.flatMap(module.dynamicImports, ({ moduleRequest }) =>
      Option.match(
        literalOf(text.slice(moduleRequest.start, moduleRequest.end)),
        {
          onNone: () => [],
          onSome: (value) => [{ ...moduleRequest, value }],
        }
      )
    ),
  ];

  return Arr.flatMap(requests, (request) =>
    Option.match(groupOf(request.value), {
      onNone: () => [],
      onSome: (group): ImportSite[] => [
        { group, line: lineOf(request.start), path, specifier: request.value },
      ],
    })
  );
};

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
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const listing = yield* spawner.string(
      ChildProcess.make("git", [
        "-C",
        root,
        "ls-files",
        "-c",
        "-o",
        "--exclude-standard",
      ])
    );

    // `git ls-files -c` also lists tracked files deleted from the working tree; only files present on disk are scanned.
    const paths = Arr.flatten(
      yield* Effect.forEach(
        Arr.filter(
          listing.split(/\r?\n/u),
          (file) => file !== "" && sourcePattern.test(file)
        ),
        (file) =>
          Effect.map(
            fs.exists(path.join(root, file)),
            (exists): readonly string[] => (exists ? [file] : [])
          )
      )
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
