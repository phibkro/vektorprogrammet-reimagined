# Spec 0007d: the kernel exports each domain as an effx DomainDescription and answers to effx's vectors

Status: frozen 2026-10-27. Builds on main `e897f74`. It carries out the last consequence of ADR 0009: "The kernel exports each domain as an effx `DomainDescription`, and its tests check `authorize` and `Machine.can` against the conformance vectors that effx generates." The contract it exports to is effx spec 0032 §2 with its R1 and R2 (frozen 2026-10-26), read at effx `ce9c164d07909cfd99fbbb439f0f3ac26054e5c7` (main on 2026-10-27). Gate G1 (whether `@alchemy.run/domain` could replace the kernel and effx's model) is closed: it is an event-sourced runtime on Durable Objects or in memory, with no PostgreSQL platform and no grants, machines, privacy or formal layer, so it subsumes neither (operator research verdict, 2026-10-27). The draft of this spec was held until then; R1 records where the build differs from the draft.

## Journey

A developer changes who may do what, and a second reading of the rules, made by a tool that is not ours, says what the change does.

1. They delete `grant([member], ["viewTeams"], "department")` from `teams/declaration.ts`. **`vp run -r test` fails twice**, in `tools/effx-conformance`. The drift check says `teams: line 88 of the committed description is "viewTeams", the export says "sendEndingSoon"`: the committed description is no longer the export of the declarations. The conformance check prints the first rows where the kernel and the vectors differ: `viewTeams`, `Person$0`, `Target$0`, vectors yes, kernel no.
2. They run `bun run description`, which rewrites the descriptions and the register of gaps in seconds, and `EFFX_DIR=… bun run description:regenerate`. effx, at the pinned commit and on the pinned Alloy 6.2.0, decodes each description strictly, checks its assertions A1 to A7 and writes its vectors. The tool copies the vectors and the provenance only when effx accepts every description and every assertion passes; otherwise it changes nothing.
3. They commit the regenerated files with the declaration. The tests pass: for each of 29,198 instances, the kernel's `authorize` and its machine table answer every row as the vectors say. The pull request shows the change twice, as a change of code and as a change of rows.
4. They give a command a subject that effx cannot state (`anyone`). The export lists it as a typed gap (`UnexpressibleSubject`) in `gaps.json`, and the command leaves the description whole. The drift and register checks fail until the files are regenerated and committed: a gap is a visible diff and a decision, not a silent drop.
5. They make a mistake that only the formal model sees: a job's command without its grant, or a machine whose last state is not declared terminal. `description:regenerate` stops at effx's own assertion (`EFFX4307`, `EFFX4306`) and writes nothing.

## Problem

ADR 0009 says that the declarations generate the formal models, and that effx builds the emitters and checks in parallel. Three things stopped that from being true.

1. **Nothing exported a description.** The kernel's declarations (grant rows, subject sets, machine tables, `Info`) had no function to effx's `DomainDescription`.
2. **effx cannot be installed.** `npm view @effx/domain-model` and `@effx/ir` answer E404; effx is a Bun workspace whose packages are not published, and ADR 0009 forbids a dependency on an unpublished effx package. See "How this repository consumes effx".
3. **The two vocabularies do not match.** effx needs facts that the kernel never declared (a machine's terminal states, what each semester of a guard's context is, which machine says that a membership is active). The kernel has constructs that effx cannot state (`Anyone`, `Holder`, guards over ids and flags, prose conditions). Both directions had to be named, not guessed.

## Goal

Every domain of the kernel is exported, by a pure function of its declarations, as an effx `DomainDescription`. effx's own tooling turns each description into conformance vectors. The kernel's `authorize` and machine tables answer every row of the vectors as the vectors say. Every fact that crosses the boundary in one direction only is a typed, listed gap.

## Constraints

1. **No unpublished dependency.** ADR 0009 stands: `package.json`, the catalog and `bun.lock` gain no effx package. `bun run ready` and CI start no JVM, no Nix and no network for this slice.
2. **One source.** The description is derived, never edited. The vectors are made by a program that is not ours, from that description. The kernel keeps its one `authorize` and one `Machine`; this repository has no second interpreter of either, only an adapter that asks the kernel what the vectors ask.
3. **Provenance is data.** Each committed derivation names its origin (the effx commit, the Alloy version and executable, the digest of each description and of each vectors file) in a file that a test reads.
4. **effx is not edited.** A gap found in effx is an issue on `phibkro/effx` (below).
5. **Gates are not assumed.** Where the operator decides (G2 to G4 below), the spec builds against a declared stand-in, and approval is one change.

## Values

Correctness by construction: a description that is a function of the declarations cannot disagree with them, a machine without `terminal` does not compile, and a fact that cannot cross is a value in the types, not a silent default. One source of truth: the declarations. The ladder: the description is generated, the vectors are checked against the kernel, nothing is kept in sync by hand.

## How this repository consumes effx

| Option | Observed 2026-10-27 | Verdict |
| --- | --- | --- |
| A. A published `@effx/domain-model`, pinned in the catalog | `npm view @effx/domain-model` and `npm view @effx/ir`: E404. effx declares `publishConfig` but has published nothing. | Not possible today. When effx publishes, it replaces the script, not the artefacts. |
| B. A git dependency at a commit | `phibkro/effx` is public. `bun add --ignore-scripts github:phibkro/effx#ce9c164d` (Bun 1.4.2) stops with `error: Workspace dependency "@effx/cli" not found`: the root is a private workspace, Bun cannot select `packages/domain-model`, and its own dependencies `@effx/compiler` and `@effx/ir` at 0.1.0 are unpublished too. | Does not install, and ADR 0009 rules it out. |
| C. Vectors made by effx's tooling at a pinned commit, committed with provenance | The pipeline works (below). The `teams` vectors are 128 MB of JSON and 2.1 MB compressed; every other domain's are under 10 KB. The tests only read files. | **Chosen.** |
| D. Copy effx's `DomainDescription.ts` here to decode the export in `ready` | One file that imports only `effect`. It is a second copy of effx's contract and moves by hand with every effx change. effx decodes the description strictly when the vectors are made, with no copy. | Rejected. |

"Generated in effx CI" cannot work as the words say: effx's CI has no access to a description that lives here. The generating run is effx's tooling at the pinned commit, started with this repository's description, on a developer's machine (`EFFX_DIR` and Nix) or, once the operator approves it (G2), in a job of this repository's CI that checks out `phibkro/effx` at the pin (the repository is public, so no secret).

## Contract

### 1. The export

`Effx.describe(declaration)` (`packages/domain/src/kernel/effx.ts`) returns `{ description, gaps }` and does no I/O. `description` is an `Option` of effx's `DomainDescription` as plain data; the committed form is JSON with two-space indent (`Effx.committedJson`). Seven of the eight domains have one. `contact` has none: its only command is granted to `Anyone`. effx's package is not imported, so the export holds the plain form; effx decodes it strictly when the vectors are made.

| effx field | Source in the kernel | State |
| --- | --- | --- |
| `name` | `Declaration.name` | declared |
| `commands[]` | the tags of `Declaration.commands` that no gap touches; `runBy` is `info.job` | declared |
| `reads[]` | the keys of `Declaration.reads` that no gap touches | declared |
| `principals.System.jobs` | the literals of `SystemJob` | declared |
| `subjectSets`, `grants` | `Declaration.table` (the declared rows and the `Admin` row), by the translation below | declared |
| `machines[]` | `Declaration.machines`: states, transitions and, translated, guards; a machine that effx cannot be given whole is a gap | declared |
| `machines[].terminal` | the machine's own `terminal` | **new declaration**, required: `Machine.make` does not compile without it |
| `machines[].context.fields` | the machine's own `fields`: each semester that its guards read, by path, with its kind `stored` (in the row), `parameter` (of the command) or `clock` (the current semester); `order` is the one order of the kernel, `Semester` | **new declaration**, optional; a guard that reads an undeclared path is a gap |
| `orders`, `clock` | `Semester` when some machine has a field; the clock path of the machine that has a `clock` field | derived |
| `memberships` | `Domain.make({ memberships: { machine, grantingStates } })`; `teams` says `Membership` and `["Active"]` | **new declaration**, checked by `Domain.problems` |
| `adminList` | the one command of resource `AdminGrant` and method `create` (grant) and the one of method `delete` (revoke), by ADR 0010; no such pair is a gap | derived |

**Subject sets.** A grant row of several subjects is one grant over a `Union` of their sets, named by the notation of `docs/system/teams.md` and the scope (`Leader(d) + Board@department`).

| Kernel subject | effx expression under the row's scope |
| --- | --- |
| `Admin`, `Self`, `System(job)` | `Admin`, `Self`, `System { job }` |
| `Member`, `Leader`, `Fn(f)` (`Board` is `Fn(board)`) | `Membership` with `term: "active"`, the `department` below, and the position `leader` for `Leader`, the function `f` for `Fn(f)`, neither for `Member` |
| `Anyone`, `Holder(purpose)` | none: gap `UnexpressibleSubject` |

`department` is `"target"` under the scope `department` and `"any"` otherwise. It is `"target"` on the subject because the kernel asks one membership to hold the role and the department (`someMembership`), while effx applies a grant's scope as its own, second existential; only the subject's `"target"` ties the two to the same membership. The vectors cannot show this (R1, item 7); `test/kernel/effx.test.ts` pins it.

**Guards.** The kernel's checks are a closed vocabulary (`Guard.ids`). `after` and `same` become `effx/order/after` and `effx/order/same` with the same operand paths, `not` becomes `effx/guard/not` over its one operand, `or` becomes `effx/guard/or` over its operands in order, and a group of checks is a `FilterGroup`. A check outside the vocabulary (the Account machine's guards over ids and a flag) is a gap.

