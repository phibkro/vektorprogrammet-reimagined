import { Array as Arr, Effect, Order, Schema } from "effect";
import type { Scope } from "effect";
import { isStringLiteralLikeNode } from "typescript-7-1/ast/is";
import { API } from "typescript-7-1/sync";
import type { Program, ResolvedModule } from "typescript-7-1/sync";

import { importForms } from "./importSpecifiers.ts";
import { packageNameOf, workspacePrefix } from "./resolveImports.ts";
import type { SourceFile, Target } from "./resolveImports.ts";

/**
 * Spec 0023 (spike). The import edges of the files of one `tsconfig.json`, as the TypeScript 7.1 compiler resolves them:
 * `Program.getResolvedModuleFromModuleSpecifier` for each module specifier that the compiler's own binder found in a file
 * (`SourceFile.imports`, the list that `tsc` resolves from, and `moduleAugmentations`). The package is the beta of
 * `typescript` 7.1 installed under the alias `typescript-7-1` in this tool only; the repository's compiler stays 7.0.2.
 */

/** What the compiler resolved a specifier to. A `file` is a path from the repository root, after symlinks. */
export type CompilerTarget =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "external"; readonly path: string }
  | { readonly kind: "unresolved" };

/** One module specifier of a source file, with the line (from 1) it is written on and what the compiler made of it. */
export interface CompilerEdge {
  readonly path: string;
  readonly line: number;
  readonly specifier: string;
  readonly target: CompilerTarget;
}

export class CompilerEdgesFailed extends Schema.TaggedError<
  CompilerEdgesFailed,
  { readonly brand: unique symbol }
>()("CompilerEdgesFailed", {
  cause: Schema.Defect(),
  step: Schema.String,
}) {}

/** The compiler API is synchronous and throws; every call of it is a step that names itself in the failure. */
const step = <A>(name: string, run: () => A) =>
  Effect.try({
    catch: (cause) => new CompilerEdgesFailed({ cause, step: name }),
    try: run,
  });

const relativeTo = (root: string, absolute: string): string | undefined =>
  absolute.startsWith(`${root}/`) ? absolute.slice(root.length + 1) : undefined;

/** What `Program.getResolvedModuleFromModuleSpecifier` answered, as a target. */
const targetOf = (
  root: string,
  resolved: ResolvedModule | undefined
): CompilerTarget => {
  if (resolved === undefined) {
    return { kind: "unresolved" };
  }

  const inside = relativeTo(root, resolved.resolvedFileName);

  return resolved.isExternalLibraryImport === true ||
    inside === undefined ||
    inside.includes("node_modules/")
    ? { kind: "external", path: resolved.resolvedFileName }
    : { kind: "file", path: inside };
};

/**
 * The edges of every file that the program holds under `root` and outside `node_modules` (the files of the tsconfig, and
 * the files of the repository that they import). `root` is the real path of the repository root. A resolution into
 * `node_modules`, or a declaration file that the compiler marks as an external library, is `external`.
 */
const edgesOf = (program: Program, root: string): readonly CompilerEdge[] =>
  Arr.flatMap(program.getSourceFileNames(), (fileName) => {
    const path = relativeTo(root, fileName);

    // The syntax tree of a library or `node_modules` file is never fetched: it is most of the program's files.
    if (path === undefined || path.includes("node_modules/")) {
      return [];
    }

    const file = program.getSourceFile(fileName);

    if (file === undefined) {
      return [];
    }

    return Arr.flatMap(
      [...file.imports, ...file.moduleAugmentations],
      (node): readonly CompilerEdge[] =>
        isStringLiteralLikeNode(node)
          ? [
              {
                line:
                  file.getLineAndCharacterOfPosition(node.getStart(file)).line +
                  1,
                path,
                specifier: node.getText(file).slice(1, -1),
                target: targetOf(
                  root,
                  program.getResolvedModuleFromModuleSpecifier(
                    node,
                    file.fileName
                  )
                ),
              },
            ]
          : []
    );
  });

/**
 * The edges of the files of `tsconfig` (an absolute path) in the repository at `root` (its real path). Opens the
 * compiler process and the program in the caller's scope; both are closed with it.
 */
