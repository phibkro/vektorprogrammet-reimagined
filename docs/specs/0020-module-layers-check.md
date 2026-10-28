# Spec 0020: A check for the module graph, and no integration call inside a transaction (ADR 0015, stages 1 and 1b)

**Status:** frozen when its PR opens; later changes are dated entries under [Revisions](#revisions) · **Source:** ADR 0015 (`docs/decisions/0015-module-layers.md`), accepted by the operator on 2026-10-28; its "Decision" sections 4, 5 and 10, its falsifiers F1 to F11 and its staged plan, rows 1 and 1b · **Branch:** `feat/module-layers-check`, from main `ddb6ff1` (spec 0018 is merged there).

## Journey

Nothing a user sees moves. The journeys are a developer's and a reviewer's.

1. **A developer adds an import that points upward.** She makes `kernel/guard.ts` import `organisation/commands.ts`. `bun run check:module-graph` (and the pre-push hook, and CI) fails with `packages/domain/src/kernel/guard.ts:<line>: imports packages/domain/src/organisation/commands.ts (module organisation, service), an upward import from module kernel (library)`.
2. **A developer closes a cycle.** She makes a file of `teams/` import `accounts/commands.ts`. The check names both import sites: the new one, and the `accounts` file that already imports `teams`, as `packages/domain/src/accounts/commands.ts:<line> (iam imports membership)`.
3. **A developer adds a file in a new directory.** `packages/domain/src/elections/vote.ts` is in no module, and the check says so. She lists it in a module of `tools/quality/moduleGraph.ts` in the same change, and the reviewer sees the layer she chose as one line.
4. **A developer needs a package in a library.** She imports `node:fs` in `shared/ids.ts`: the check says a module imports only `effect` and the packages its row names.
5. **A developer calls the mail provider inside a transaction.** She writes `transactor.run(Effect.andThen(enqueue, sendsMail))`. `vp check` fails: the program requires `MessageSender`, which is an `IntegrationPort`, and `Transactor.run` takes only `NotAnIntegration` requirements. She moves the call to `prepare` (before the transaction) or after the commit, and it compiles.
6. **A reviewer reads a stage of ADR 0015 land.** The baseline of today's violations is eight imports with their reasons. A later stage that removes an import must also delete its entry and lower the count that `moduleGraph.test.ts` pins; a stage that adds an import cannot hide behind the list.

## Goal, constraints, values

- **Goal:** ADR 0015 stage 1: the module declaration (globs over today's layout), a check built on `oxc-parser` in the pattern of `storeBoundary.ts`, a shrink-only baseline of today's violations, Oxlint's `import/no-cycle` for `packages/**`, wired into `bun run ready`, CI and the docs. And stage 1b: integration rule 1 of ADR 0015 section 10 (no integration call inside a transaction) as a type.
- **Constraints:**
  - **No file moves and no cycle is broken.** Stages 2 and later do that. The check reports exactly the baseline on the real tree.
  - **One declaration** (`tools/quality/moduleGraph.ts`), read by the check and by its tests; the root `vite.config.ts` reads the same `acyclic` globs for the lint. A second list is a representable disagreement.
  - **No new dependency.** The parser, the glob matcher and the file listing are those of `storeBoundary.ts` (`oxc-parser`, `globToRegExp`, `workingTreePaths`); `importSpecifiers.ts` is the one place that reads imports now, and `storeBoundaryCheck.ts` uses it.
  - **The marker is a phantom.** A port declares it in its class body; no Layer, adapter or test composition changes.
  - **Every commit green; no shim.** A generic function that passes a program to `Transactor.run` gets the bound itself.
- **Values:** a type error beats a test beats a review; the rule is declared once and its derivations read it; the baseline is a debt with a reason, not a switch.

## Requirements

| # | Requirement |
| --- | --- |
| R1 | `tools/quality/moduleGraph.ts` declares 17 modules by file glob (ADR section 3, with the files of spec 0018 and `shared/isolationProbe.ts` placed), each with a layer (library, service, catalog, privacy, assembly), its `uses`, its allowed external packages; the units (`packages/*`, `apps/*`, `tools/*`) with the packages each may import; the `acyclic` globs; the `baseline`. |
| R2 | `bun run check:module-graph` reads every source file under `packages/`, `apps/` and `tools/` and fails on: a file of `packages/domain/src` in no module or in two (rule 1); an import of another module that is undeclared or points to a higher layer, with the cycle it closes when it closes one (rule 2); a cycle in the declared `uses`, a `uses` entry that names no module or a higher layer (rule 3); a file cycle in `acyclic` (rule 3); a declared `uses` entry no file needs, a unit `uses` entry no file needs, a glob that matches no file (rule 4); a module import of anything but `effect` and its row's packages (rule 5); a file in no unit, an import of an undeclared unit or of an unknown workspace name, an import of another unit by a relative path (rule 6, rule 8); a broken rule that is not on the baseline, and a baseline entry that is no broken rule any more (rule 7). |
| R3 | The baseline lists today's eight violations, each with its reason and the stage that removes it. `moduleGraph.test.ts` pins the list. |
| R4 | `import/no-cycle` (`ignoreTypes: false`) is on for `packages/**`; the check's `acyclic` globs say the same, and a test shows the two agree (F8). |
| R5 | `check:module-graph` is in `bun run ready` and in `.github/workflows/checks.yml`; `moduleGraph.test.ts` runs the check on the real tree, so it also runs in `test:all` and the pre-push hook. `AGENTS.md` (architecture bullet and the gates table) and the domain README say so. |
| R6 | `IntegrationPort` marks `WorkspaceDirectory`, `WorkspaceWriter`, `MessageSender`, `TurnstileVerifier` and `Auth`. `Transactor.run` takes `R extends NotAnIntegration`. A program that requires a marked port does not type-check there, for the ports of `apps/web` and of the domain. |
| R7 | The callers that pass a generic program to `Transactor.run` carry the bound: `runCommandOutcome`, `runPreparedCommand`, `runCommand` (`CommandServices`), the job scheduler (`Runner<R, Providers>`: the commit's services are `NotAnIntegration`, the ports are what only `prepare` may call), and the test helpers. |

## Falsifiers

Each has a negative control (the same input without the fault passes, or the mechanism removed makes the test fail). The tests in `tools/quality/test/moduleGraph.test.ts` use a fixture declaration of the shapes of the ADR, so a clean map is `[]` and each case changes one thing; F9 uses the real tree.

| # | Falsifier | Negative control | Where |
| --- | --- | --- | --- |
| F1 | A file in `team` imports `login`, which imports `team`: the check fails and prints both import sites; a cycle through three modules prints every hop | The same map without the new import is `[]` | `moduleGraph.test.ts` § F1 |
| F2 | `kernel` imports a service; a service imports the catalog; the catalog imports Privacy: each fails as an upward import; an upward `uses` fails by itself | The same map with the edges in the allowed direction is `[]` | § F2 |
| F3 | `contact` imports `login` (undeclared): fails; a cycle in `uses` fails by itself | The declared edge `login` -> `team` is `[]` | § F3 |
| F4 | A declared module or unit edge that no file uses fails | Removing it from the declaration is `[]` | § F4 |
| F5 | A file in a new directory matches no module and fails; a file two modules list fails; a glob that matches nothing fails | The same file under a mapped glob is `[]` | § F5 |
| F6 | A library that imports `node:fs`, `cloudflare:workers` or `@vektorprogrammet/db` fails | An import of `effect` or `effect/rpc` is `[]`; `sanitize-html` passes in the row that names it and fails elsewhere | § F6 |
| F7 | `apps/web` imports `apps/cms` by a path or by name, `packages/domain` imports a workspace package, a file in no unit, an unknown workspace name: each fails | A baselined leak is `[]`; a baselined leak that no file needs fails; the baseline covers only the pair it names | § F7 |
| F8 | The oracle: a fixture with a known cycle gets the same verdict from the check and from `vp lint` (`import(no-cycle)`, on both files); for the real domain both say acyclic | The same fixture without the cycle: both say none | § F8 |
| F9 | The real tree: the check reports `[]` with the baseline and exactly the eight baselined imports without it; one real import added in memory (`contact` using `iam`) adds one finding; the baseline is pinned at eight entries by name | Removing the baseline is eight findings; adding an import is one | § F9 |
| F10 | _After stage 4_ (directory = module, the lint generated from the declaration). **Not applicable here**: stage 4 is not built. | — | — |
| F11 | A program that requires `WorkspaceDirectory`, `WorkspaceWriter`, `MessageSender`, `TurnstileVerifier` or `Auth`, alone or with a store port, does not type-check as the argument of `Transactor.run`: asserted as `Accepts<R>`, whether the real signature of `run` is assignable to a function that takes a program with requirements `R`, which is false for each of them (positive type assertions that suppress nothing; `vp check` fails the day one flips) | The same calls after the transaction has committed type-check and keep their requirements; a store port (`Outbox`), the transaction alone and no requirement are accepted, and `run` takes the transaction off the requirements; the rule's limit (a program that provides the port inside) is shown to compile | `packages/domain/test/shared/integrationPorts.types.test.ts`, `apps/web/test/integrationInTransaction.types.test.ts` |

A control fails every time without its mechanism. The deterministic checks are shown by removing each mechanism once (a mutation of `moduleGraphCheck.ts` that the PR body lists with the failing test names); there is no race here, so five runs of one mutation add nothing.

## Prior art

- **Reused:** the pattern, parser, glob matcher and file listing of `storeBoundary.ts` (spec 0017); Oxlint's `import/no-cycle` (Oxlint 1.88.0 in `vp`), for the oracle and the editor; ADR 0015's measurement and options table (dependency-cruiser does not read TypeScript 7; eslint-plugin-boundaries and Nx rejected there).
- **Evaluated, not used:** `effect/Graph.stronglyConnectedComponents` (Effect 4.0.6). It is `@stability unstable`, `effecttsgo/unstable-api-usage` rejects it, and the policy would need a registered unstable-API exception for 20 lines; `cycles` in `moduleGraphCheck.ts` is a reachability walk over a few hundred nodes. The installed guidance (`node_modules/effect/AGENTS.md`, `ai-docs/src`) has no entry for `Graph`; its source and JSDoc were read.
- **Effect version 4.0.6.** Guidance read: `Context.Service` classes (`Context.ts` `ServiceClass`, whose instance type is the requirement), `Effect.Services`, `Arr`, `Option`, `Order`, `Schema.fromJsonString` and `decodeUnknownEffect` as `storeBoundary.test.ts` uses them.

## Not done here

- **Stage 2 onwards**: the baseline is removed by stages 2, 3 and 5; nothing here moves a file, splits `shared/outbox.ts`, or moves `worker.config.ts`.
- **`CmsClient` is not marked.** It is EmDash's client and so an integration by the ADR, but `packages/cms-client` may not import the domain (its unit row), where the marker lives. Stage 4 splits the package; the generated client then goes to `packages/integrations/emdash`, which may. Until then the commands of `apps/web` exclude it by name (`CommandServices` in `runtime.ts`), which covers `runCommand` and `runPreparedCommand`; a program that a test or a script passes to `Transactor.run` directly is not covered. Only `site/pages.ts` requires it today, in reads.
- **`FileStore` (R2) is not marked**: the ADR makes R2 the platform, which may take part in the transaction; `Outside` stays a convention for it (`transactionModes.ts`).
- **The rule reads requirements.** A program that builds its provider inside (`Effect.provide(Layer)`) is not refused. The control of spec 0008 falsifier 2 does exactly that, on purpose.
- **ADR rules 2 to 4** of the integration category (stand-ins, declared personal data, secrets in the background Worker) are stages 9 to 11.
- **Folding `storeBoundary.ts` into the declaration** is stage 6.

## Revisions

- **2026-10-28, while building.** The ADR measured main `797e9e4`; this branch starts from main `ddb6ff1`, which holds spec 0018. Four things differ from the ADR's table, and none changes a rule:
  1. `audit` imports `transactions` (`AuditLog.record` now requires `InTransaction`): the declared row for `audit` gains `transactions`.
  2. `tools/quality` imports the domain in three test files (`storePorts.test.ts`, `inTransactionProviders.test.ts`, `support/proofReferences.ts`), which spec 0018 added: the unit row says so (ADR section 7's rule: a tool may import a package's declarations).
  3. `shared/isolationProbe.ts` (0018) is placed in `transactions`; `shared/guarantees.ts` and `shared/transactionModes.ts` in `assembly`, as the ADR's "Evidence limits" says they must be.
  4. `tools/db-path-spike` imports `packages/db` in four files: its row declares `packages/db` (its allowance in `storeBoundary.ts` says it is an adapter-level harness by design), and only its `apps/web` import is baselined. The baseline is therefore 3 imports between modules and 5 between packages (8), not "3 and the package leaks" of the ADR's wording.
- **2026-10-28, F11 as a bound, not a conditional.** The first form, `program: Effect<A, E, R> & OutsideIntegrations<R>`, works for concrete programs and cannot be satisfied by a generic caller. The bound `R extends NotAnIntegration` composes (a generic wrapper writes the same bound), and the error names the port. `NotAnIntegration` is `object & { [IntegrationTypeId]?: never }`: with `key: string` instead of `object` the type rejected `SqlClient` (not a service class), and with the optional property alone TypeScript's weak-type rule rejected every unmarked service. Both attempts were tried in a scratch file; the type-check of the whole repository is the evidence.
- **2026-10-28, what the bound found.** Passing the type check needed four changes that are the rule working: `Runner<R>` of the job scheduler mixed what `prepare` may call (providers) with what the commit may require (inside the transaction), so it is now `Runner<R extends NotAnIntegration, Providers>`; `runCommandOutcome` and its two wrappers got `CommandServices`; `apps/web/test/workspace.postgres.test.ts` names the directory as a provider; the delivery boundary's negative control (spec 0008 falsifier 2) provides its probe inside the transaction, since a program that requires `MessageSender` no longer compiles. No production program was found that called a provider inside `Transactor.run`.
- **2026-10-28, `Auth` is marked.** The ADR names Better Auth as an integration, and its calls already run outside the transaction (the AGENTS.md note on code delivery); marking it costs nothing and the type check found no violation.
- **2026-10-28, shared lint harness.** `storeBoundary.test.ts` and `moduleGraph.test.ts` both run `vp lint` on probe files; the clone detector (`jscpd`, threshold 0) failed on the copy, so the harness moved to `tools/quality/test/support/lintProbes.ts` and `storeBoundary.test.ts` uses it.
- **2026-10-28, F11 without a directive.** The first form of the tests used `@ts-expect-error` (EX-0050, as EX-0024 and EX-0026 do). The Effect lint rule `effecttsgo/missing-effect-context` reports the same call on its own and a directive does not silence it: it failed on a first pre-commit run and passed on the second, with identical content, so it is not stable under a directive. `Accepts<R>` asks the same question of the real `run` and needs no directive and no registry entry, so EX-0050 was removed. A scratch file with the unsuppressed call gives the compiler's message: `Type 'MessageSender' is not assignable to type 'NotAnIntegration'` (in the PR body).
- **2026-10-28, a scan that read formatting.** Marking a port wraps its class heritage over two lines (`export class X` then `extends Context.Service<…>() implements IntegrationPort`). `tools/quality/test/storePorts.test.ts` found the domain's services with a regex that needed `export class X extends Context.Service<` on one line, and `test:all` failed because it no longer saw `WorkspaceDirectory` and `WorkspaceWriter`. The regex now accepts whitespace between the words, and its control gains a wrapped class with an `implements` clause; the control fails with the old regex (shown in the PR body).
- **2026-10-28, numbers.** Spec 0020 (this), 0019 (ProofLive) and 0021 (RetentionEffect) were agreed by message.