**A gap takes the command whole.** A command or read that a row names for a subject effx cannot state leaves the description, and so does a machine with a transition for it or with an untranslatable guard. A description that granted the command to the subjects it can state would answer "no" where the kernel answers "yes".

### 2. Gaps

`Effx.Gap` is a closed `Schema.TaggedUnion`. `packages/domain/conformance/gaps.json` is the register of today's gaps; the tests compare it with the export, so a new construct that effx cannot state is a failing diff and a decision.

| Gap | Today | Why |
| --- | --- | --- |
| `UnexpressibleSubject` | `Anyone`: `requestPasswordReset`, `submitContact`. `Holder`: `activateAccount`, `resetPassword` | effx subjects are memberships, `Self`, `Admin` and jobs. The four commands leave their descriptions; `contact` has none left. |
| `UnexpressibleGuard` | the Account machine: `different-person` and `not-last-active-admin` | They compare ids and a flag; effx's context fields are ordered values. |
| `MachineDropped` | the Account machine, twice (an unknown check, and a transition for a command that left) | A machine that cannot be given whole is not given at all: half a machine would be checked as if it were the whole. |
| `ProseGuard` | the two calculated transitions of the Membership machine | `when` is a sentence. effx models it as nondeterministic (EFFX4311); the check does not compare calculated transitions. |
| `UndeclaredWrites` | the five commands that apply the Membership machine | effx leaves a stored field fixed when no write is declared; precise effects are a later effx slice. |
| `AdminExpiry` | `teams` | The kernel's admin places end on a date; effx's `adminList.expiry` is a guard over a clock-bound context (EFFX4311). |
| `NoField` | the aggregate roots (`AdminList`, `Person`) | The description has no field for roots until effx's entity slice. |
| `NoDescription` | `contact` | Nothing is left to say. |
| `MissingDeclaration` | none today | A guard reads a semester that the machine's `fields` do not declare: the machine is left out, never given a default kind. |
| `AdminListUnclear` | none today | A domain has some of the admin list's commands but not exactly one grant and one revoke. |

