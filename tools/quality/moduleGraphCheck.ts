import {
  Array as Arr,
  Effect,
  FileSystem,
  Option,
  Order,
  Path,
  Record as Rec,
} from "effect";

import { importSpecifiers, resolveFrom } from "./importSpecifiers.ts";
import type { Specifier } from "./importSpecifiers.ts";
import { layerRank } from "./moduleGraph.ts";
import type { Declaration, Module, Unit } from "./moduleGraph.ts";
import { globToRegExp } from "./storeBoundary.ts";
import { workingTreePaths } from "./workingTree.ts";

export interface SourceFile {
  readonly path: string;
  readonly imports: readonly Specifier[];
  /** The text of the file, for the declared tolerated calls (`integrationCalls`). */
  readonly text: string;
}

const sourcePattern = /\.[cm]?[jt]sx?$/u;

/** What the check reads: every source file under `packages/`, `apps/` and `tools/`, whatever its extension. */
const isScanned = (path: string): boolean =>
  sourcePattern.test(path) && /^(?:packages|apps|tools)\//u.test(path);

type Target =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "unresolved" }
  | { readonly kind: "workspace"; readonly name: string }
  | { readonly kind: "external"; readonly name: string };

/** One import, with the file it is written in and what it names. */
interface Use extends Specifier {
  readonly path: string;
  readonly target: Target;
}

/** A broken rule. `from` and `to` are the ends of the `Tolerated` entry that covers it. */
interface Violation {
  readonly from: string;
  readonly to: string;
  readonly text: string;
}

/** An import that leaves its unit: by the package's name (`name`) or by a path into it (`path`). */
interface UnitEdge {
  readonly from: Unit;
  readonly reach: "name" | "path";
  /** None when the name is no unit of the declaration. */
  readonly to: Option.Option<Unit>;
  readonly use: Use;
}

const workspacePrefix = "@vektorprogrammet/";

const site = (use: Use): string => `${use.path}:${use.line}`;

/** `effect` for `effect/rpc`, `@scope/name` for `@scope/name/sub`, `node:fs` for itself. */
const packageNameOf = (specifier: string): string =>
  Arr.join(
    Arr.take(specifier.split("/"), specifier.startsWith("@") ? 2 : 1),
    "/"
  );

const baseName = (root: string): string =>
  root.slice(root.lastIndexOf("/") + 1);

const unitOf = (units: readonly Unit[], path: string): Option.Option<Unit> =>
  Arr.findFirst(units, ({ root }) => path.startsWith(`${root}/`));

const unitNamed = (units: readonly Unit[], name: string): Option.Option<Unit> =>
  Arr.findFirst(units, ({ root }) => baseName(root) === name);

const sourceExtensions = [".ts", ".tsx", ".mts", ".cts"] as const;

/**
 * The extension that the importer wrote for the file it names, under `moduleResolution: nodenext`: a specifier that
 * ends `.js` names the `.ts` (or `.tsx`) file beside it, `.mjs` the `.mts`, `.cjs` the `.cts`.
 */
const swaps = {
  ".cjs": [".cts"],
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
} as const;

/** `.json`, `.css` and the like: a file that is not source, so no scan lists it and no module rule applies to it. */
const dataFile = /\.(?!(?:[cm]?[jt]sx?)$)[a-z0-9]+$/iu;

const scannedRoot = /^(?:packages|apps|tools)\//u;

/** The scanned file that the path of a relative import names, a data file as itself, or `unresolved`. */
const resolveRelative = (
  paths: ReadonlySet<string>,
  resolved: string
): Target => {
  const dot = resolved.lastIndexOf(".");
  const extension = dot > resolved.lastIndexOf("/") ? resolved.slice(dot) : "";

  const stem =
    dot > resolved.lastIndexOf("/") ? resolved.slice(0, dot) : resolved;

  const found = Arr.findFirst(
    [
      resolved,
      ...Arr.flatMap(Rec.toEntries(swaps), ([from, swapExtensions]) =>
        from === extension
          ? Arr.map(swapExtensions, (ext) => `${stem}${ext}`)
          : []
      ),
      ...Arr.map(sourceExtensions, (ext) => `${resolved}${ext}`),
      ...Arr.map(sourceExtensions, (ext) => `${resolved}/index${ext}`),
    ],
    (candidate) => paths.has(candidate)
  );

  if (Option.isSome(found)) {
    return { kind: "file", path: found.value };
  }

  // A data file, and a file outside the directories that the scan reads (the root `vite.config.ts`), is a plain file.
  return dataFile.test(resolved) || !scannedRoot.test(resolved)
    ? { kind: "file", path: resolved }
    : { kind: "unresolved" };
};

