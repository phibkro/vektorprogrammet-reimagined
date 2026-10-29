import { Array as Arr, Effect, FileSystem, Option } from "effect";
import { ResolverFactory } from "oxc-resolver";
import type { NapiResolveOptions } from "oxc-resolver";

import {
  globBases,
  globMatches,
  globParts,
  globsOf,
  globStart,
} from "./globImports.ts";
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
export const maxGlobEntries = 10_000;

export const workspacePrefix = "@vektorprogrammet/";

/** `effect` for `effect/rpc`, `@scope/name` for `@scope/name/sub`, `node:fs` for itself. */
export const packageNameOf = (specifier: string): string =>
  Arr.join(
    Arr.take(specifier.split("/"), specifier.startsWith("@") ? 2 : 1),
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
  specifier.startsWith(".") ||
  specifier.startsWith("#/") ||
  specifier.startsWith("@/");

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
    absolute.startsWith(`${realRoot}/`) && !absolute.includes("/node_modules/")
      ? Option.some(absolute.slice(realRoot.length + 1))
      : Option.none();

  return (importer: string, { specifier }: Specifier): Target => {
    const request = specifier.replace(/\?.*$/u, "");

    if (request.startsWith(workspacePrefix)) {
      return {
        kind: "workspace",
        name: packageNameOf(request).slice(workspacePrefix.length),
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
      found.includes("/node_modules/")
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

/**
 * Reads the files `paths` (from the repository root `root`), their imports, and what each import names. A literal
 * `import.meta.glob` pattern is an import of every file among `paths` that it matches, and of the directory that its
 * literal part names (a pattern of `.json` files reaches into a unit though no scanned source matches it); a pattern
 * that cannot be placed joins the loads that no check can read. A glob is placed only when nothing about it depends on
 * how Vite expands it (`globRefusal`): none of its segments is or reaches `node_modules`, and no symbolic link is in the
 * tree that its wildcards can reach; `maxGlobEntries` bounds that walk.
 */
export const readSources = Effect.fn("readSources")(function* readSources(
  root: string,
  paths: readonly string[],
  limits: { readonly maxGlobEntries?: number } = {}
) {
  const fs = yield* FileSystem.FileSystem;
  const realRoot = yield* fs.realPath(root);
  const resolve = yield* makeResolver(root);

  /** The directory of the package that holds `file`: the nearest ancestor with a `package.json`, from the root. */
  const packageRootOf = (file: string) =>
    Effect.findFirst(
      Arr.makeBy(file.split("/").length, (depth) =>
        Arr.join(
          Arr.take(file.split("/"), file.split("/").length - 1 - depth),
          "/"
        )
      ),
      (directory) => fs.exists(`${root}/${directory}/package.json`)
    );

  /**
   * A directory (from the repository root) after symbolic links, as a plain import is placed: its longest prefix that
   * exists is made real (`apps/web/node_modules/@vektorprogrammet/domain` is `packages/domain`) and the rest is kept.
   * A directory that leaves the repository, or has no existing prefix, stays as written.
   */
  const realPathOf = (directory: string) =>
    Effect.gen(function* realDirectory() {
      const names = Arr.filter(directory.split("/"), (name) => name !== "");

      const prefix = yield* Effect.findFirst(
        Arr.makeBy(names.length + 1, (cut) => names.length - cut),
        (length) =>
          fs.exists(`${root}/${Arr.join(Arr.take(names, length), "/")}`)
      );

      if (Option.isNone(prefix)) {
        return directory;
      }

      const real = yield* fs.realPath(
        `${root}/${Arr.join(Arr.take(names, prefix.value), "/")}`
      );

      if (real !== realRoot && !real.startsWith(`${realRoot}/`)) {
        return directory;
      }

      return Arr.join(
        [
          ...(real === realRoot ? [] : [real.slice(realRoot.length + 1)]),
          ...Arr.drop(names, prefix.value),
        ],
        "/"
      );
    });

  /**
   * Why a glob (its alternatives, `globsOf`) is not placed, or none when it is. The check places a glob by its text and
   * the files that git lists; Vite places it by walking the disk, so the two agree only when the walk meets nothing that
   * the text does not say: a segment that is or reaches `node_modules` (Vite drops its ignore of it with `exhaustive`), a
   * symbolic link under a wildcard (a link is followed to another package), or more entries than the check will list.
   * The literal directories before the first wildcard may cross links: they are placed after them, as a plain import is.
   */
  const globRefusal = (globs: readonly string[]) =>
    Effect.gen(function* refuse() {
      if (
        Arr.some(globs, (glob) => Arr.contains(glob.split("/"), "node_modules"))
      ) {
        return Option.some("a segment of its pattern or base is node_modules");
      }

      const limit = limits.maxGlobEntries ?? maxGlobEntries;
      const budget = { left: limit };

      for (const glob of globs) {
        const { base, wildcards } = globParts(glob);
        const real = yield* realPathOf(base);

        if (Arr.contains(real.split("/"), "node_modules")) {
          return Option.some(
            `its base reaches node_modules (${real}) through a symbolic link`
          );
        }

        const refused = yield* wildcardRefusal(
          root,
          real,
          wildcards,
          budget,
          limit
        );

        if (Option.isSome(refused)) {
          return refused;
        }
      }

      return Option.none<string>();
    });

  return yield* Effect.forEach(paths, (file) =>
    Effect.gen(function* readSource() {
      const text = yield* fs.readFileString(`${root}/${file}`);
      const real = yield* fs.realPath(`${root}/${file}`);
      const forms = importForms(file, text);

      const globbed = yield* Effect.forEach(
        forms.globs,
        Effect.fn("placeGlob")(function* placeGlob({ base, line, patterns }) {
          // Vite's project root, for a `base` that starts with `/`: the directory of the importer's package.
          const viteRoot = Option.exists(base, (written) =>
            written.startsWith("/")
          )
            ? yield* packageRootOf(file)
            : Option.none<string>();

          const start = globStart(file, base, viteRoot);

          const placed = yield* Effect.forEach(patterns, (pattern) =>
            Effect.gen(function* placePattern() {
              const alternatives = Option.flatMap(start, (from) =>
                globsOf(from, pattern)
              );

              const refused = Option.isNone(alternatives)
                ? Option.none<string>()
                : yield* globRefusal(alternatives.value);

              // A glob that is refused adds no edge: it is a finding of its own.
              const accepted = Option.filter(alternatives, () =>
                Option.isNone(refused)
              );

              return {
                bases: Option.isNone(accepted)
                  ? accepted
                  : Option.some(
                      yield* Effect.forEach(
                        globBases(accepted.value),
                        realPathOf
                      )
                    ),
                matches: Option.map(accepted, (globs) =>
                  globMatches(globs, paths)
                ),
                pattern,
                refused,
                // How a finding names the glob: its pattern, and the `base` that it starts from when it has one.
                shown: Option.match(base, {
                  onNone: () => pattern,
                  onSome: (written) => `${pattern} (base ${written})`,
                }),
                written: Option.match(base, {
                  onNone: () => `"${pattern}"`,
                  onSome: (value) => `"${pattern}", { base: "${value}" }`,
                }),
              };
            })
          );

          return { line, placed };
        })
      );

      return {
        computed: [
          ...forms.computed,
          ...Arr.flatMap(globbed, ({ line, placed }) =>
            Arr.flatMap(placed, ({ matches, refused, written }) =>
              Option.match(refused, {
                onNone: () =>
                  Option.isNone(matches)
                    ? [{ line, text: `import.meta.glob(${written})` }]
                    : [],
                onSome: (reason) => [
                  { line, reason, text: `import.meta.glob(${written})` },
                ],
              })
            )
          ),
        ],
        imports: [
          ...Arr.map(forms.specifiers, (found): ResolvedImport => ({
            ...found,
            target: resolve(file, found),
          })),
          ...Arr.flatMap(globbed, ({ line, placed }) =>
            Arr.flatMap(placed, ({ bases, matches, shown }) => [
              ...Arr.map(
                Option.getOrElse(bases, () => []),
                (base): ResolvedImport => ({
                  glob: true,
                  line,
                  specifier: shown,
                  target: { kind: "directory", path: base },
                })
              ),
              ...Arr.map(
                Option.getOrElse(matches, () => []),
                (match): ResolvedImport => ({
                  glob: true,
                  line,
                  specifier: shown,
                  target: { kind: "file", path: match },
                })
              ),
            ])
          ),
        ],
        path: file,
        symlink: real !== `${realRoot}/${file}`,
        text,
      } satisfies SourceFile;
    })
  );
});
