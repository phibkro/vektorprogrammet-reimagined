import { Array as Arr, Option } from "effect";

import { importForms, resolveFrom } from "../../importSpecifiers.ts";
import type { Declaration, Module } from "../../moduleGraph.ts";
import { moduleGraphFindings } from "../../moduleGraphCheck.ts";
import { packageNameOf, workspacePrefix } from "../../resolveImports.ts";
import type { SourceFile, Target } from "../../resolveImports.ts";

/** The domain's source directory: the tree that the fixture's modules partition. */
export const d = "packages/domain/src";

/** The finding for a file that imports its own package by its name. */
export const own = (unit: string, name: string, line: number, path: string) =>
  `${path}:${line}: ${unit} imports its own package by its name (@vektorprogrammet/${name}); a file imports its own package's files by a relative path, so that the module rules see the edge`;

/**
 * What an import names, in a fixture: a relative path names the file that it spells (a fixture spells the extension; the
 * resolver's own cases, `.js`, `/index`, aliases, run on files on disk in `moduleGraphResolution.test.ts`), a workspace
 * package its name.
 */
const targetOf = (path: string, specifier: string): Target => {
  if (specifier.startsWith(".")) {
    return { kind: "file", path: resolveFrom(path, specifier) };
  }

  return specifier.startsWith(workspacePrefix)
    ? {
        kind: "workspace",
        name: packageNameOf(specifier).slice(workspacePrefix.length),
      }
    : { kind: "external", name: packageNameOf(specifier) };
};

/** A file as the check reads it, from the text of the file (a glob is not expanded here: the cases that need the files on disk run in a temporary repository). */
export const parsed = (path: string, content: string): SourceFile => {
  const forms = importForms(path, content);

  return {
    computed: forms.computed,
    imports: Arr.map(forms.specifiers, (found) => ({
      ...found,
      target: targetOf(path, found.specifier),
    })),
    path,
    symlink: false,
    text: content,
  };
};

/** A file with the specifiers that it imports, one per line (the first on line 1). */
export const source = (
  path: string,
  ...specifiers: readonly string[]
): SourceFile =>
  parsed(
    path,
    Arr.join(
      Arr.map(specifiers, (specifier) => `import "${specifier}";`),
      "\n"
    )
  );

const makeModule = (
  name: string,
  layer: Module["layer"],
  uses: Module["uses"],
  extra: Partial<Module> = {}
): Module => ({ files: [`${d}/${name}/*.ts`], layer, name, uses, ...extra });

/**
 * A small declaration with the shapes of ADR 0015: a vocabulary and a kernel (libraries), services that use each other
 * in one direction, a catalog above them, Privacy above the catalog and an assembly above all. Every declared edge is
 * used by `clean`, so `clean` has no finding, and each test changes one thing.
 */
export const fixture: Declaration = {
  acyclic: ["packages/**/*.ts"],
  baseline: [],
  governed: `${d}/**`,
  integrationCalls: [],
  modules: [
    makeModule("vocab", "library", []),
    makeModule("kernel", "library", ["vocab"]),
    makeModule("team", "service", ["vocab"]),
    makeModule("login", "service", ["team", "vocab"]),
    makeModule("contact", "service", ["vocab"], {
      packages: ["sanitize-html"],
    }),
    makeModule("catalog", "catalog", ["login", "team"]),
    makeModule("privacy", "privacy", ["catalog"]),
    {
      files: [`${d}/index.ts`],
      layer: "assembly",
      name: "assembly",
      uses: "all",
    },
  ],
  units: [
    { root: "packages/domain", uses: [] },
    { root: "packages/db", uses: ["packages/domain"] },
    { root: "packages/cms-client", uses: [] },
    { root: "apps/web", uses: ["packages/domain", "packages/db"] },
    { root: "apps/cms", uses: [] },
  ],
};

export const clean: readonly SourceFile[] = [
  source(`${d}/vocab/ids.ts`, "effect"),
  source(`${d}/kernel/a.ts`, "../vocab/ids.ts", "effect/rpc"),
  source(`${d}/team/a.ts`, "../vocab/ids.ts"),
  source(`${d}/login/a.ts`, "../team/a.ts", "../vocab/ids.ts"),
  source(`${d}/contact/a.ts`, "../vocab/ids.ts", "sanitize-html"),
  source(`${d}/catalog/a.ts`, "../login/a.ts", "../team/a.ts"),
  source(`${d}/privacy/a.ts`, "../catalog/a.ts"),
  source(`${d}/index.ts`, "./privacy/a.ts"),
  source("packages/db/src/a.ts", "@vektorprogrammet/domain", "effect"),
  source("packages/cms-client/src/a.ts", "effect"),
  source(
    "apps/web/src/server/a.ts",
    "@vektorprogrammet/domain",
    "@vektorprogrammet/db"
  ),
  source("apps/cms/src/a.ts", "astro"),
];

export const check = (
  files: readonly SourceFile[],
  within: Declaration = fixture
): readonly string[] => moduleGraphFindings(within, files);

/** `clean` with the `added` files, which replace a file of the same path. */
export const replacing = (
  ...added: readonly SourceFile[]
): readonly SourceFile[] => [
  ...Arr.filter(
    clean,
    (file) => !Arr.some(added, (other) => other.path === file.path)
  ),
  ...added,
];

/** `clean` with more imports in `path`, after the ones it has. */
export const importing = (path: string, ...more: readonly string[]) =>
  Arr.map(clean, (file) =>
    file.path === path
      ? source(
          path,
          ...Arr.map(file.imports, ({ specifier }) => specifier),
          ...more
        )
      : file
  );

export const mentioning = (findings: readonly string[], text: string) =>
  Arr.filter(findings, (finding) => finding.includes(text));

/** The finding about the import at `site` (`path:line`), or an empty text when there is none. */
export const at = (findings: readonly string[], site: string): string =>
  Option.getOrElse(
    Arr.findFirst(findings, (finding) => finding.startsWith(`${site}:`)),
    () => ""
  );