const targetOf = (
  paths: ReadonlySet<string>,
  importer: string,
  { specifier }: Specifier
): Target => {
  if (specifier.startsWith(".")) {
    // A bundler query (`styles.css?url`) is not part of the path.
    return resolveRelative(
      paths,
      resolveFrom(importer, specifier.replace(/\?.*$/u, ""))
    );
  }

  const name = packageNameOf(specifier);

  return name.startsWith(workspacePrefix)
    ? { kind: "workspace", name: name.slice(workspacePrefix.length) }
    : { kind: "external", name };
};

const owns = (module: Module, path: string): boolean =>
  Arr.some(module.files, (glob) => globToRegExp(glob).test(path)) &&
  !Arr.contains(module.except ?? [], path);

const moduleOf = (
  modules: readonly Module[],
  path: string
): Option.Option<Module> =>
  Arr.findFirst(modules, (module) => owns(module, path));

/**
 * The components of the directed graph on `nodes` with `edges` in which every node reaches every other (more than one
 * node), each as a sorted list. (A file that imports itself is not reported.) `effect/Graph` has a function for this,
 * but it is an unstable API that the repository's policy would need a registered exception for, and the graphs here
 * have a few hundred nodes.
 */
const cycles = (
  nodes: readonly string[],
  edges: readonly (readonly [string, string])[]
): readonly (readonly string[])[] => {
  const successors = new Map<string, string[]>();

  for (const [from, to] of edges) {
    successors.set(from, [...(successors.get(from) ?? []), to]);
  }

  const reach = (start: string): ReadonlySet<string> => {
    const seen = new Set<string>();
    const pending = [start];

    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      for (const successor of successors.get(next) ?? []) {
        if (!seen.has(successor)) {
          seen.add(successor);
          pending.push(successor);
        }
      }
    }

    return seen;
  };

  const distinct = Arr.sort(Arr.dedupe(nodes), Order.String);

  const reached = new Map(
    Arr.map(distinct, (node): [string, ReadonlySet<string>] => [
      node,
      reach(node),
    ])
  );

  const mutually = (a: string, b: string): boolean =>
    a === b ||
    (reached.get(a)?.has(b) === true && reached.get(b)?.has(a) === true);

  return Arr.dedupeWith(
    Arr.filter(
      Arr.map(distinct, (node) =>
        Arr.filter(distinct, (other) => mutually(node, other))
      ),
      (component) => component.length > 1
    ),
    (a, b) => a[0] === b[0]
  );
};

