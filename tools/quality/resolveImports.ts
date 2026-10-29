import {
  Array as Arr,
  Effect,
  FileSystem,
  Option,
  Result,
  String as Str,
} from "effect";
import type { PlatformError } from "effect";
import { ResolverFactory } from "oxc-resolver";
import type { NapiResolveOptions } from "oxc-resolver";

import { globMatches, placeGlob } from "./globImports.ts";
import { wildcardRefusal } from "./globWalk.ts";
import { importForms } from "./importSpecifiers.ts";
import type { ComputedImport, Specifier } from "./importSpecifiers.ts";

/**
 * What an import names, once resolved. A `file` is a path from the repository root, after symlinks. A `directory` is
 * where an `import.meta.glob` pattern reaches, from the repository root (`""` is the root itself): the literal part of
 * the pattern, whatever files it matches.
 */
export type Target =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "directory"; readonly path: string }
  | { readonly kind: "unresolved" }
  | { readonly kind: "workspace"; readonly name: string }
  | { readonly kind: "external"; readonly name: string };

/** One import: where it is written (line) and what it names. */
export interface ResolvedImport extends Specifier {
  readonly target: Target;
  /**
   * The import is a pattern of `import.meta.glob`: a `file` target is one of its matches (a module edge), and its
   * `directory` target is where it reaches (the unit rule reads that one, so a pattern is one finding however many
   * files it matches, and a pattern that matches no source file is still found).
   */
  readonly glob?: true;
}

/** The most entries that the walk of a glob's wildcards lists on disk: a glob that reaches more is not placed. */
const maxGlobEntries = 10_000;

export const workspacePrefix = "@vektorprogrammet/";

/** `effect` for `effect/rpc`, `@scope/name` for `@scope/name/sub`, `node:fs` for itself. */
export const packageNameOf = (specifier: string): string =>
  Arr.join(
    Arr.take(Str.split(specifier, "/"), Str.startsWith("@")(specifier) ? 2 : 1),
    "/"
  );

/**
 * Resolution as TypeScript and the bundler do it, from the same configuration: the `tsconfig.json` above the importing
 * file (`paths`, `extends`) and the `package.json` (`imports`, `exports`), the extensions of TypeScript including
 * declaration files, `.js` for the `.ts` beside it (`moduleResolution: nodenext`) and symbolic links followed to the real
 * file. `oxc-resolver` is Oxlint's own resolver, so the lint's `import/no-cycle` and this check read one graph.
 */
const options: NapiResolveOptions = {
  conditionNames: ["import", "types", "node", "default"],
  extensionAlias: {
    ".cjs": [".cts", ".d.cts", ".cjs"],
    ".js": [".ts", ".tsx", ".d.ts", ".js"],
    ".jsx": [".tsx", ".jsx"],
    ".mjs": [".mts", ".d.mts", ".mjs"],
  },
  extensions: [
    ".ts",
    ".tsx",
    ".mts",
    ".cts",
    ".d.ts",
    ".d.mts",
    ".d.cts",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".json",
  ],
  symlinks: true,
  tsconfig: "auto",
};

/** A relative path, or an alias that a `paths` or `imports` entry maps (`@/…`, `#/…`): it names a file of the repository or it fails. */
const mustResolve = (specifier: string): boolean =>
  Str.startsWith(".")(specifier) ||
  Str.startsWith("#/")(specifier) ||
  Str.startsWith("@/")(specifier);

/**
 * The function that resolves an import written in a file of the repository at `root`. A relative path or an alias that
 * names no file is `unresolved` (the check fails closed: an import it cannot place is not one it can approve); a
 * workspace package is `workspace` by its name; whatever resolves into `node_modules`, or does not resolve (`node:fs`,
 * `cloudflare:workers`, a bundler's virtual module) is `external`. A `?query` is not part of the path.
 */
const makeResolver = Effect.fn("makeResolver")(function* makeResolver(
  root: string
) {
  const fs = yield* FileSystem.FileSystem;
  const realRoot = yield* fs.realPath(root);
  const factory = new ResolverFactory(options);

  /** The path from the root of a file inside the repository (and not in `node_modules`), or none. */
  const inside = (absolute: string): Option.Option<string> =>
    Str.startsWith(`${realRoot}/`)(absolute) &&
    !Str.includes("/node_modules/")(absolute)
      ? Option.some(Str.slice(realRoot.length + 1)(absolute))
      : Option.none();

  return (importer: string, { specifier }: Specifier): Target => {
    const request = Str.replace(/\?.*$/u, "")(specifier);

    if (Str.startsWith(workspacePrefix)(request)) {
      return {
        kind: "workspace",
        name: Str.slice(workspacePrefix.length)(packageNameOf(request)),
      };
    }

    const { path } = factory.resolveFileSync(
      `${realRoot}/${importer}`,
      request
    );

    const resolved = Option.fromNullishOr(path);
    const file = Option.flatMap(resolved, inside);

    if (Option.isSome(file)) {
      return { kind: "file", path: file.value };
    }

    // A path that reaches into `node_modules` (a JSON file of a package) is another package's; one that leaves the
    // repository, or names nothing, is not a file that the check can place.
    const installed = Option.exists(resolved, (found) =>
      Str.includes("/node_modules/")(found)
    );

    return mustResolve(request) && !installed
      ? { kind: "unresolved" }
      : { kind: "external", name: packageNameOf(request) };
  };
});

