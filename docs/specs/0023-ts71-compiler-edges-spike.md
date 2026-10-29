# Spec 0023: Spike: the module graph's import edges from the TypeScript 7.1 compiler (ADR 0015, stage 1's resolver)

**Status:** spike; frozen when its PR opens; later changes are dated entries under [Revisions](#revisions) · **Source:** the lead's brief of 2026-10-29 (TypeScript 7.1 beta, `typescript/sync`), ADR 0015 (`docs/decisions/0015-module-layers.md`), spec 0020 (`resolveImports.ts`) · **Branch:** `spike/ts71-compiler-edges`, from main `c0ab784`. **Verdict: not yet** (see [Recommendation](#recommendation)).

## Journey

A reviewer of spec 0020 asks whether the compiler can place the imports so that the check does not carry a resolver of its own. She runs the spike:

1. `devenv shell -- bunx vp -C tools/quality test test/compilerEdges.test.ts --silent=false` opens the TypeScript 7.1 compiler on each of the ten `tsconfig.json` files of the workspace, takes every file's module specifiers and the compiler's resolution of each, and compares them with what `oxc-resolver` gave the module graph check for the same files.
2. The test passes with one named difference in the real tree and two in a repository built for the forms the tree does not use. A change to the resolver's options (the unit's `tsconfig` removed) fails it with `path:line specifier: the check: …; the compiler: …` for every import that moved.
3. This document says what the API gives, how close the two readings are, how long each takes, and when to adopt it.

## Question and answer

