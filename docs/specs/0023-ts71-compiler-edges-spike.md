# Spec 0023: Spike: the module graph's import edges from the TypeScript 7.1 compiler (ADR 0015, stage 1's resolver)

**Status:** spike result, **docs only**: the code and the dependency live on the kept branch `spike/ts71-compiler-edges` (head `6c85872`, PR #58 closed unmerged by the lead's decision of 2026-10-29: no beta compiler in `tools/quality`'s dependencies or in `test:all` while the verdict is "not yet"); frozen when this PR opens; later changes are dated entries under [Revisions](#revisions) · **Source:** the lead's brief of 2026-10-29 (TypeScript 7.1 beta, `typescript/sync`), ADR 0015 (`docs/decisions/0015-module-layers.md`), spec 0020 (`resolveImports.ts`) · **Branch of the code:** `spike/ts71-compiler-edges`, from main `c0ab784` (`tools/quality/compilerEdges.ts`, `tools/quality/test/compilerEdges.test.ts`, the `typescript-7-1` alias in the root catalog and `tools/quality/package.json`, one `vite.config.ts` line). Every path and command below that names those files is read on that branch; main does not have them. **Verdict: not yet** (see [Recommendation](#recommendation)).

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

## The ttsc toolchain (operator-approved spike, 2026-10-29)

[`ttsc`](https://github.com/samchon/ttsc) 0.34.2 (MIT) is a launcher around the native TypeScript compiler (`tsc` replacement, `ttsx` runner, plugins in Go) with first-party plugins `@ttsc/lint`, `@ttsc/evidence` and `@ttsc/graph`. The operator asked for evidence on seven questions, against the repository's own TypeScript 7.0.2 (patched by `effect-tsgo patch`, which prints as `7.0.2+effect-tsgo.0.53.1`) and Bun 1.4.2. Setup: a scratch worktree of main `b695993`, `bun add -d ttsc @ttsc/graph @ttsc/lint @ttsc/evidence` (all 0.34.2), a 32-thread machine at load 8 to 20 (read the ratios, not the seconds). The code is on the kept branch `spike/ttsc` (`tools/ttsc-edges`, the dependencies, one unit row in `moduleGraph.ts`); the scripts are in appendix B. Nothing here changes main's dependencies.

| Tool | Verdict | Deciding evidence |
| --- | --- | --- |
| `ttsc` as a type-check beside `vp check` | **no, for now** | exits 2 on every project of this repository until each tsconfig gets a second chain; adds no check that `vp lint` lacks (below) |
| `@ttsc/graph` for import edges | **no** | an edge graph of uses, not of imports: 58 of 667 import pairs missing, 225 pairs that no file imports (domain) |
| a Go check plugin for import edges | **no (7.1 API first)** | 0 differences in nine of ten tsconfigs and 82 in the tenth, all explained; but no lines, a Go build (60 s cold) and 2 GB for `apps/web`, where the 7.1 sync API does the same in 0.7 s and 0.9 GB |
| `@ttsc/lint` instead of Oxlint, Ultracite and the Effect and anti-slop plugins | **no** | 29 custom JavaScript rules would be rewritten in Go; Effect diagnostics already come from the compiler; no rule overlap measured beyond the boundary rules below |
| `@ttsc/lint`'s `boundaries/*` instead of `check:module-graph` | **no (duplicates it)** | found the same three module violations of `packages/domain`; has no baseline, no cycles, no unit rules |
| `@ttsc/evidence` for "every spec falsifier has a test" | **spike further** | the mechanism works (7 errors from 7 headings of spec 0020); our falsifiers are table rows and our tests are calls, so specs and tests would change shape |
| `@ttsc/graph` as an agent's MCP code graph | **spike further** | 0.7 to 5 k tokens per answer after a 12.8 k token tool description; no agent run, no check of the answers |
| `ttsx` and `ttsc/register` instead of Bun | **no** | type-checks the whole project first and stopped on this repository's project diagnostics; Bun starts a file with no check |
| typia instead of Effect Schema | **no** | by reasoning, not by measurement (below) |

### 1. Coexistence with `effect-tsgo patch` and `vp check`

- **`ttsc --noEmit` fails on every project here, with exit 2 and one line**: `ttsc: plugin entry is missing a string "transform" field`. The root `tsconfig.json` holds `compilerOptions.plugins: [{ "name": "@effect/language-service", … }]` and `ttsc` reads the same array for its own plugins (`node_modules/ttsc/src/plugin/internal/load/loadProjectPlugins.ts:332` throws; line 266 drops entries with `enabled: false`). It is a configuration conflict, not a compiler disagreement. The workaround, verified, is a second tsconfig chain per unit with `plugins[0].enabled = false` (`jq`, appendix A): the patched compiler still reads the language-service options, `packages/domain` exits 0 and `apps/web` exits 1 with its diagnostics. Ten units need ten extra files, or a change in `ttsc`.
- **The diagnostics are the compiler's.** A probe file with one type error and four Effect faults (`floatingEffect`, `globalDateInEffect`, `extendsNativeError`, `asyncFunction`): `ttsc --noEmit` and `tsc --noEmit` print the same five lines byte for byte, `effect-tsgo diagnostics` the four Effect ones, and `vp lint` those five plus six more from Oxlint, unicorn, eslint and the Effect plugin (`effect(no-native-promise-control-flow)`, `effect(no-ambient-authority)`, `eslint(require-yield)`, …). So `ttsc` finds nothing that `vp lint` does not.
- **A second source of one policy.** On `apps/web`, `ttsc`, `tsc` and `effect-tsgo diagnostics` all report the same 10 `effect(asyncFunction)` errors in `test/deliveryScope.postgres.test.ts`, `test/outboxQueue.postgres.test.ts`, `test/support/commandOutcome.ts` and `test/support/workerEnv.ts`, and `vp lint` reports none: the root `vite.config.ts` turns `effecttsgo/async-function` off for those files, a switch that the compiler's own tsconfig overrides do not carry. Making `ttsc` a gate means moving that policy into tsconfig, which is the single-source rule working against the lint config.
- Time and memory (warm, GNU `time`, peak RSS of the largest process): `ttsc --noEmit` 0.91 s and 0.51 GB for `packages/domain`, 3.2 to 3.3 s and 2.1 to 2.2 GB for `apps/web`; `tsc` on `apps/web` 2.6 to 2.8 s and 2.2 GB; `effect-tsgo diagnostics` 3.9 s and 1.6 GB; `vp lint` on the whole repository 19.5 s and 4.2 GB. All ten units with `ttsc`: about 14 s plus ten `devenv shell` starts.

### 2. Per-file resolved import targets

- **`@ttsc/graph` does not suffice.** `ttsc-graph dump --cwd … --tsconfig …` prints nodes (class, function, interface, module, type, variable) and edges of kinds `accesses`, `calls`, `exports`, `extends`, `implements`, `instantiates`, `type_ref`: no import edge. File pairs derived from the declarations (`parity.ts`, appendix B) for `packages/domain` (157 files): the check has 667 pairs and the graph 834; 609 in both, **58 only in the check** (the `export * from` of `index.ts` and imports whose names the file never uses) and **225 only in the graph** (a use through a barrel is attributed to the declaring file, for example `accounts/commands.ts` to `kernel/domain.ts`). It is a graph of uses, the right shape for an agent and the wrong one for a layer rule. The dump took 1.5 s and 0.38 GB.
- **A Go check plugin does.** `tools/ttsc-edges` (about 110 lines of Go and a 10-line TypeScript descriptor) calls `ProgramResolutionTasks` of the shim `compiler` package on the loaded Program and writes, for every module resolution, the containing file, the specifier, the resolved file and the loaded target. Unique `(file, specifier)` pairs against the check (`pluginParity.ts`, appendix B), per tsconfig: `packages/domain` 886 and 886, `packages/db` 703 and 703, `packages/cms-client` 41, `apps/cms` 20, `tools/db-path-spike` 96, `tools/docgen` 22, `tools/effx-conformance` 30, `tools/import` 133, `tools/quality` 134: **0 differences each**. `apps/web` has 1,357 plugin pairs and 1,282 of the check's, 82 differences: 78 the implicit `react/jsx-runtime` import that the compiler adds for `jsx: react-jsx`, 2 `import.meta.glob` patterns (the compiler does not read them), 1 `../styles.css?url` (a Vite query), 1 `declare module "cloudflare:workers"` (the check reads a string-named module declaration as a specifier). That is better parity than the 7.1 API's (one difference in 3,736 edges, plus the symlink and directory cases), because the plugin uses the resolutions that the Program already made. It has **no line numbers** (a resolution task has a name and a file, not a position), so a finding with `file:line` still needs the parser.
- **Cost of the plugin.** Cold (empty `GOCACHE`, plugin source changed): **60.5 s, 2.1 GB peak, 1.5 GB of Go cache** on 32 threads; with a warm Go cache and a changed plugin source 4.7 s; cached plugin, `packages/domain` 1.7 s against 0.9 s without it, `apps/web` 4.1 to 4.3 s against 3.2 to 3.3 s. For comparison `bun tools/quality/checkModuleGraph.ts` reads the whole repository in 1.3 to 1.75 s and 0.19 GB. CI would need `@ttsc/linux-x64` (160 MB, with a 147 MB bundled Go 1.27 SDK) and a persisted Go cache: `ttsc` itself says a cold cache "can take several minutes", and a two-CPU runner was not measured. The Go code is ours to own against `typescript-go`'s internal shims.
- **Against the 7.1 API** (sections above): same source of truth (the compiler's resolver), but the sync API answers in-process in 152 to 170 ms (`packages/domain`) and 638 to 668 ms (`apps/web`) and carries no Go. Its blocker, the Bun runtime, is a different problem from the plugin's. No reason to take both.

### 3. Cost, risk and CI

See the numbers above. Risk, from npm and GitHub on 2026-10-29: version 0.34.2, pre-1.0 (the documentation says "v1 protocol, still moving. Don't publish ttsc as a peer dependency yet"); 134 npm versions, 78 of them since June 2026 (June 20, July 24, August 11, September 8, October 15); one maintainer, `samchon`, with 2,533 of about 2,580 commits (98%), 362 stars, 16 forks, 2 open issues; MIT; peer `typescript >=7.0.0 || >=7.1.0-0` (it builds against the project's TypeScript line, `target_ts70.go` and `target_ts71.go`). It links Go against generated shims of `typescript-go`'s internal packages (`shim/compiler`, `shim/checker`, …) and carries a skill for re-syncing them (`.agents/skills/typescript-go-sync`), so every tsgo release is a sync by one person. Four of the last 100 commit subjects name tsgo, 7.1 or shims, which is a count of mentions and not of breakages: how often a sync broke a consumer was **not measured**.

### 4. The other tools

- **`@ttsc/lint`.** 747 rules in the README, off until enabled one by one (no preset); rules come from ESLint, typescript-eslint, unicorn, react, functional and boundaries ports. Custom rules are Go packages linked in as contributors, so the 24 anti-slop rules and 5 Effect rules of `tools/oxlint` (JavaScript, Oxlint's plugin API) would be rewritten in Go; `vite.config.ts` overrides (the policy above) are not read. The speed claim ("900 times faster than ESLint in the same check") is against ESLint; `vp lint` already runs the whole repository in 19.5 s with type-aware rules. It would duplicate and not replace, and a full rule-by-rule overlap was **not measured**.
- **`boundaries/*` against `check:module-graph`.** A generated `lint.config.ts` (appendix B) maps every module of `moduleGraph.ts` to an element (one per glob) and its `uses` to `allow`. On `packages/domain` it reported exactly the three module violations that the baseline lists (`shared/outbox.ts:12`, `:13`, `workspace/commands.ts:26`, `TS9732 [boundaries/element-types]`), and an upward import injected into `kernel/guard.ts` was reported at the same line as the check reports it (`:248`; the check adds the cycle it closes). Warm: 2.8 to 2.9 s and 0.8 GB for the domain. What it does not do, each read from its options and this run: no baseline or ratchet (an allowed violation needs a type-level exception, not a file pair), no unused-edge check (rule 4), no package-to-package rules across tsconfigs (each program is its own project root), no import cycles (`architecture/no-cycles` in its README is a contributor example, not a rule), not the forms the check reads (`import.meta.glob`, `import x = require`, `declare module`), no `integrationCalls`, and `except` lists are not expressible. ADR 0015 rejected `eslint-plugin-boundaries` as "a second linter for one rule"; the port removes ESLint and not the other gaps.
- **`@ttsc/evidence`.** One claim, `tools/quality/{moduleGraphCheck,resolveImports,globImports}.ts` functions to the H2 headings of spec 0020, gave seven `TS16411 [evidence/graph] Missing acknowledgement for '0020-module-layers-check.md#falsifiers'` (one per H2), in 5.4 s and 0.67 GB warm, with the claim's `root` set to `../../docs/specs` (a glob may not climb out of the project). A unit is a heading (h1 to h4) or a file, a TypeScript `function`, `type` or `property` declaration, a Prisma model or a Swagger operation, so it **cannot see our falsifier and requirement rows** (R1 to R12, F1 to F11 are table rows) **or our tests** (`it.effect("…", () => …)` is a call with nothing to attach a JSDoc tag to). Making "every falsifier has a test" a compile error therefore means one heading per falsifier in new specs and a declaration, with `@evidence` JSDoc, per test or per helper, plus `@evidenceReview` and `@evidenceExclude` hygiene on top of the Revisions workflow. The benchmark in its README (100% coverage against 52 to 86%, fewer tokens) is its author's and was not reproduced. Worth a narrow trial on the next spec, not adoption.
- **`@ttsc/graph` as MCP.** `tools/list` is one tool whose description and schemas are 51,185 bytes (about 12.8 k tokens) in the agent's context for the whole session. Answers on `packages/domain` (`mcp.mjs`, appendix B; sizes in bytes and bytes/4 as tokens): `lookup` "Transactor" 2,968 B (742 tokens, 2.6 s for the first graph build), `details` 2,748 B (687), `trace … impact` 10,593 B (2,648), `tour` 20,071 B (5,018), later calls 1 to 350 ms. The proxy for "no graph": 42 files mention `Transactor`, 455,011 bytes (about 114 k tokens) to read them all, which no agent does. **No agent was run and the answers were not checked against the code**, so the 92% claim is untested here, and it was not compared with `tilth` or `stacklit`. It is the same producer as the edge dump, so it costs nothing further to try in an agent session. Worth an A/B on one real question.
- **`ttsx` and `ttsc/register` against Bun.** `ttsx` type-checks the nearest tsconfig project before it runs anything: on `tools/quality` it stopped with the plugin-entry error and `TS6059` (`test/diagnosticCoverage.test.ts` imports the root `vite.config.ts`, outside the tsconfig's inferred `rootDir`), diagnostics that `vp check` does not print; it needs Node 22.15 or later; its project check alone ran 0.8 s before it stopped, where Bun ran a scratch file in 0.00 s (the resolution of GNU `time`); a successful `ttsx` run was not timed. A type error does stop it (`zzBad.ts(1,7): error TS2322`), which Bun does not. Our scripts run under Bun and are type-checked by `vp check`.
- **typia against Effect Schema: not measured.** By reasoning: typia generates validators from TypeScript types at build time and so needs the `ttsc` transform in every build and test run (Vite, Vitest and Oxlint do not run it without `@ttsc/unplugin`), while our models are Schema-first (codecs with transformations and brands, tagged errors, the form validator derived from the same model: `AGENTS.md`, "Form modeling" decision) and typia has no Effect Schema interface that was found. The decision has no local evidence either way and needs none until a boundary wants a validator that Schema cannot give.

### 5. Recommendation

1. **Do not adopt `ttsc` now.** Its check duplicates `tsc` (byte-identical diagnostics) and adds a configuration conflict and a second place for lint policy. Its plugins either duplicate what we run or need the Go rewrite of our rules.
2. **Edges stay on the 7.1 API path** (recommendation above); the `ttsc` plugin is the better-parity but heavier route and is kept on `spike/ttsc` only to show the number.
3. **Spike further, two things, each one afternoon:** (a) `@ttsc/evidence` on the next new spec (headings per falsifier, `@evidence` on the helper that holds each test), judged by whether the compile error finds an omission that review did not; (b) `@ttsc/graph` as an MCP server in one agent session on one real question against the current tooling, judged by answer correctness and total tokens, not by the tool description.
4. **Re-run the coexistence question** when `ttsc` ignores a plugin entry that has no `transform`, or the repository's tsconfig can carry both (`enabled: false` already works for the compiler's side).

## Not done here

- **The spike is not merged.** Main has this document and a `STATE.md` item; the adapter, its test and the dependency stay on the branch, which is kept (not deleted) so that adoption starts from a passing parity test.
- No change to `check:module-graph`, `resolveImports.ts`, the declaration or the baseline.
- No use of the type checker (`createProgram` and the program's resolution answer the question; the checker would only be needed to read re-exports through the type system, which the module graph does not do).
- No measurement under CI's two-CPU runner; the numbers are ratios on a loaded 32-thread machine.
- `typescript/async` was run under Bun for `createProgram` only, not for the edges.
- The unexercised options of `resolveImports.ts` (`.json`, `.js` alias, `types` condition) are listed above and not covered by the real tree.

## Appendix A: commands

```sh
# every unit: a tsconfig chain that disables the language-service entry for ttsc (the patched compiler still reads its options)
jq '.compilerOptions.plugins[0].enabled=false' tsconfig.json > tsconfig.ttsc.json
for u in packages/domain packages/db packages/cms-client apps/web apps/cms tools/db-path-spike tools/docgen \
         tools/effx-conformance tools/import tools/quality; do
  jq '.extends="../../tsconfig.ttsc.json"' $u/tsconfig.json > $u/tsconfig.ttsc.json
done
bunx ttsc --noEmit -p packages/domain/tsconfig.ttsc.json            # coexistence, speed
bunx ttsc-graph dump --cwd $PWD --tsconfig packages/domain/tsconfig.ttsc.json > dump.json   # graph edges
# the check plugin (branch spike/ttsc): add {"transform":"./tools/ttsc-edges/plugin.ts"} to plugins, then
TTSC_EDGES_OUT=/tmp/edges.json bunx ttsc --noEmit -p packages/domain/tsconfig.ttscedges.json
```

Cold plugin build: `GOCACHE=$(mktemp -d) …` with a changed plugin source. Memory and time: GNU `time -f "wall=%es peakRSS=%MKB"`.

## Appendix B: scripts

`parity.ts` (graph-derived file pairs against the check; place it in `tools/quality/` and run `bun tools/quality/parity.ts packages/domain`):

```ts
import { spawnSync } from "node:child_process";

import { readSources } from "/srv/share/projects/vektorprogrammet/vektorprogrammet/modernized/reimagined-ttsc/tools/quality/resolveImports.ts";
import { workingTreePaths } from "/srv/share/projects/vektorprogrammet/vektorprogrammet/modernized/reimagined-ttsc/tools/quality/workingTree.ts";
// Spec 0023, ttsc section: file-level import edges derived from `ttsc-graph dump` against oxc-resolver's (readSources).
// Run from the repository root: bun /tmp/ttscspike/parity.ts <unit> [tsconfigName]
import { NodeServices } from "@effect/platform-node";
import { Array as Arr, Effect, FileSystem } from "effect";

const unit = process.argv[2] ?? "packages/domain";
const tsconfig = process.argv[3] ?? "tsconfig.ttsc.json";
const root = process.cwd();

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const real = yield* fs.realPath(root);
  const all = yield* workingTreePaths(real, (p) => /\.[cm]?[jt]sx?$/u.test(p));
  const paths = Arr.filter(all, (p) => p.startsWith(`${unit}/`));
  const ours = yield* readSources(real, paths);

  const t = performance.now();
  const run = spawnSync(
    "bunx",
    ["ttsc-graph", "dump", "--cwd", real, "--tsconfig", `${unit}/${tsconfig}`],
    { maxBuffer: 1 << 30 }
  );
  const dumpMs = performance.now() - t;
  const dump = JSON.parse(run.stdout.toString()) as {
    nodes: { id: string; file: string; external?: boolean }[];
    edges: {
      from: string;
      to: string;
      kind: string;
      evidence?: { startLine: number };
    }[];
  };
  const file = new Map(
    dump.nodes.map((n) => [n.id, n.external === true ? undefined : n.file])
  );
  const graph = new Map<string, string>(); // "from -> to" => first evidence "line kind"
  const inRepo = new Set(all);
  for (const e of dump.edges) {
    const f = file.get(e.from);
    const g = file.get(e.to);
    if (
      f !== undefined &&
      g !== undefined &&
      f !== g &&
      inRepo.has(f) &&
      inRepo.has(g)
    ) {
      const key = `${f} -> ${g}`;
      if (!graph.has(key))
        graph.set(key, `${e.evidence?.startLine ?? "?"} ${e.kind}`);
    }
  }
  const oxc = new Map<string, number>();
  for (const f of ours)
    for (const i of f.imports) {
      if (
        i.glob !== true &&
        i.target.kind === "file" &&
        i.target.path !== f.path
      ) {
        const key = `${f.path} -> ${i.target.path}`;
        if (!oxc.has(key)) oxc.set(key, i.line);
      }
    }
  const onlyOxc = [...oxc].filter(([k]) => !graph.has(k));
  const onlyGraph = [...graph].filter(([k]) => !oxc.has(k));
  console.log(
    JSON.stringify({
      unit,
      files: paths.length,
      oxcPairs: oxc.size,
      graphPairs: graph.size,
      both: oxc.size - onlyOxc.length,
      onlyOxc: onlyOxc.length,
      onlyGraph: onlyGraph.length,
      dumpMs: Math.round(dumpMs),
    })
  );
  const show = (xs: [string, unknown][]) =>
    xs
      .slice(0, 6)
      .map(([k, v]) => `    ${k}  (${v})`)
      .join("\n");
  if (onlyOxc.length)
    console.log(
      "  only oxc (path:line of the import):\n" +
        onlyOxc
          .slice(0, 6)
          .map(
            ([k, v]) =>
              `    ${k.split(" -> ")[0]}:${v} -> ${k.split(" -> ")[1]}`
          )
          .join("\n")
    );
  if (onlyGraph.length) console.log("  only graph:\n" + show(onlyGraph));
}).pipe(Effect.provide(NodeServices.layer));

await Effect.runPromise(program);
```

`pluginParity.ts` (the Go plugin's resolutions against the check; same place):

```ts
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Spec 0023, ttsc section: per-file module resolutions of a minimal Go check plugin (tools/ttsc-edges) against oxc-resolver's.
// Run from the repository root: bun tools/quality/zzPluginParity.ts <unit>
import { NodeServices } from "@effect/platform-node";
import { Array as Arr, Effect, FileSystem } from "effect";

import { readSources } from "./resolveImports.ts";
import { workingTreePaths } from "./workingTree.ts";

const unit = process.argv[2] ?? "packages/domain";
const root = process.cwd();

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const real = yield* fs.realPath(root);
  const all = yield* workingTreePaths(real, (p) => /\.[cm]?[jt]sx?$/u.test(p));
  const paths = Arr.filter(all, (p) => p.startsWith(`${unit}/`));
  const ours = yield* readSources(real, paths);

  const out = `/tmp/edges-${unit.replaceAll("/", "_")}.json`;
  const t = performance.now();
  const run = spawnSync(
    "bunx",
    ["ttsc", "--noEmit", "-p", `${unit}/tsconfig.ttscedges.json`],
    { env: { ...process.env, TTSC_EDGES_OUT: out }, maxBuffer: 1 << 30 }
  );
  const ms = Math.round(performance.now() - t);
  const edges = JSON.parse(readFileSync(out, "utf8")) as {
    file: string;
    specifier: string;
    resolved: string;
    target: string;
  }[];
  const inRepo = new Set(all);
  const theirs = new Map<string, string>(); // file\0specifier -> words
  const strip = (x: string) =>
    x === ""
      ? x
      : x.startsWith(`${real}/`)
        ? x.slice(real.length + 1)
        : x.startsWith("/")
          ? x
          : `${unit}/${x}`;
  for (const raw of edges) {
    const e = { ...raw, file: strip(raw.file), target: strip(raw.target) };
    if (!inRepo.has(e.file) || !e.file.startsWith(`${unit}/`)) continue;
    const resolvedInRepo =
      e.resolved.startsWith(`${real}/`) &&
      !e.resolved.includes("/node_modules/")
        ? e.resolved.slice(real.length + 1)
        : "";
    const words = e.specifier.startsWith("@vektorprogrammet/")
      ? `workspace ${e.specifier.slice(18).split("/")[0]}`
      : e.target !== "" && inRepo.has(e.target)
        ? `file ${e.target}`
        : resolvedInRepo !== ""
          ? `file ${resolvedInRepo}`
          : e.resolved !== ""
            ? "external"
            : e.specifier.startsWith(".")
              ? "unresolved"
              : "external";
    theirs.set(`${e.file}\0${e.specifier}`, words);
  }
  const lineOf = new Map<string, number>();
  const mine = new Map<string, string>();
  for (const f of ours)
    for (const i of f.imports) {
      if (i.glob === true) continue;
      const k = `${f.path}\0${i.specifier.replace(/\?.*$/u, "")}`;
      const kk = `${f.path}\0${i.specifier}`;
      const words =
        i.target.kind === "file"
          ? `file ${i.target.path}`
          : i.target.kind === "workspace"
            ? `workspace ${i.target.name}`
            : i.target.kind;
      mine.set(theirs.has(kk) ? kk : k, words);
      lineOf.set(theirs.has(kk) ? kk : k, i.line);
    }
  const diffs: string[] = [];
  for (const [k, w] of mine) {
    const o = theirs.get(k);
    if (o === undefined)
      diffs.push(
        `${k.split("\0")[0]}:${lineOf.get(k)} ${k.split("\0")[1]}: only the check (${w})`
      );
    else if (o !== w)
      diffs.push(
        `${k.split("\0")[0]}:${lineOf.get(k)} ${k.split("\0")[1]}: check ${w}; ttsc plugin ${o}`
      );
  }
  for (const [k, w] of theirs)
    if (!mine.has(k))
      diffs.push(
        `${k.split("\0")[0]} ${k.split("\0")[1]}: only the plugin (${w})`
      );
  console.log(
    JSON.stringify({
      unit,
      files: paths.length,
      pluginEdges: theirs.size,
      checkEdges: mine.size,
      differences: diffs.length,
      ttscMs: ms,
      exit: run.status,
    })
  );
  for (const d of diffs.sort().slice(0, 400)) console.log("  " + d);
}).pipe(Effect.provide(NodeServices.layer));

await Effect.runPromise(program);
```

`mcp.mjs` (one MCP session over stdio; `node mcp.mjs $PWD`):

```js
// Spec 0023, ttsc section: ask @ttsc/graph's MCP tool one real question over stdio and report the size of its answers.
import { spawn } from "node:child_process";
const cwd = process.argv[2];
const child = spawn(
  "bunx",
  [
    "ttsc-graph",
    "--cwd",
    cwd,
    "--tsconfig",
    "packages/domain/tsconfig.ttsc.json",
  ],
  { cwd, stdio: ["pipe", "pipe", "inherit"] }
);
let buf = "";
const waiting = new Map();
child.stdout.on("data", (d) => {
  buf += d;
  for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.id !== undefined && waiting.has(m.id)) {
      waiting.get(m.id)(m);
      waiting.delete(m.id);
    }
  }
});
let n = 0;
const call = (method, params) =>
  new Promise((resolve) => {
    const id = ++n;
    waiting.set(id, resolve);
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"
    );
  });
const t0 = performance.now();
await call("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "probe", version: "0" },
});
child.stdin.write(
  JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"
);
const tools = await call("tools/list", {});
console.log(
  "tools:",
  tools.result.tools.map((t) => t.name),
  "tools/list bytes:",
  JSON.stringify(tools.result).length
);
const ask = async (question, request) => {
  const t = performance.now();
  const r = await call("tools/call", {
    name: "inspect_typescript_graph",
    arguments: {
      question,
      draft: { reason: "smallest request that can answer", type: request.type },
      review: "the draft stands",
      request,
    },
  });
  const text = JSON.stringify(r.result);
  console.log(
    JSON.stringify({
      question,
      request: request.type,
      bytes: text.length,
      approxTokens: Math.round(text.length / 4),
      ms: Math.round(performance.now() - t),
    })
  );
  console.log(text.slice(0, 700).replace(/\\n/g, "\n"));
};
const lookup = await ask("Where is Transactor declared?", {
  type: "lookup",
  query: "Transactor",
});
await ask("How does Transactor work and what implements it?", {
  type: "details",
  handles: ["packages/domain/src/shared/transactor.ts#Transactor:class"],
});
await ask("What does a change to Transactor impact?", {
  type: "trace",
  from: "packages/domain/src/shared/transactor.ts#Transactor:class",
  direction: "impact",
});
await ask("Give me an architecture tour of the domain package", {
  type: "tour",
  reinterpretations: ["aggregate", "transaction", "outbox"],
});
console.log("total ms", Math.round(performance.now() - t0));
child.kill();
process.exit(0);
```

`packages/domain/lint.config.ts` (the `boundaries/*` rules generated from `tools/quality/moduleGraph.ts`; the tsconfig adds `{ "transform": "@ttsc/lint" }`):

```ts
import type { ITtscLintConfig } from "@ttsc/lint";

import { declaration } from "../../tools/quality/moduleGraph.ts";

const strip = (glob: string): string => glob.replace("packages/domain/", "");

const elements = declaration.modules.flatMap((module) =>
  module.files.map((glob) => ({ pattern: strip(glob), type: module.name }))
);

export default {
  rules: {
    "boundaries/element-types": [
      "error",
      {
        default: "disallow",
        elements,
        rules: declaration.modules.map((module) => ({
          allow:
            module.uses === "all"
              ? declaration.modules.map(({ name }) => name)
              : [module.name, ...module.uses],
          from: module.name,
        })),
      },
    ],
    "boundaries/no-unknown": ["error", { elements }],
  },
} satisfies ITtscLintConfig;
```

`tools/quality/lint.config.ts` (the evidence claim):

```ts
import {
  evidence,
  type ITtscEvidenceGraphConfig,
  type ITtscEvidenceRules,
} from "@ttsc/evidence";
import type { ITtscLintConfig } from "@ttsc/lint";

const graph: ITtscEvidenceGraphConfig = {
  claims: [
    {
      files: ["moduleGraphCheck.ts", "resolveImports.ts", "globImports.ts"],
      name: "module graph check implements spec 0020",
      reference: {
        files: ["0020-module-layers-check.md"],
        root: "../../docs/specs",
        symbol: ["h2"],
        type: "markdown",
      },
      symbol: "function",
      type: "typescript",
    },
  ],
};

export default {
  plugins: { evidence },
  rules: { "evidence/graph": ["error", graph], "evidence/review": "error" },
} satisfies ITtscLintConfig<ITtscEvidenceRules>;
```

## Revisions

- **2026-10-29, while building.** The spec was written with the first measurements and revised with the later ones: the first `compilerEdges.ts` fetched every file's syntax tree (see Speed); the first comparison counted the check's glob matches and repeated `export { … } from` entries as differences, so `edgeDifferences` now leaves out globs and counts a repeated place once; `apps/cms`, `tools/*` and the other units were added to the parity test after the domain passed.
- **2026-10-29, the first `bun run ready` failed once: the scratch files of other tests.** `test:all` runs this package's test files in parallel, and `storeBoundary.test.ts` and `moduleGraph.test.ts` write probe files into the live tree (`tools/quality/probes.ts`, spec 0020 round 1). The check's scan skips them; the compiler, which lists the directory, read `packages/cms-client/src/storeBoundaryProbe.ts` and four others, and the parity test reported them as five `the check has no such import` differences. `compilerEdges.ts` first skipped `isProbe` paths.
- **2026-10-29, the second `bun run ready` and the pre-push failed: generated files.** Skipping probes was a patch of one case. After `bun run check:cms` had run in the worktree, `apps/cms/.astro/content.d.ts` (generated, git-ignored, included by the tsconfig) was read by the compiler and not by the check, and the `apps/cms` case reported all its imports as `the check has no such import`. `compilerEdges` now takes `paths`, the files that git lists (`workingTreePaths`, which the scan uses and which skips probes and ignored files), and reads only those: the compiler never decides which files are the repository's. That is the answer to the first failure too, so `isProbe` is not imported. The same holds for any adoption: the file list comes from git, the edges from the program.
- **2026-10-29, landing decision (lead).** The code is not merged: a beta compiler and a child process of up to 0.9 GB do not belong in `tools/quality`'s dependencies or in `test:all` while the verdict is "not yet". This spec lands alone, with a `STATE.md` Next item for the adoption. PR #58 was closed with a pointer to this document and to the kept branch.
- **2026-10-29, ttsc added (operator-approved spike, lead's brief).** Section "The ttsc toolchain" and appendices A and B. The code is on the kept branch `spike/ttsc` (head `7b77369` when written). The scripts are scratch and are given in appendix B instead of as files: they would not pass this repository's lint, and the only thing worth keeping on a branch is the Go plugin.