/** What is wrong with the declaration itself: unknown names, layers, cycles in `uses`, files without an owner or with two. */
const declarationFindings = (
  { governed, modules }: Declaration,
  governedPaths: readonly string[]
): readonly string[] => {
  const names = Arr.map(modules, ({ name }) => name);

  const declared = Arr.flatMap(modules, (module) =>
    module.uses === "all"
      ? []
      : Arr.map(module.uses, (used) => ({ module, used }))
  );

  const unknown = Arr.flatMap(declared, ({ module, used }) =>
    Arr.contains(names, used)
      ? []
      : [`module ${module.name} uses ${used}, which is not a module`]
  );

  const wrongLayer = Arr.flatMap(declared, ({ module, used }) =>
    Option.match(
      Arr.findFirst(modules, ({ name }) => name === used),
      {
        onNone: () => [],
        onSome: (target) =>
          layerRank[target.layer] > layerRank[module.layer]
            ? [
                `module ${module.name} (${module.layer}) declares ${used} (${target.layer}), a higher layer: a module uses its own layer and the ones below`,
              ]
            : [],
      }
    )
  );

  const declaredCycles = Arr.map(
    cycles(
      names,
      Arr.map(declared, ({ module, used }): [string, string] => [
        module.name,
        used,
      ])
    ),
    (component) =>
      `the declared graph has a cycle between modules ${Arr.join(component, ", ")}`
  );

  const ownership = Arr.flatMap(governedPaths, (path) => {
    if (!path.endsWith(".ts")) {
      return [
        `${path}: is a source file of the governed tree (${governed}) and not a .ts file; the module globs read .ts only, so rename it`,
      ];
    }

    const owners = Arr.filter(modules, (module) => owns(module, path));

    if (owners.length === 0) {
      return [
        `${path}: belongs to no module (${governed}); list it in a module of tools/quality/moduleGraph.ts`,
      ];
    }

    return owners.length > 1
      ? [
          `${path}: belongs to more than one module (${Arr.join(
            Arr.map(owners, ({ name }) => name),
            ", "
          )})`,
        ]
      : [];
  });

  const stale = Arr.flatMap(modules, (module) =>
    Arr.flatMap(module.files, (glob) =>
      Arr.some(governedPaths, (path) => globToRegExp(glob).test(path))
        ? []
        : [`module ${module.name} lists ${glob}, which matches no file`]
    )
  );

  return [...unknown, ...wrongLayer, ...declaredCycles, ...ownership, ...stale];
};

/** One import between two modules, as the check observed it. */
interface Hop {
  readonly from: string;
  readonly to: string;
  readonly use: Use;
}

/** The chain of imports from module `start` to module `goal` with the fewest steps, or none. */
const route = (
  observed: readonly Hop[],
  start: string,
  goal: string
): Option.Option<readonly Hop[]> => {
  const reached = new Map<string, readonly Hop[]>([[start, []]]);
  let frontier = [start];

  while (frontier.length > 0 && !reached.has(goal)) {
    const next: string[] = [];

    for (const name of frontier) {
      for (const edge of observed) {
        if (edge.from === name && !reached.has(edge.to)) {
          reached.set(edge.to, [...(reached.get(name) ?? []), edge]);
          next.push(edge.to);
        }
      }
    }

    frontier = next;
  }

  return Option.fromNullishOr(reached.get(goal));
};

/**
 * What is wrong with the imports of `files` (and with the declaration). Rules, as ADR 0015 section 5 numbers them:
 *
 * 1. every file of `governed` belongs to exactly one module;
 * 2. an import of another module is in the importer's `uses` and does not point to a higher layer;
 * 3. the declared graph has no cycle, and no file imports a cycle with another in `acyclic`;
 * 4. a declared `uses` entry that no file needs fails;
 * 5. a module imports `effect` and the packages of its row, and no other;
 * 6. a unit imports the packages it declares, by their name, and a file belongs to a unit;
 * 7. a broken rule is allowed only when `baseline` lists it, and an entry that no import needs fails.
 */