| Question | Answer |
| --- | --- |
| Does the 7.1 API expose resolved modules per file? | **Yes.** `Program.getResolvedModuleFromModuleSpecifier(node, file)` returns the `ResolvedModule` of one specifier (`resolvedFileName`, `originalPath` after symlinks, `extension`, `packageId`, `isExternalLibraryImport`); `getResolvedModule(file, moduleName, mode)` does the same for a name. The specifiers come from `SourceFile.imports` and `SourceFile.moduleAugmentations` (the compiler binder's own list, the one `tsc` resolves from). No type checker and no emit are needed, and no resolution is hand-rolled. |
| How are the edges derived? | `new API({ cwd })` (a child process of the native compiler), `api.parseConfigFile(tsconfig)` (`fileNames` and `options`, `extends` followed; the Effect plugin entry in `compilerOptions.plugins` is accepted), `api.createProgram(fileNames, options)`, then for each repository file of `program.getSourceFileNames()`: `program.getSourceFile` and one resolution call per specifier. `tools/quality/compilerEdges.ts`. |
| Do the two readings agree? | On the real tree: 3,736 compiler edges in ten tsconfig programs; **one difference**, `apps/web/src/routes/__root.tsx:17 ../styles.css?url` (a Vite query). In a repository of the forms the tree does not use: **two**, both by design of the check. |
| Speed | The compiler is as fast as the check for `packages/domain` (about 160 ms against 180 ms) and 2 to 6 times slower for the other units; it needs one program per tsconfig. Detail below. |
| Recommendation | **Not yet.** Keep `oxc-resolver`; keep this test as an oracle while 7.1 is a beta. Adopt when 7.1 is stable **and** its sync client runs under Bun (or the check moves to the async client). |

## Goal, constraints, values

- **Goal:** find out, with the real tree, whether the TypeScript 7.1 compiler API can give `check:module-graph` its import edges, and what it would cost.
- **Constraints:**
  - `typescript@7.1.0-beta` is installed **only** in `tools/quality`, as the alias `typescript-7-1` (root catalog: `npm:typescript@7.1.0-beta`, the way `vite` is aliased). The repository's compiler stays `typescript` 7.0.2: `vp check`, `tsgolint` and the `@effect/tsgo` patch are untouched (`bun.lock` gains the alias and the platform binary `@typescript/typescript-linux-x64`).
  - No change to the check, its declaration or its baseline: `check:module-graph` still reads `oxc-resolver`.
  - If the API could not give per-file resolution the spike would stop and say so. It can.
- **Values:** one resolver for the lint's `import/no-cycle` and the check (spec 0020) is worth keeping unless the compiler's answer is better; a difference is a finding with a `file:line`.

## Requirements and falsifiers

| # | Requirement | Falsifier (and its control) | Where |
| --- | --- | --- | --- |
| S1 | `compilerEdges(root, tsconfig, paths)` returns, for each file of the program that is among `paths` (the files that git lists), each specifier with its line and the compiler's resolution (`file`, `external`, `unresolved`), and closes the compiler process and the program with the caller's scope. | The test counts this process's child processes before, inside and after the scope (`/proc/<pid>/task/*/children`): more inside, the same number after. Mutation: the release of the API client replaced by a no-op fails it (`the compiler process still runs`, run once, restored); the control is the unmutated release, which passes. | `compilerEdges.ts` |
| S2 | For each tsconfig of the workspace, the check's edges (`readSources` on the git-tracked sources under that unit) equal the compiler's, up to the named differences. | A resolver option removed from `resolveImports.ts`: `tsconfig: undefined` fails the `apps/web` case with 303 differences, the first of them `codeForm.tsx:1 @/components/ui/button: the check: unresolved; the compiler: file apps/web/src/components/ui/button.tsx` (run once, restored); the control is the unmutated tree, which passes. The case is not vacuous: it asserts more than 3 files and more than 10 compiler edges, and the 1,001 domain edges are compared place by place. | `compilerEdges.test.ts` § each unit |
| S3 | The comparison names the place of each difference (`path:line specifier`). | The comparison given a list with one edge's target changed and another edge dropped reports exactly those two places; the unchanged list reports none. | § a difference is reported |
| S4 | The forms that the real tree does not use (`.js` to `.ts`, a directory import, JSON, a `paths` alias, `package.json` `imports`, a symbolic link, a type-level `import()`, `import x = require`, `export *`, a missing file, `node:fs`) are compared in a temporary repository. | `symlinks: false` in the resolver options removes the `./linked.ts` difference and the test fails (run once, restored); the control is the unmutated resolver, which passes with the two named differences. | § a repository of the forms |

The mutations that did **not** fail the real-tree test, so that the tree does not exercise them: removing `.json` from `extensions`, mapping `.js` to `.js` only, `symlinks: false`, removing `types` from `conditionNames` (`symlinks: false` does fail the temporary repository's case; the others were not run against it). Removing `.ts` from `extensions` fails `apps/web` and the temporary repository.

## Parity, in detail

`edgeDifferences(ours, theirs)` compares by place (`path:line specifier`) after putting both readings in the same words: a file path, `workspace <name>` for `@vektorprogrammet/…` (the check names the package and does not look inside it), `external` for a resolution into `node_modules` and for a bare specifier that resolves to nothing (the check calls `cloudflare:workers` external, the compiler calls it unresolved), `unresolved` for a relative path that names no file. `import.meta.glob` patterns are left out (the compiler does not read them).

| Unit (tsconfig) | Files | Compiler edges | Check's edges (raw) | Differences |
| --- | --: | --: | --: | --- |
| `packages/domain` | 157 | 1,001 | 1,026 | none |
| `packages/db` | 106 | 791 | 794 | none |
| `packages/cms-client` | 13 | 48 | 66 | none |
| `apps/web` | 228 | 1,408 | 1,693 | `__root.tsx:17 ../styles.css?url` |
| `apps/cms` | 4 | 21 | 21 | none |
| `tools/db-path-spike` | 21 | 104 | 104 | none |
| `tools/docgen` | 6 | 27 | 27 | none |
| `tools/effx-conformance` | 9 | 37 | 37 | none |
| `tools/import` | 32 | 150 | 150 | none |
| `tools/quality` | 34 | 149 | 149 | none |

The check's raw count is higher in three units for two reasons that are not differences: `import.meta.glob` matches (each matched file is an import, in `apps/web`), and one entry per exported name of `export { a, b, c } from "./x"` (the compiler has one specifier per statement: `packages/domain/src/index.ts:153` appears ten times in the check's list; 25 repeated entries in `packages/domain`, 3 in `packages/db`, 18 in `packages/cms-client`). The repeats do not change a verdict, but the check prints a finding once per name.

The differences, each with its cause:

| Place | The check | The compiler | Cause |
| --- | --- | --- | --- |
| a Vite query (`../styles.css?url`) | resolves the file (the query is not part of the path) | unresolved | `Program` resolves the specifier as written. `getResolvedModule(file, moduleName, mode)` takes a name, so a caller can strip the query first; the node-based call cannot. |
| `import "./dir"` in an ES-module package under `nodenext` | `dir/index.ts` | unresolved | the check resolves as a bundler does; `nodenext` refuses a directory import with no extension. The code would not compile under the repository's own tsconfig. |
| a relative import of a symbolic link | the real file (`symlinks: true`) | the link's own path | the compiler keeps the link for a relative import (it resolves real paths for packages). Spec 0020 already makes a symbolic link in the governed tree a finding. |

And one coverage limit: the compiler sees the files of its tsconfig and what they import. `tools/oxlint/**` (about 45 source files) has no `tsconfig.json`, so no program reads it, and a file in a unit without a program is invisible to this derivation; the check reads every tracked source file.

## Speed and memory

`readSources` reads and parses each file with `oxc-parser` and places each specifier. `compilerEdges` includes starting the compiler process, `parseConfigFile`, `createProgram` (parses and resolves the whole closure: 1,166 files for the domain, mostly `lib` and `node_modules` declarations) and the resolution calls. Wall-clock milliseconds, in-process, on a 32-thread machine at load 16 to 18 (so only the ratios mean something); three consecutive runs of the test, per unit, as the test logs them (`--silent=false`):

| Unit | Check (`readSources`) | Compiler (`compilerEdges`) | Compiler child's resident memory after `createProgram` |
| --- | --: | --: | --: |
| `packages/domain` (157 files) | 194, 166, 177 | 152, 170, 161 | 197 MB |
| `packages/db` (106) | 148, 122, 125 | 285, 283, 295 | 304 MB |
| `apps/web` (228) | 236, 252, 364 | 668, 638, 1,973 (one run disturbed by other jobs) | 914 MB |
| `tools/quality` (34) | 48, 40, 40 | 245, 225, 228 | not measured |

Where the compiler's time goes (median of five runs, `packages/domain`; then `apps/web`): the child process starts and the tsconfig is read in 12 ms (29 ms); `createProgram` takes 81 ms (552 ms); fetching the syntax trees of the repository's own files, 41 ms (91 ms); one resolution call per import, 34 ms (77 ms) sequentially and 13 ms (27 ms) with `api.batch(…gen())`. The first version of `compilerEdges.ts` fetched the syntax tree of every file of the program, `lib` and `node_modules` included, and took 540 ms for the domain and 2.7 s for `apps/web`: the file filter now runs before `getSourceFile`. The measurement scripts were scratch files and are not committed; the numbers above come from the committed test's log lines and a throwaway benchmark run by hand.

A single check over the whole workspace would need ten programs (each `tsconfig.json` is its own program) and one child process each; the check today reads 656 files in about one second end to end (`bun run check:module-graph`, including `git ls-files`).

## API facts that decide adoption

- **`typescript/sync` does not run under Bun 1.4.2.** Its `SyncRpcChannel` reads `child.stdout._handle.fd`, a Node internal: `new API(…)` fails with `TypeError: undefined is not an object (evaluating 'stdout._handle.fd')`. The check runs as `bun tools/quality/checkModuleGraph.ts`. `typescript/async` works under Bun (`parseConfigFile`, `createProgram` and `getSourceFileNames` answered for the domain in 119 ms), so an adoption means the async client. The tests here run under Node (Vitest in Vite+), where the sync client works.
- The API is described as a preview (the beta announcement: "we're working with partner teams to ensure TypeScript 7.1's API is both ergonomic and provides the appropriate performance"); its shapes may move before a stable 7.1.
- Calls are synchronous and throw: `compilerEdges.ts` wraps each step in `Effect.try` with a tagged error and holds the client and the program with `Effect.acquireRelease` (`close()`, `dispose()`), as `effect-boundary-adapters` asks of a foreign client. The adapter's retirement trigger is this spike's: replacing `resolveImports.ts`, or dropping it.
- The package ships its native binary as an optional dependency per platform (`@typescript/typescript-linux-x64`); CI's platform needs it installed (Bun installs it with the alias).

## Recommendation

**Not yet.**

1. **Why not now.** 7.1 is a beta with a preview API. The sync client does not run under the Bun that runs the check. The compiler's readings need one program per tsconfig, are slower than the check for every unit but the domain (2 to 6 times), hold up to 0.9 GB for `apps/web`, cannot read a file that no tsconfig includes (`tools/oxlint`), and do not read `import.meta.glob` or a Vite query. Nothing in the real tree is placed differently by `oxc-resolver` than by the compiler, so there is no correctness gain to buy with that.
2. **What it would buy.** One resolver for the type check and the graph (the compiler's own), and no option list to keep in step with `tsconfig.json` (`resolveImports.ts` carries `extensionAlias`, `conditionNames` and `extensions` by hand). That is worth having if the options ever drift, and the parity test is the oracle that says when.
3. **Adopt when** TypeScript 7.1 is stable, **and** the async client (or a Bun-compatible sync one) is the one the check calls, **and** every tracked source file has a tsconfig (a `tools/oxlint/tsconfig.json`), **and** the three named differences are decided: strip a Vite query before asking (`getResolvedModule`), treat a directory import the way `nodenext` does, keep `symlinks` out of the governed tree. Then replace `makeResolver` in `resolveImports.ts`, keep `edgeDifferences` as a test against `oxc-resolver` for one release, and delete the `oxc-resolver` dependency.
4. **Never?** No: the compiler is the right authority for what the code means. What is missing is a stable API and a runtime that matches the one the check uses. Revisit when 7.1 reaches `latest` on npm.

Until then the parity test stays as an early warning: it runs the compiler on ten tsconfigs in about six seconds and fails when the resolver options and `tsconfig.json` disagree about an import. It depends on the beta; when the dependency alias moves or is removed, the test goes with it (the retirement trigger).

## Not done here

- No change to `check:module-graph`, `resolveImports.ts`, the declaration or the baseline.
- No use of the type checker (`createProgram` and the program's resolution answer the question; the checker would only be needed to read re-exports through the type system, which the module graph does not do).
- No measurement under CI's two-CPU runner; the numbers are ratios on a loaded 32-thread machine.
- `typescript/async` was run under Bun for `createProgram` only, not for the edges.
- The unexercised options of `resolveImports.ts` (`.json`, `.js` alias, `types` condition) are listed above and not covered by the real tree.

## Revisions

- **2026-10-29, while building.** The spec was written with the first measurements and revised with the later ones: the first `compilerEdges.ts` fetched every file's syntax tree (see Speed); the first comparison counted the check's glob matches and repeated `export { … } from` entries as differences, so `edgeDifferences` now leaves out globs and counts a repeated place once; `apps/cms`, `tools/*` and the other units were added to the parity test after the domain passed.
- **2026-10-29, the first `bun run ready` failed once: the scratch files of other tests.** `test:all` runs this package's test files in parallel, and `storeBoundary.test.ts` and `moduleGraph.test.ts` write probe files into the live tree (`tools/quality/probes.ts`, spec 0020 round 1). The check's scan skips them; the compiler, which lists the directory, read `packages/cms-client/src/storeBoundaryProbe.ts` and four others, and the parity test reported them as five `the check has no such import` differences. `compilerEdges.ts` first skipped `isProbe` paths.
- **2026-10-29, the second `bun run ready` and the pre-push failed: generated files.** Skipping probes was a patch of one case. After `bun run check:cms` had run in the worktree, `apps/cms/.astro/content.d.ts` (generated, git-ignored, included by the tsconfig) was read by the compiler and not by the check, and the `apps/cms` case reported all its imports as `the check has no such import`. `compilerEdges` now takes `paths`, the files that git lists (`workingTreePaths`, which the scan uses and which skips probes and ignored files), and reads only those: the compiler never decides which files are the repository's. That is the answer to the first failure too, so `isProbe` is not imported. The same holds for any adoption: the file list comes from git, the edges from the program.
