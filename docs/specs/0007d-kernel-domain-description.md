# Spec 0007d: the kernel exports each domain as an effx DomainDescription and answers to effx's vectors

Status: **in build 2026-10-27** (the hold ended the same day: the operator's research verdict is that `@alchemy.run/domain` is an event-sourced runtime on Durable Objects or in memory, with no PostgreSQL platform and no grants, machines, privacy or formal layer, so it does not subsume the kernel or effx's `DomainDescription`; Gate G1 is closed). Builds on main `085376f`. It carries out the last consequence of ADR 0009: "The kernel exports each domain as an effx `DomainDescription`, and its tests check `authorize` and `Machine.can` against the conformance vectors that effx generates." The contract it exports to is effx spec 0032 §2 with its R1 and R2 (frozen 2026-10-26), read at effx `ce9c164d07909cfd99fbbb439f0f3ac26054e5c7` (main on 2026-10-27).

## Journey

A developer changes who may do what, and a second reading of the rules, written by someone else, says what the change does.

1. They delete `grant([member], ["viewTeams"], "department")` from `teams/declaration.ts`. **`bun run ready` fails** in the conformance test. It prints two things: the description of `teams` is no longer the one that its vectors were made from (two digests), and the rows where the kernel now disagrees with the vectors, such as "a person who is a member of the department may `viewTeams`: vectors yes, kernel no".
2. They run `bun run description:regenerate` with `EFFX_DIR` set to an effx checkout at the pinned commit. effx decodes the new description strictly, checks its assertions on Alloy 6.2.0 and writes new vectors. The script copies the description, the vectors and `provenance.json` into this repository. When effx reports an error it changes nothing.
3. They commit the regenerated files with the declaration. `bun run ready` passes: for every instance of the vectors, `authorize` and every machine table answer as the vectors say. The pull request shows the change twice, as a change of code and as a change of rows.
4. They add a subject set that effx cannot state. **The export reports a typed gap** and the conformance test fails until the gap is in the committed register. Nothing is dropped without a name.

## Problem

ADR 0009 says that the declarations generate the formal models, and that effx builds the emitters and checks in parallel. Three things stop that from being true today.