export const moduleGraphFindings = (
  declaration: Declaration,
  files: readonly SourceFile[]
): readonly string[] => {
  const { acyclic, baseline, governed, integrationCalls, modules, units } =
    declaration;

  const paths = new Set(Arr.map(files, ({ path }) => path));
  const governedPattern = globToRegExp(governed);
  const isGoverned = (path: string): boolean => governedPattern.test(path);

  const uses: readonly Use[] = Arr.flatMap(files, ({ imports, path }) =>
    Arr.map(imports, (specifier) => ({
      ...specifier,
      path,
      target: targetOf(paths, path, specifier),
    }))
  );

  // An import that resolves to no source file fails; the others are edges.
  const unresolved = Arr.flatMap(uses, (use): Violation[] =>
    use.target.kind === "unresolved"
      ? [
          {
            from: use.path,
            text: `${site(use)}: imports ${use.specifier}, which resolves to no source file (the check fails closed: an import it cannot place is not one it can approve)`,
            to: use.specifier,
          },
        ]
      : []
  );

  const observed = Arr.flatMap(uses, (use) => {
    if (!isGoverned(use.path) || use.target.kind !== "file") {
      return [];
    }

    const from = moduleOf(modules, use.path);
    const to = moduleOf(modules, use.target.path);

    return Option.isSome(from) &&
      Option.isSome(to) &&
      from.value.name !== to.value.name
      ? [{ from: from.value, to: to.value, use }]
      : [];
  });

  const names = Arr.map(observed, ({ from, to, use }) => ({
    from: from.name,
    to: to.name,
    use,
  }));

  const moduleViolations = Arr.flatMap(
    observed,
    ({ from, to, use }): Violation[] => {
      const target = use.target.kind === "file" ? use.target.path : "";
      const where = `${site(use)}: imports ${target} (module ${to.name}, ${to.layer})`;

      if (layerRank[to.layer] > layerRank[from.layer]) {
        return [
          {
            from: use.path,
            text: `${where}, an upward import from module ${from.name} (${from.layer})`,
            to: target,
          },
        ];
      }

      if (from.uses === "all" || Arr.contains(from.uses, to.name)) {
        return [];
      }

      const closing = Option.match(route(names, to.name, from.name), {
        onNone: () => "",
        onSome: (chain) =>
          `; it closes a cycle: ${Arr.join(
            Arr.map(
              chain,
              (hop) => `${site(hop.use)} (${hop.from} imports ${hop.to})`
            ),
            ", "
          )}`,
      });

      return [
        {
          from: use.path,
          text: `${where}, which module ${from.name} does not declare in uses${closing}`,
          to: target,
        },
      ];
    }
  );

  const externalViolations = Arr.flatMap(uses, (use) => {
    if (!isGoverned(use.path) || use.target.kind !== "external") {
      return [];
    }

    const { name } = use.target;

    return Option.match(moduleOf(modules, use.path), {
      onNone: () => [],
      onSome: (module): Violation[] =>
        name === "effect" || Arr.contains(module.packages ?? [], name)
          ? []
          : [
              {
                from: use.path,
                text: `${site(use)}: module ${module.name} imports ${use.specifier}, and a module imports only effect${Arr.match(module.packages ?? [], { onEmpty: () => "", onNonEmpty: (packages) => ` and ${Arr.join(packages, ", ")}` })}`,
                to: name,
              },
            ],
    });
  });

  // Unit edges.
  const unitless = Arr.flatMap(files, ({ path }) =>
    Option.isNone(unitOf(units, path))
      ? [
          `${path}: belongs to no unit; add its package to the units of tools/quality/moduleGraph.ts`,
        ]
      : []
  );

  const unitEdges = Arr.flatMap(uses, (use): UnitEdge[] =>
    Option.match(unitOf(units, use.path), {
      onNone: () => [],
      onSome: (from): UnitEdge[] => {
        const to =
          use.target.kind === "file"
            ? unitOf(units, use.target.path)
            : Option.none();

        if (use.target.kind === "workspace") {
          const named = unitNamed(units, use.target.name);

          return [{ from, reach: "name" as const, to: named, use }];
        }

        return Option.isSome(to) && to.value.root !== from.root
          ? [{ from, reach: "path" as const, to, use }]
          : [];
      },
    })
  );

  const unitViolations = Arr.flatMap(
    unitEdges,
    ({ from, reach, to, use }): Violation[] => {
      if (Option.isNone(to)) {
        return [
          {
            from: use.path,
            text: `${site(use)}: imports ${use.specifier}, which names no unit of tools/quality/moduleGraph.ts`,
            to: use.specifier,
          },
        ];
      }

      if (to.value.root === from.root) {
        return reach === "name"
          ? [
              {
                from: use.path,
                text: `${site(use)}: ${from.root} imports its own package by its name (${use.specifier}); a file imports its own package's files by a relative path, so that the module rules see the edge`,
                to: use.specifier,
              },
            ]
          : [];
      }

      if (reach === "path") {
        return [
          {
            from: use.path,
            text: `${site(use)}: ${from.root} reaches into ${to.value.root} by the path ${use.specifier}; import the package by its name`,
            to: to.value.root,
          },
        ];
      }

      return Arr.contains(from.uses, to.value.root)
        ? []
        : [
            {
              from: use.path,
              text: `${site(use)}: ${from.root} imports ${to.value.root}, which it does not declare in units`,
              to: to.value.root,
            },
          ];
    }
  );

  // Rule 7: the baseline covers a violation by its two ends, and covers nothing else.
  const violations = [
    ...moduleViolations,
    ...externalViolations,
    ...unitViolations,
    ...unresolved,
  ];

  const covered = (violation: Violation): boolean =>
    Arr.some(
      baseline,
      (entry) => entry.from === violation.from && entry.to === violation.to
    );

  const unlisted = Arr.flatMap(violations, (violation) =>
    covered(violation) ? [] : [violation.text]
  );

  const unneeded = Arr.flatMap(baseline, (entry) =>
    Arr.some(
      violations,
      (violation) => violation.from === entry.from && violation.to === entry.to
    )
      ? []
      : [
          `baseline: ${entry.from} -> ${entry.to} is not a broken rule any more (${entry.reason}); remove the entry`,
        ]
  );

  // Rule 4: a declared edge that no file needs.
  const idle = [
    ...Arr.flatMap(modules, (module) =>
      module.uses === "all"
        ? []
        : Arr.flatMap(module.uses, (used) =>
            Arr.some(
              observed,
              (edge) => edge.from.name === module.name && edge.to.name === used
            )
              ? []
              : [
                  `module ${module.name} declares ${used}, but no file of ${module.name} imports it; remove it from uses`,
                ]
          )
    ),
    ...Arr.flatMap(units, (unit) =>
      Arr.flatMap(unit.uses, (used) =>
        Arr.some(
          unitEdges,
          (edge) =>
            edge.reach === "name" &&
            edge.from.root === unit.root &&
            Option.exists(edge.to, (to) => to.root === used)
        )
          ? []
          : [
              `unit ${unit.root} declares ${used}, but no file of ${unit.root} imports it; remove it from units`,
            ]
      )
    ),
  ];

  // Rule 3: a cycle between files (the files the lint's `import/no-cycle` covers).
  const acyclicPaths = Arr.filter(
    Arr.map(files, ({ path }) => path),
    (path) => Arr.some(acyclic, (glob) => globToRegExp(glob).test(path))
  );

  const fileEdges = Arr.flatMap(uses, (use): [Use, string][] =>
    use.target.kind === "file" && paths.has(use.target.path)
      ? [[use, use.target.path]]
      : []
  );

  const fileCycles = Arr.map(
    cycles(
      acyclicPaths,
      Arr.map(fileEdges, ([use, target]): [string, string] => [
        use.path,
        target,
      ])
    ),
    (component) =>
      Arr.join(
        [
          `import cycle between ${component.length} files:`,
          ...Arr.sort(
            Arr.flatMap(fileEdges, ([use, target]) =>
              Arr.contains(component, use.path) &&
              Arr.contains(component, target)
                ? [`  ${site(use)} imports ${target}`]
                : []
            ),
            Order.String
          ),
        ],
        "\n"
      )
  );

  // The integration calls inside a transaction that are tolerated until their retirement trigger: each names a file
  // and a symbol that must still be there, so an entry that its code has outlived fails.
  const staleCalls = Arr.flatMap(integrationCalls, (call) =>
    Arr.some(
      files,
      ({ path, text }) => path === call.file && text.includes(call.symbol)
    )
      ? []
      : [
          `integration call: ${call.file} no longer mentions ${call.symbol} (${call.retirementTrigger}); remove the entry from integrationCalls`,
        ]
  );

  return [
    ...declarationFindings(
      declaration,
      Arr.filter(
        Arr.map(files, ({ path }) => path),
        isGoverned
      )
    ),
    ...Arr.sort(unlisted, Order.String),
    ...Arr.sort(unneeded, Order.String),
    ...Arr.sort(idle, Order.String),
    ...Arr.sort(unitless, Order.String),
    ...Arr.sort(staleCalls, Order.String),
    ...fileCycles,
  ];
};

/** The source files of the working tree at `root` (tracked and untracked, not ignored, no probe) with their imports. */
export const scanImports = Effect.fn("scanImports")(function* scanImports(
  root: string
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const paths = yield* workingTreePaths(root, isScanned);

  return yield* Effect.forEach(paths, (file) =>
    Effect.map(
      fs.readFileString(path.join(root, file)),
      (text): SourceFile => ({
        imports: importSpecifiers(file, text),
        path: file,
        text,
      })
    )
  );
});