### 3. The artefacts

`packages/domain/conformance/`, generated and left alone by the formatter:

- `<domain>.description.json`: the export, per domain that has one.
- `<domain>.vectors.json.gz`: effx's vectors of that description.
- `gaps.json`, the register of gaps.
- `provenance.json`: the effx commit, the nixpkgs revision, the Alloy version and executable (`/nix/store/…-alloy6-6.2.0/bin/alloy6`), and per domain the SHA-256 of the description and of the uncompressed vectors, the instances, scope, steps, order atoms, the rows compared, effx's assertion results and its `nondeterministic` and `unknownGuards` lists. It holds no date, so the same inputs give the same bytes.
- `effx.pin.json`: the effx commit and the Alloy version. Moving it is a deliberate change, with the files regenerated in the same commit.

### 4. The check

`tools/effx-conformance` (`vp run -r test`, files only). For every instance of every vectors file it builds the kernel's own values from atoms and compares:

- **Principals and targets.** `Anonymous` is `anonymous`; `Person$n` is a `Person` principal with id `n + 1`, the memberships that are `active` (department and team ids from their atoms, the team's `function`, `leader` when the position is `leader`) and an `adminUntil` far ahead when `admin`; a `System` is `systemPrincipal(job)`. A target is a resource with its owner's `personId` and its `departmentId`.
- **Authorization.** `authorize(principal, permission, resource)` against the instance's `allows`, for every principal, permission and target.
- **Machines.** The atoms of an order, sorted by `before`, are consecutive semesters. For every context, state (`[*]` and each declared state), transition and phase (`atNow`, and `afterTick` where the clock has a successor), `Arr.contains(from, state) && accepts(context)` against `enabled`; and `Machine.can` for each command against the `or` of its transitions' rows.
- **No vacuous pass.** `format` and `version` are decoded as literals; the number of rows compared must equal the number that the file's own structure asks for (`provenance.json` records it). An empty file fails.

### 5. Regeneration

`bun run description:regenerate` (`EFFX_DIR`: a clean checkout of effx at the pin, its dependencies installed, Nix on `PATH`). For each description it writes a scratch project outside both repositories (the description, a config module around it, and the checkout's `node_modules`), runs `effx build` and `effx models check` under `nix shell "$EFFX_DIR#alloy6"`, and reads the vectors and the assertion lines. Only when every description is accepted and every assertion passes does it write the files, in order: descriptions, vectors, register, provenance. It refuses an `EFFX_DIR` whose `HEAD` is not the pin, or that has local changes, and an Alloy that is not 6.2.0.

## Falsifiers

1. **The description is the kernel's.** `conformance.test.ts`: the committed description of every domain equals the export of the declarations now, and the failure names the domain and the first line that differs. Negative controls in the test: a grant row deleted, a scope changed and a state renamed in a declaration of `teams`; a hand edit of a committed description. Controls against the real source, C1 to C3 below.
2. **Provenance is true.** The digests of every description and vectors file and the pin are those of `provenance.json`. Negative control in the test: one changed character of a description, one flipped byte of the vectors.
3. **Conformance.** For every domain the kernel answers every row as the vectors say, and the rows compared are the rows asked: 891,780 authorization rows in seven domains (877,800 of them `teams`) and 835,584 transition rows (all `teams`). Negative controls in the test, each failing on exactly the rows it changes (`teams`, counted): the `Member` row of `viewTeams` removed, 1,344 rows, all `viewTeams`; the leaders' scope widened from `department` to `all`, 9,648 rows, each of a command in the leaders' row; the guard of `extendMembership` removed, 39,168 rows, all `extendMembership` in `Active` (19,584 transitions and 19,584 commands); an empty vectors file. C6 below is the control that only the vectors can give.
4. **Typed gaps.** `test/kernel/effx.test.ts`: the export of the real declarations lists exactly the gaps above, a command that a gap touches leaves its description, and each of the ten gaps appears in at least one test (among them a guard outside the vocabulary, a guard over an undeclared semester, a domain with a grant but no revoke, a domain whose every subject is `Anyone`); `conformance.test.ts` compares the committed register with the export, and a subject that effx cannot state adds a gap. `terminal` is required by the type: a type test (no suppression) fails `vp check` at `effx.test.ts` when `terminal` is made optional in `Machine.make` (mutation run, reverted). `Domain.problems` reports a terminal state that is not a state, a semester declared twice, two clocks, and memberships that name a machine or a state that the domain does not have.
5. **effx's own assertions.** Regeneration runs A1 to A7 on every description (`provenance.json` has the results: `teams` passes all nine runs; a domain without machines, a clock, an admin list or memberships reports A1, A4, A5 and A7 as NOT APPLICABLE, never PASS) and stops on a failing one. C4 and C5 below.
6. **Reproducible.** Two regenerations on one commit write byte-identical descriptions, vectors and provenance: after the second run, on the rebased tree, `git status` showed no changed file in `packages/domain/conformance` (1 m 38 s; the first run took 2 m 16 s).
7. **No dependency.** `bun.lock` changes by the new workspace and nothing else (17 lines, every dependency from the catalog); no catalog entry and no effx package. The tool's 11 tests pass with no directory that holds `nix`, `java` or `alloy6` on `PATH`.
8. **Repository gates.** `bun run ready` exits 0. `teams/declaration.ts` gains `fields`, `terminal` and `memberships`, and `verify-membership-writes` covers that file, so CI runs its model on this change. The covered diff is 10 added lines and no state, transition or guard, so the model needed a new digest and no new shape: `run.sh --code` exits 0 on the committed tree (26 of 26 runs as expected, 51 code tests on PostgreSQL), and the digest is re-confirmed in its own commit.

### Negative controls against the real source

Each mutation was applied once to the committed code, the checks ran, and the mutation was reverted (tree clean afterwards). "Drift" and "conformance" are the two checks of the journey, both run by `vp run -r test`.

| # | Mutation | What fails |
| --- | --- | --- |
| C1 | `grant([member], ["viewTeams"], "department")` deleted from `teams/declaration.ts` | drift: `teams: line 88 … "viewTeams" … "sendEndingSoon"`; conformance: `viewTeams`, `Person$0`, `Target$0`, vectors yes, kernel no (from instance 1564) |
| C2 | the same row's scope changed from `department` to `all` | drift: `teams: line 90 … "scope": "department" … "all"`; conformance: `viewTeams`, kernel yes, vectors no |
| C3 | the guard of `extendMembership` removed | drift: `teams: line 229` (`"guard"` against `"to"`); conformance: `Transition0_2` and `extendMembership` in `Active`, kernel yes, vectors no |
| C4 | `terminal: []` on the Membership machine | `description:regenerate` stops: `EFFX4306` (A2, nonterminal exit); exit 1; no file changed (1 m 18 s) |
| C5 | the `System(endingSoon)` grant of `sendEndingSoon` removed | `description:regenerate` stops: `EFFX4307` (A3, command grant); exit 1; no file changed (1 m 8 s) |
| C6 | the export drops `position: "leader"` from the `Leader` subject, descriptions, vectors and provenance regenerated to match (7 files changed) | drift and digests **pass** (the files agree with each other); the conformance check alone fails: `updateDepartment`, `Person$0`, `Target$0`, vectors yes, kernel no. Only the vectors can see a wrong translation. |
| C7 | the export drops the department from every membership subject (`"any"` for `"target"`), regenerated end to end | **nothing in the vectors**: the 11 tests pass, because with one department and at most one membership per person the two readings coincide (scope 1). The export's unit test (`a subject follows its scope`) fails. |
| C8 | none: a second regeneration of the unmutated tree | no file changed |

## What the vectors do and do not say

They say, for every instance that effx's model has at scope 1 and four steps (29,198 in all): who may run each described command and read about each target, and which transition of the Membership machine is enabled in which state, now and one semester later. They do not say:

- **Anything that needs two of something.** A world has one person, one team, one department and one target (effx's default scope). A defect that is wrong only across two departments, or two memberships of one person, is invisible; C7 is the example. The kernel's rule-named tests (`authorize.test.ts`, `grants.test.ts`), which use two departments, are what cover it. The authorization-only description of `teams` at scope 2 did not finish in 7 minutes (about 39 CPU-minutes, no vectors written; measured with a hand-translated probe), so scope 2 is not a choice today (effx issue 8).
- **Anything in a gap.** Four commands and the Account machine are not compared (`gaps.json`); the calculated transitions are prose, and the commands' writes are undeclared.
- **The Admin place's expiry.** effx models it as nondeterministic.

## Out of scope

Running Alloy in `ready`; replaying traces through handlers (effx's later slice); exporting entities, relationships, events or roots; precise command effects (`writes`); the HTTP API; Quint, TLA+ and Cedar; any change to effx.

## Open gates

- **G1 (closed 2026-10-27).** `@alchemy.run/domain` does not subsume the kernel or effx's model.
- **G2 (operator, open).** A job in `.github/workflows/checks.yml` that checks that effx would make the committed vectors again: check out `phibkro/effx` at the pin, install Nix and its dependencies, `bun run description:regenerate`, `git diff --exit-code packages/domain/conformance`. It needs 1.5 to 2.5 minutes and no secret. Stand-in: the regeneration runs on the developer's machine and its result is read in the diff; CI's `vp run -r test` checks that the files are consistent with the declarations and with each other, but not that effx would write them again. Approval is one workflow job.
- **G3 (effx, open).** Publication of `@effx/*` (effx issue 5). It would replace the regeneration script, not the committed files.
- **G4 (operator, open).** Retention of the vectors: a regeneration that changes `teams` adds about 2.1 MB to history. Stand-in: plain files in git. The alternative is object storage or release assets with the digest in git.

## effx-side gaps (issues filed on `phibkro/effx`, effx not edited)

| Issue | What |
| --- | --- |
| 5 | `@effx/*` are unpublished, and the repository cannot be installed as a git dependency |
| 6 | `models check` outside the effx tree: the description only through a config module, `effect` resolved from the project, assertion results only as stdout text |
| 7 | `ConformanceVectors` does not identify its description, and is 128 MB of JSON for a three-state machine |
| 8 | One scope for every signature: cross-department rows need scope 2 for the whole world (with the C7 case as a comment) |
| 9 | `DomainDescription` cannot state anonymous callers, credential holders, or guards over ids and flags |

## Revisions

### R1 (2026-10-27): the draft against the build

The contract stands. These are the places where building it showed a fact that the draft did not have.

1. **Where the files are.** `packages/domain/conformance/` (the draft left the place free). The tool is `tools/effx-conformance`.
2. **`terminal` is required by the type.** The draft made a missing `terminal` a `MissingDeclaration` gap. The type is stronger: `Machine.make` does not compile without it. `MissingDeclaration` now means a guard reads a semester that the machine's `fields` do not declare.
3. **The drift check is a test.** The draft had `generate --check`. `bun run description` writes; `vp run -r test` checks, and names the domain and the first differing line.
4. **More gaps than the draft listed.** `MachineDropped` (a machine that cannot be given whole is not given at all), `NoDescription`, `AdminListUnclear`, and `NoField` with its values. A domain whose every command a gap touches (`contact`) has no description.
5. **The check compares `Machine.can` as well as each transition.** A command is enabled when some transition of it is; the draft compared transitions only.
6. **Sizes and times.** The `teams` vectors are 128 MB of JSON and 2.1 MB compressed (the draft's probe, a hand-translation, had 92 MB and 0.75 MB at `gzip -9`; `CompressionStream` has no level). Regeneration of all seven descriptions took 2 m 16 s (7 CPU-minutes) and then 1 m 38 s (4 CPU-minutes), not the probe's 57 s for one domain.
7. **The vectors check the translation only as far as a scope-1 world can show it.** The draft said "translation checked by the vectors". C6 shows that they do catch a wrong translation that scope 1 can see; C7 shows one that they cannot, because the subject's department and the grant's scope are two existentials in effx and coincide with one membership. The department binding is pinned by a unit test of the export instead, and the limit is recorded above and in effx issue 8.
8. **A fact about effx that the draft guessed.** effx writes the vectors of a model even when an assertion fails (C4, C5 printed `wrote 26742 vector instances` before the error); the tool keeps nothing of a failing run.
9. **`Domain.namesOf`** is exported: the export and `Domain.problems` read one list of the names that a declaration's grant rows may carry, instead of two copies (jscpd found the second).
10. **EX-0030** registers the one lint false positive of the tool (a `Schema.TaggedError` declaration, as EX-0003 does).