1. **Nothing exports a description.** The kernel's declarations (grant rows, subject sets, machine tables, `Info`) have no function to effx's `DomainDescription`.
2. **effx cannot be installed.** `npm view @effx/domain-model` and `@effx/ir` answer E404; effx is a Bun workspace whose packages are not published. ADR 0009 forbids a dependency on an unpublished effx package. See "How this repository consumes effx".
3. **The two vocabularies do not match.** effx needs facts that the kernel never declared (a machine's terminal states, the kind of each context field, the clock, which machine says that a membership is active). The kernel has constructs that effx cannot state (`Anyone`, `Holder`, guards over ids and flags, prose conditions). Both directions must be named, not guessed.

## Goal

Every domain of the kernel is exported, by a pure function of its declarations, as an effx `DomainDescription`. effx's own tooling turns that description into conformance vectors. The kernel's `authorize` and machine tables answer every row of the vectors as the vectors say. Every fact that crosses the boundary only one way is a typed, listed gap.

## Constraints

1. **No unpublished dependency.** ADR 0009 stands: `package.json`, the catalog and `bun.lock` gain no effx package. `bun run ready` and CI start no JVM, no Nix and no network for this slice.
2. **One source.** The description is derived, never edited. The vectors are made by a program that is not ours, from that description. The kernel keeps its one `authorize` and one `Machine`; there is no second interpreter in this repository except the adapter that reads the vectors.
3. **Provenance is data.** Each committed derivation names its origin (effx commit, Alloy version and jar digest, the digest of the description and of the vectors) in a file that a test reads.
4. **effx is not edited.** A gap found in effx is an issue on `phibkro/effx`.
5. **Gates are not assumed.** Where the operator decides (G1 to G4 below), the spec builds against a declared stand-in and the approval is one line.

## Values

Correctness by construction: a description that is a function of the declarations cannot disagree with them, and a fact that cannot cross is a value in the types, not a silent default. One source of truth: the declarations. The ladder: the description is generated, the vectors are checked against the kernel, nothing is kept in sync by hand.

## How this repository consumes effx

| Option | Observed 2026-10-27 | Verdict |
| --- | --- | --- |
| A. A published `@effx/domain-model`, pinned in the catalog | `npm view @effx/domain-model` and `npm view @effx/ir`: E404. effx declares `publishConfig` but has published nothing. | Not possible today. When effx publishes, it replaces the script, not the artefacts. |
| B. A git dependency at a commit | `phibkro/effx` is public (`git ls-remote` works without a login). `bun add --ignore-scripts github:phibkro/effx#ce9c164d` (Bun 1.4.2) stops with `error: Workspace dependency "@effx/cli" not found`: the root is a private workspace, Bun cannot select `packages/domain-model`, and its own dependencies `@effx/compiler` and `@effx/ir` at 0.1.0 are unpublished too. | Does not install, and ADR 0009 rules it out. |
| C. Vectors made by effx's tooling at a pinned commit, committed with provenance | The pipeline works (investigation record). Committed vectors compress about 120 times (94 MB of JSON to 0.75 MB). `ready` only reads files. | **Chosen.** |
| D. Copy effx's `DomainDescription.ts` here to decode our export in `ready` | One file that imports only `effect`. It is a second copy of effx's contract and moves by hand with every effx change. The same decode runs at regeneration, inside effx, with no copy. | Rejected. |

"Generated in effx CI" cannot work as the words say: effx CI has no access to a description that lives here. The generating run is effx's tooling at the pinned commit, started with this repository's description, in one of two places: a developer machine (`EFFX_DIR` and Nix) or a job of this repository's CI that checks out `phibkro/effx` at the pin (the repository is public, so no secret). The second is Gate G2.

## Contract

### 1. The export (pure, in the kernel)

`describe(declaration)` returns `{ description, gaps }` and does no I/O. One description per `Declaration` that keeps at least one command: seven of the eight domains today (`contact` has one command, and its only subject is `Anyone`, so it has a gap and no description). `description` is effx's `DomainDescription` as plain JSON; the committed form is canonical JSON (sorted keys, two spaces). `gaps` is a list of the closed `Gap` union of section 2.

| effx field | Source in the kernel | State |
| --- | --- | --- |
| `name` | `Declaration.name` | declared |
| `commands[].name`, `kind` | the tags of `Declaration.commands` that the description can state | declared |
| `commands[].runBy` | `info.job` | declared |
| `commands[].writes` | none | gap `UndeclaredWrites` (effx 0032 R1 leaves effects to a later slice) |
| `reads[]` | the keys of `Declaration.reads` | declared |
| `principals.System.jobs` | the literals of `SystemJob` | declared |
| `subjectSets`, `grants` | `Declaration.table` (declared rows and the Admin row). One set per pair of subject and scope; a row with several subjects is a `Union`. A departmental subject takes `department: "target"` under the scope `department`, `"any"` under `all`, and always `term: "active"`; `Leader` is `position: "leader"`, `Fn(f)` is `function: f`, `Member` has neither. | declared; translation checked by the vectors |
| `machines[]` | `Declaration.machines`: states, transitions and, translated, guards. `vektorprogrammet/semester/{after,same}` become `effx/order/{after,same}`; `…/not` and `…/or` become `effx/guard/{not,or}` with the nested checks of the kernel's `schemas`. | declared |
| `machines[].terminal` | none | **new declaration**, required on every machine |
| `machines[].context.fields` | the semester paths of the context schema (`SemesterPath`), each with its kind: `stored` in the row, `parameter` of the command, `clock` for the current semester | **new declaration**; absent kind is a `MissingDeclaration` gap |
| `orders`, `clock` | the semester order; the clock path of the context | derived from the two rows above |
| `memberships` | the Membership machine and its granting states (`Active`) | **new declaration** on the domain; a test ties it to `membershipState` |
| `adminList` | the commands with resource `AdminGrant` and method `create` (grant) and `delete` (revoke), by ADR 0010; absent or ambiguous is a gap | derived |

The two "new declaration" rows are the only changes to the kernel's declarations: optional-looking facts that effx needs and that the kernel's own code already depends on. They are small and typed by the machine's states and context.

### 2. Gaps

`Gap` is a tagged union in the kernel. The register of today's gaps is committed (`gaps.json`, generated) and the test compares it with the export, so a new construct that effx cannot state appears as a failing diff and a decision, not as a missing row.

| Gap | Where today | Why |
| --- | --- | --- |
| `UnexpressibleSubject` | `Anyone`: `requestPasswordReset`, `submitContact`. `Holder(purpose)`: `activateAccount`, `resetPassword` | effx subject sets name memberships, `Self`, `Admin` and jobs. None matches an anonymous caller or a credential's narrowing (`Principal.narrowing`). The command leaves the description. |
| `UnexpressibleGuard` | the Account machine: `different-person`, `not-last-active-admin` | They compare ids and a flag; effx contexts hold ordered fields. The transition stays in the description without its guard, as effx models an unknown id, and the check compares `from` states only. |
| `ProseGuard` | the two calculated transitions of the Membership machine | `when` is a sentence. effx models it as nondeterministic (EFFX4311, observed). Conformance does not compare calculated transitions. |
| `UndeclaredWrites` | the five membership commands that apply the machine | An undeclared write leaves a stored field fixed in effx's temporal model; the real effect is a later slice of effx. |
| `NoField` | `AggregateRoots` (`AdminList`, `Person`) | The description has no field for roots until effx's entity slice. |
| `AdminExpiry` | the admin list | The kernel's places end on a date. effx's `adminList.expiry` is a guard over a clock-bound context (EFFX4311, observed). |
| `MissingDeclaration` | none today | A machine without `terminal` or a field kind. The export fails closed: no description, never `terminal: []` by default. |

### 3. The artefacts

For each domain, committed under `packages/domain/effx/` (the location is free): `<domain>.description.json`, `<domain>.vectors.json.gz`, and one `provenance.json` and `gaps.json`. Provenance holds: the effx commit; the Alloy version and jar sha256 (`6b8c1cb5…edb78d` in effx's research record); the nixpkgs revision of effx's `flake.lock`; per domain, the sha256 of the canonical description and of the uncompressed vectors; scope, steps and instance count; effx's assertion results (A1 to A7) and its `unknownGuards` and `nondeterministic` lists. It holds no date, so the same inputs give the same bytes.

### 4. The check (kernel side, in `vp run -r test`)

For every instance of every vectors file the adapter builds kernel values from atoms and compares:

- **Principals.** `Anonymous` is `anonymous`; `Person$n` is a `Person` principal with id `n + 1`, the memberships that are `active` (department and team ids from their atoms, `function` of the team, `leader` when the position is `leader`) and an `adminUntil` far ahead when `admin`; a `System` is `systemPrincipal(job)`. A target is a resource with `personId` for its owner and `departmentId` for its department.
- **Authorization.** `authorize(principal, permission, resource)` against the instance's `allows`, for every principal, permission and target.
- **Machines.** The atoms of an order, sorted by `before`, are consecutive semesters (rank 0 is Vår 2026). For every context, state (`[*]` and each declared state), transition and phase (`atNow`, `afterTick`, the clock replaced by its successor), `Arr.contains(from, state) && accepts(context)` against `enabled`; `Machine.can` for a command is the `or` of its transitions. A transition whose guard is a gap is compared on `from` only.
- **No vacuous pass.** The vectors' `format` and `version` are checked; every permission of the description, and every machine and transition, appears in the vectors; the number of rows compared is printed and must equal the count recomputed from the vectors' own structure.

### 5. Regeneration

`bun run description:regenerate` (tool package beside `tools/docgen`; `generate` writes the descriptions and `generate --check` is the drift check) writes, in a directory outside both repositories, a project with a config module around the committed description (as effx's `alloy.test.ts` does), runs `effx build` and `effx models check` under `nix shell "$EFFX_DIR#alloy6"`, and copies the results here only when effx exits 0. It refuses an `EFFX_DIR` whose `HEAD` is not the commit in `provenance.json`. Moving the pin is a deliberate change of that one value, with the regenerated artefacts in the same commit.

## Falsifiers

1. **The description is the kernel's.** The committed description of each domain equals `describe` of the current declarations. Negative controls: delete one grant row, change one scope, and rename a state in a declaration; each fails and names the domain and the path. A hand edit of a committed description fails the same way.
2. **Provenance is true.** The test recomputes the description and vectors digests and compares them with `provenance.json`. Negative controls: one flipped byte in a description, one in the vectors.
3. **Conformance.** Every row of every domain agrees. The probe below (a hand-translated `teams` description, before any code) compared 611,324 authorization rows and 589,824 machine rows with no disagreement. Negative controls, in-process mutants of the kernel's runtime table against the committed vectors, each failing on exactly the rows it changes: `viewTeams` removed from `Member` (probe: 960 rows, all `viewTeams`); the `Leader` row widened to scope `all` (6,912 rows); the guard of `extendMembership` removed (13,824 machine rows, all `extendMembership`). An empty vectors file fails (no vacuous pass).
4. **Typed gaps.** The export of the real declarations returns exactly the register. Negative controls: remove `terminal` from the Membership machine, so the export is `MissingDeclaration` and there is no description (not `terminal: []`); add a `holder` row to a domain that had none, so the register gains an `UnexpressibleSubject`; add a command with a resource and a `delete` method on `AdminGrant`, so the admin list is ambiguous.
5. **effx's own assertions.** Regeneration runs A1 to A7 on every description and exits non-zero on a failing one, leaving every committed file as it was. Negative control: a scratch copy in which a command has no grant must produce effx's A3 diagnostic (EFFX4307) and no file change.
6. **Reproducible.** Two regenerations on one commit give byte-identical descriptions, vectors and provenance. Probe: two `models check` runs of the `teams` probe gave the same vectors file (sha256 `5994251b…ba417`).
7. **No dependency.** `git diff` shows no change to the catalog or `bun.lock` for effx, and `bun run ready` passes with `java`, `alloy6` and `nix` absent from `PATH`.
8. `bun run ready` exits 0.

## Out of scope

Running Alloy in `ready`; replaying traces through handlers (effx's later slice); exporting entities, relationships, events or roots; precise command effects (`writes`); the HTTP API; Quint, TLA+ and Cedar; any change to effx.

## Open gates

- **G1 (operator).** Whether `@alchemy.run/domain` can subsume the kernel and effx's model. If it does, this spec is withdrawn or rewritten to export to that model. If the kernel stays, the spec goes ahead as drafted. From its landing page the package models commands, aggregates, events, views, projections and policies, tested in memory by stories and hosted on Durable Objects. The page shows no grant table, no subject sets, no transition tables and no generated model or vectors; the sub-pages were not read. It is published (`@alchemy.run/domain@2.0.0-beta.84`, peers `effect ^4.0.5` and `alchemy 2.0.0-beta.84`; this repository pins `alchemy 2.0.0-beta.83`), so it would be installed from the catalog.
- **G2 (operator).** A job in `.github/workflows/checks.yml` that checks out `phibkro/effx` at the pin, installs Nix and runs the regeneration in verify mode. It needs minutes of CPU and no secret. Stand-in: the check runs on the developer's machine and in review; approval is one workflow file.
- **G3 (effx).** Publication of `@effx/*`, which would replace the script and not the artefacts.
- **G4 (operator).** The retention of vectors: each regeneration adds about 1 MB of compressed vectors to history. Stand-in: plain files in git.

## Effx-side gaps found (issues to file when the hold ends; none filed)

1. `@effx/*` are unpublished, and the workspace root cannot be installed as a git dependency.
2. `effx models check` takes a description only through a config module (`domainModel(domain)`). A consumer that holds the description as JSON must write one around it.
3. `ConformanceVectors` carries no digest of its description, so a consumer cannot show which description a vectors file belongs to; the sidecar `provenance.json` does that here.
4. effx has no subject for an anonymous caller and none for a credential holder, so public commands cannot be granted in a description.
5. Context fields are ordered values only; a guard over ids or flags has nowhere to declare its operands.
6. Vectors are about 94 MB of JSON for a three-state machine at scope 1. A compact or compressed output would help every consumer.

## Investigation record (2026-10-27, nothing here is committed code)

- `npm view @effx/domain-model`, `@effx/ir`: E404. `npm view effx`: E404 ("Unpublished on 2025-09-28"; an unrelated name).
- `git ls-remote https://github.com/phibkro/effx` works without a login; `gh repo view`: public; `main` is `ce9c164d`.
- Option B: the `bun add` error quoted above.
- Alloy: `nix shell <effx>#alloy6 -c alloy6 version` prints `6.2.0` in 1.8 s (effx's flake pins nixpkgs `1f607aa7`).
- effx's own example (`examples/domain-model`, scratch copy of the archive at `ce9c164d`): `effx build` and `effx models check` took 63 s; A1 to A7 passed; 28,072 instances; 94,252,772 B of JSON, 772,897 B with `gzip -9`, 315,002 B with `zstd -19`.
- Probe: the `teams` domain translated by hand (its 12 commands and 2 reads; the four declared rows and the Admin row; the Membership machine with its 8 transitions and guards, and 2 calculated transitions; one job). effx decoded it strictly (names, references and guard paths), A1 to A7 passed at scope 1 and 4 steps, with three EFFX4311 warnings (admin expiry and the two calculated transitions). 18,764 instances; 92,683,409 B of JSON, 754,434 B gzip, 234,179 B zstd; 57 s wall, 1 m 39 s CPU. A second run produced the same bytes.
- Probe, kernel side: a 100-line script (not kept) built kernel values from the vectors and compared `authorizeWith(TeamsDomain.table)` and `MembershipMachine.transitions[i].accepts`: 611,324 and 589,824 rows, no disagreement, 2 s; the three mutants of falsifier 3 produced the counts given there.
- Not yet measured: the vectors of all seven descriptions with all three jobs, and a second department and person (scope 2). At scope 1 the world has one person, one team and one department, so a cross-department or cross-person mutant that is wrong only with two of them is not caught; the plan measures scope 2 for the domains without machines before choosing.

## Plan, when the hold ends

1. The two new declarations (`terminal`, field kinds, the memberships binding) in `Machine.make` and `declareDomain`, with type tests and the existing sample domain updated.
2. `describe` and the `Gap` union in the kernel, with a negative control for each gap and each translation.
3. The tool package: `generate`, `generate --check`, canonical JSON and digests.
4. The adapter and the conformance test, with the in-process mutants.
5. `regenerate`, a first run for the seven descriptions, the artefacts and `provenance.json`.
6. Wiring into `bun run ready`, the README of `packages/domain`, ADR 0009's consequence ("no slice depends on an unpublished effx package" stays true: the dependency is on files) and `STATE.md`.
7. The issues on `phibkro/effx`.