/** The text of a source file, its imports resolved, and the loads of modules that no check can read. */
export interface SourceFile {
  readonly path: string;
  readonly imports: readonly ResolvedImport[];
  /** An `import(…)` or `import.meta.glob(…)` that names its modules by an expression, or a pattern that cannot be placed. */
  readonly computed: readonly ComputedImport[];
  /** The text of the file, for the declared tolerated calls (`integrationCalls`). */
  readonly text: string;
  /** The file is a symbolic link: its imports are read at the link's place, and TypeScript reads the real file's. */
  readonly symlink: boolean;
}

/** One pattern of an `import.meta.glob`, placed at the directory it starts in with the files it names, or why not. */
type Placement = Result.Result<
  { readonly directory: string; readonly matches: readonly string[] },
  string
>;

/**
 * Reads the files `paths` (from the repository root `root`), their imports, and what each import names. A literal
 * `import.meta.glob` pattern is an import of every file among `paths` that it matches, and of the directory that its
 * literal part names (a pattern of `.json` files reaches into a unit though no scanned source matches it); a pattern
 * that cannot be placed joins the loads that no check can read. A glob is placed only when it is of the closed grammar
 * of `parseGlob` and its directory and what it reaches are plain (`place`); anything else is a finding.
 */
export const readSources = Effect.fn("readSources")(function* readSources(
  root: string,
  paths: readonly string[],
  limits: { readonly maxGlobEntries?: number } = {}
) {
  const fs = yield* FileSystem.FileSystem;
  const realRoot = yield* fs.realPath(root);
  const resolve = yield* makeResolver(root);

  /**
   * Why `directory` (from the root) is not plain, or none when it is: each of its segments is looked at with `lstat`, so a
   * symbolic link is refused whether or not its target exists, a segment that is not there at all is refused (an absent
   * directory cannot be placed, and a link may be put in its place), and so is a segment that is another kind of file (a
   * regular file is not a directory).
   */
  const directoryRefusal = (directory: string) =>
    Effect.gen(function* inspectDirectory() {
      const names = Arr.filter(
        Str.split(directory, "/"),
        (name) => name !== ""
      );

      for (const length of Arr.makeBy(names.length, (index) => index + 1)) {
        const segment = Arr.join(Arr.take(names, length), "/");
        const info = yield* Effect.option(fs.lstat(`${root}/${segment}`));

        if (Option.isNone(info)) {
          return Option.some(`its directory ${segment} does not exist`);
        }

        if (info.value.type === "SymbolicLink") {
          return Option.some(
            `a symbolic link (${segment}) is in its directory`
          );
        }

        if (info.value.type !== "Directory") {
          return Option.some(`its directory ${segment} is not a directory`);
        }
      }

      return Option.none<string>();
    });

  /**
   * Places one pattern of an `import.meta.glob`, or says why not. The check does not model Vite's matcher: a pattern is
   * placed only when it is of the closed grammar of `parseGlob`, its directory exists and holds no symbolic link, dangling or
   * not (so the real directory is the one written), and the walk of what it can reach (`wildcardRefusal`) meets no link and no
   * `node_modules` and reads no more than `maxGlobEntries` entries.
   */
  const place = Effect.fn("placePattern")(function* placePattern(
    file: string,
    pattern: string
  ): Effect.fn.Return<
    Placement,
    PlatformError.PlatformError,
    FileSystem.FileSystem
  > {
    const written = placeGlob(file, pattern);

    if (Result.isFailure(written)) {
      return Result.fail(written.failure);
    }

    const { directory, glob } = written.success;

    const unplain = yield* directoryRefusal(directory);

    if (Option.isSome(unplain)) {
      return Result.fail(unplain.value);
    }

    const refused = yield* wildcardRefusal(
      root,
      directory,
      glob,
      limits.maxGlobEntries ?? maxGlobEntries
    );

    return Option.isSome(refused)
      ? Result.fail(refused.value)
      : Result.succeed({
          directory,
          matches: globMatches(directory, glob, paths),
        });
  });

  return yield* Effect.forEach(paths, (file) =>
    Effect.gen(function* readSource() {
      const text = yield* fs.readFileString(`${root}/${file}`);
      const real = yield* fs.realPath(`${root}/${file}`);
      const forms = importForms(file, text);

      const globbed = yield* Effect.forEach(forms.globs, ({ line, patterns }) =>
        Effect.map(
          Effect.forEach(patterns, (pattern) =>
            Effect.map(place(file, pattern), (placed) => ({ pattern, placed }))
          ),
          (placed) => ({ line, placed })
        )
      );

      return {
        computed: [
          ...forms.computed,
          ...Arr.flatMap(globbed, ({ line, placed }) =>
            Arr.flatMap(placed, ({ pattern, placed: outcome }) =>
              Result.isFailure(outcome)
                ? [
                    {
                      line,
                      reason: outcome.failure,
                      text: `import.meta.glob("${pattern}")`,
                    },
                  ]
                : []
            )
          ),
        ],
        imports: [
          ...Arr.map(forms.specifiers, (found): ResolvedImport => ({
            ...found,
            target: resolve(file, found),
          })),
          ...Arr.flatMap(globbed, ({ line, placed }) =>
            Arr.flatMap(placed, ({ pattern, placed: outcome }) =>
              Result.isFailure(outcome)
                ? []
                : [
                    {
                      glob: true,
                      line,
                      specifier: pattern,
                      target: {
                        kind: "directory",
                        path: outcome.success.directory,
                      },
                    } satisfies ResolvedImport,
                    ...Arr.map(
                      outcome.success.matches,
                      (match): ResolvedImport => ({
                        glob: true,
                        line,
                        specifier: pattern,
                        target: { kind: "file", path: match },
                      })
                    ),
                  ]
            )
          ),
        ],
        path: file,
        symlink: real !== `${realRoot}/${file}`,
        text,
      } satisfies SourceFile;
    })
  );
});
