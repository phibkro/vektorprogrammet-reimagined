import { Array as Arr, Effect, FileSystem, Option } from "effect";
import { ResolverFactory } from "oxc-resolver";
import type { NapiResolveOptions } from "oxc-resolver";

import { importSpecifiers } from "./importSpecifiers.ts";
import type { Specifier } from "./importSpecifiers.ts";

/** What an import names, once resolved. A `file` is a path from the repository root, after symlinks. */
export type Target =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "unresolved" }
  | { readonly kind: "workspace"; readonly name: string }
  | { readonly kind: "external"; readonly name: string };

/** One import: where it is written (line) and what it names. */
export interface ResolvedImport extends Specifier {
  readonly target: Target;
}

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

/** The text of a source file and its imports, resolved. */
export interface SourceFile {
  readonly path: string;
  readonly imports: readonly ResolvedImport[];
  /** The text of the file, for the declared tolerated calls (`integrationCalls`). */
  readonly text: string;
  /** The file is a symbolic link: its imports are read at the link's place, and TypeScript reads the real file's. */
  readonly symlink: boolean;
}

/** Reads the files `paths` (from the repository root `root`), their imports, and what each import names. */
export const readSources = Effect.fn("readSources")(function* readSources(
  root: string,
  paths: readonly string[]
) {
  const fs = yield* FileSystem.FileSystem;
  const realRoot = yield* fs.realPath(root);
  const resolve = yield* makeResolver(root);

  return yield* Effect.forEach(paths, (file) =>
    Effect.gen(function* readSource() {
      const text = yield* fs.readFileString(`${root}/${file}`);
      const real = yield* fs.realPath(`${root}/${file}`);

      return {
        imports: Arr.map(
          importSpecifiers(file, text),
          (found): ResolvedImport => ({
            ...found,
            target: resolve(file, found),
          })
        ),
        path: file,
        symlink: real !== `${realRoot}/${file}`,
        text,
      } satisfies SourceFile;
    })
  );
});