export const compilerEdges = Effect.fn("compilerEdges")(function* compilerEdges(
  root: string,
  tsconfig: string
): Effect.fn.Return<readonly CompilerEdge[], CompilerEdgesFailed, Scope.Scope> {
  const api = yield* Effect.acquireRelease(
    step("API", () => new API({ cwd: root })),
    (opened) =>
      Effect.sync(() => {
        opened.close();
      })
  );

  const program = yield* Effect.acquireRelease(
    step("createProgram", () => {
      const parsed = api.parseConfigFile(tsconfig);

      return api.createProgram(parsed.fileNames, parsed.options);
    }),
    (opened) =>
      Effect.sync(() => {
        opened.dispose();
      })
  );

  return yield* step("edges", () => edgesOf(program, root));
});

interface Placed {
  readonly path: string;
  readonly line: number;
  readonly specifier: string;
}

/** The place of an import, as a finding names it. */
const placeOf = ({ line, path, specifier }: Placed): string =>
  `${path}:${line} ${specifier}`;

/** `oxc-resolver`'s reading of an import, in the words of the comparison. */
const oxcWords = (target: Target): string => {
  if (target.kind === "file") {
    return `file ${target.path}`;
  }

  return target.kind === "workspace" ? `workspace ${target.name}` : target.kind;
};

/**
 * The compiler's reading of an edge, in the same words. The resolver of the check does not look inside `node_modules`
 * or at workspace packages (a name that starts with `@vektorprogrammet/` is the package's name, whatever file the
 * compiler lands on), and it calls a bare specifier that resolves to nothing (`cloudflare:workers`, a bundler's virtual
 * module) `external`; the compiler calls it unresolved. Those three are the same answer.
 */
const compilerWords = ({ specifier, target }: CompilerEdge): string => {
  if (specifier.startsWith(workspacePrefix)) {
    return `workspace ${packageNameOf(specifier).slice(workspacePrefix.length)}`;
  }

  if (target.kind === "file") {
    return `file ${target.path}`;
  }

  return target.kind === "unresolved" && specifier.startsWith(".")
    ? "unresolved"
    : "external";
};

/** What differs at one place: both readings, or the one that is missing. */
const differenceAt = (
  place: string,
  ours: string | undefined,
  theirs: readonly string[]
): readonly string[] => {
  if (ours === undefined) {
    return [
      `${place}: the check has no such import; the compiler: ${Arr.join(theirs, " | ")}`,
    ];
  }

  if (Arr.isReadonlyArrayEmpty(theirs)) {
    return [`${place}: the compiler has no such import; the check: ${ours}`];
  }

  return theirs.includes(ours)
    ? []
    : [
        `${place}: the check: ${ours}; the compiler: ${Arr.join(theirs, " | ")}`,
      ];
};

/**
 * Where the two readings of the same files disagree, one finding per place (`path:line specifier`), sorted: an import
 * that only one of them saw, and an import that the check places in a different file or category. Empty when they
 * agree. `ours` is limited to the files that `theirs` covers, and a pattern of `import.meta.glob` (which the compiler
 * does not read) is left out. An import that one of them lists twice at one place (`export { a, b } from "./x"`: the
 * check has one entry per exported name, the compiler one per statement) counts once.
 */
export const edgeDifferences = (
  ours: readonly SourceFile[],
  theirs: readonly CompilerEdge[]
): readonly string[] => {
  const compiler = new Map<string, string[]>();

  for (const edge of theirs) {
    compiler.set(placeOf(edge), [
      ...(compiler.get(placeOf(edge)) ?? []),
      compilerWords(edge),
    ]);
  }

  const covered = new Set(Arr.map(theirs, ({ path }) => path));
  const check = new Map<string, string>();

  for (const { imports, path, text } of ours) {
    const globs = new Set(
      Arr.flatMap(importForms(path, text).globs, ({ line, patterns }) =>
        Arr.map(patterns, (pattern) => `${line}:${pattern}`)
      )
    );

    for (const use of imports) {
      if (covered.has(path) && !globs.has(`${use.line}:${use.specifier}`)) {
        check.set(placeOf({ ...use, path }), oxcWords(use.target));
      }
    }
  }

  return Arr.sort(
    Arr.flatMap(Arr.dedupe([...check.keys(), ...compiler.keys()]), (place) =>
      differenceAt(place, check.get(place), compiler.get(place) ?? [])
    ),
    Order.String
  );
};
