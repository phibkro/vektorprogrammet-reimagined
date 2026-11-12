# Spec 0032: Declare the Account, Person and Team lifecycles

**Status:** design awaiting lead approval; implementation has not started. **Branch:** `feat/declared-lifecycles`, isolated worktree `worktrees/reimagined-lifecycles`, from `origin/main` `3f1d716875aad456f11476a4e6e6c25dc6d42b92`. This spec is revised through dated entries below and freezes when its PR opens.

## Goal

The declarations must describe the Account, Person and Team lifecycles that the application executes. Generated reference diagrams must include ends caused by another domain. The effx export must either represent each declared fact faithfully or name its omission as a typed `Effx.Gap`, with a closure. A drawing that silently omits an account's deletion or a person's tombstone is not an acceptable model.

## Journey

1. Staff create a person and invite them to an account. Account invitation, activation, deactivation and reactivation retain their current guards.
2. A person requests erasure. Under the admin-list lock and then the Person lock, the command refuses to remove the last Active administrator or to proceed through a blocking legal hold. Otherwise the person becomes anonymised and any account is deleted in the same domain transaction. Repeating erasure changes nothing. Provider deletion remains post-commit outbox work, not a claim that the provider has already erased anything.
3. Staff merge two identifiable records. The source becomes an anonymised merged tombstone; references and any single account follow the survivor according to the existing catalog. A merge is not account deletion merely because the source becomes a tombstone. Verification of an applicant's email can cause the same merge. Applying retention can anonymise an eligible person and end their account; report-only retention changes neither lifecycle.
4. Staff deactivate a Team: Active becomes Inactive, with no reactivation command. Membership writes against an Inactive team are refused. Existing membership history is not deleted or recast as Ended just because the team becomes inactive.
5. A maintainer regenerates the reference, descriptions and conformance evidence. The reference names the actual causing commands and their guards. Unsupported formal semantics are visible in the generated gap register, not hidden behind an unguarded transition or a made-up command.

## Constraints and values

- Preserve the existing state storage. Person state is derived from `merged_into` and `anonymised_at` (in that order); Team state is derived from `active`. Do not add stored copies of these facts.
- Keep the kernel generic: no feature imports in `apps/web/src/core/kernel`; `tools/quality/test/kernelGeneric.test.ts` remains an acceptance gate.
- Keep command ownership and grants in their existing domains. A lifecycle reference confers no permission and creates no endpoint.
- Reuse `Machine.make`, schema guards, `Machine.available`/`can`, `Domain.allProblems`, existing aggregate locks, personal-data catalog, docgen and effx-conformance tooling. Do not create another transition interpreter or a second privacy rule catalog.
- Preserve the existing transaction order and atomicity. Do not run provider calls inside domain transactions. Last-admin validity remains the existing LK7 exception, not a new store-enforced claim.
- Unknown CMS codex fields, the admission-alert lane's `alerts_enqueued_at`, and the retention/admin-place fix of spec 0026 are out of scope.
- Write only in this worktree. Do not push or create a PR. Commit with pathspecs, Conventional Commits and normal hooks inside `devenv shell -- ...`.
- Correctness by construction, one authoritative transition/guard, generated derivations rather than hand-synchronised diagrams, and evidence distinguished from assumptions.

## Source findings

These are source observations at the base commit, not executed database or model results.

| Source | Observation |
| --- | --- |
| `apps/web/src/core/kernel/machine.ts` | `make` takes one command group. A normal transition can name only its tags. Boundary `[*]` already means row absence. |
| `apps/web/src/core/kernel/domain.ts` | `machineProblems` requires every transition command to belong to that declaration. Whole-system `allProblems` already resolves facts spanning domains. |
| `apps/web/src/features/accounts/domain/declaration.ts` | Account has `terminal: []`, invitation/activation/deactivation/reactivation, but no deletion edge. |
| `apps/web/src/features/personal-data/domain/commands.ts` | Erasure checks last admin and blocking holds after its locks. Merge locks the admin list and both people. |
| `apps/web/src/adapters/db/personalData/{merge,retention}.ts` | Merge anonymises the source and sets `merged_into`; erasure applies the catalog; retention and erasure share the same rules. |
| `apps/web/src/features/accounts/domain/personalData.ts` | An account expires with the person core and a merge uses the existing single-account rule, not unconditional deletion. |
| `apps/web/src/adapters/db/schema.ts`, `apps/web/drizzle/20261027111345_personal_data/migration.sql` | A merge target has a self-FK, a not-self check and an anonymised-source check. None excludes A→B together with B→A. The migrated constraint inventory and a raw-writer experiment will confirm the absence before changing it. |
| `apps/web/src/adapters/db/personalData/merge.ts`, aggregate lock contract | Normal merges already refuse anonymised records and locks refuse merged tombstones. This is a port restriction, not a constraint on arbitrary SQL writers. |
| `apps/web/src/features/teams/domain/commands.ts` | Create and move-to-team reject inactive targets. The shared existing-membership transition path does not check Team activity, so extend/end/delete are not currently covered by that refusal. |
| `apps/web/src/core/kernel/effx.ts`, effx `packages/domain-model/src/DomainDescription.ts` | Descriptions are per domain; transitions name commands in that domain. There is no cross-domain transition-reference or aggregate-cascade field. Existing unsupported guards already yield typed gaps and whole-machine omission. |
| `tools/effx-conformance/README.md` | The current artifact directory is `apps/web/conformance/`, not the historical `packages/domain/conformance/` named in older instructions. The pinned effx revision is recorded in `apps/web/conformance/effx.pin.json`. |

## Design for approval

### D1. Typed transition contributions at the causing domain

Keep a machine's local table and command group unchanged. Add one small, pure kernel construct for a **transition contribution**: it references a typed target machine, takes the causing domain's real `RpcGroup`, and declares additional transitions with the target's state tags and its own schema-checked decision context. Its command names are inferred from that group, not supplied as free strings. Register contributions with the causing domain, beside its commands and grants.

For example, the personal-data declaration contributes `erasePerson` and applying `runRetention` ends to Account and contributes anonymisation/merge edges to Person. It imports lower-level machine declarations; accounts and teams never import personal-data RPC declarations just to discover who can end them. The kernel imports neither feature.

The whole-system declaration assembly resolves these references once for consumers. `Domain.allProblems` rejects a missing target, an unknown state, a contribution not owned by its causing command group, conflicting/ambiguous edges and an outgoing state-changing edge from a terminal state. References use the actual target value; emitted names are derived from it. Docgen reads this resolved view, not a separately maintained list of foreign edges. A contribution uses the same compiled schema-guard machinery as a local transition; handlers check the corresponding declaration rather than repeating its Boolean conditions.

This is descriptive composition, not a new runtime, command bus or permission rule. It does not turn an erasure into several independently callable commands. The adapter still performs one catalog-driven transaction.

**Rejected alternatives:**

- **One merged RPC group for every machine:** makes a foreign command look locally owned, broadens the command types accepted by ordinary account callers, and introduces reverse feature dependencies or declaration cycles. It also cannot explain the different contexts of privacy guards and ordinary account transitions.
- **Move Account to personal-data:** moves invitation/activation authority away from accounts or leaves two tables for one account. The machine has several genuine owners of effects, not a new owner of commands.
- **An unconditional “ends with Person” relation:** Person is not deleted by erasure, and a merge transfers an account rather than unconditionally deleting it. A generic ownership relation is too coarse unless it acquires state/cause predicates that are already transition semantics. The privacy catalog remains authoritative for which rows are expired.
- **Use `calculated` or a sentence-only diagram edge:** `calculated` means clock passage, not another command's transaction. Neither option safely connects the runtime decision, command ownership and export.
- **Create a synthetic `deleteAccount` command:** adds a new authority surface solely to placate the formal model; not an operation the product exposes.

### D2. State projections, guards and coverage

- **Account:** retain Invited, Active and Deactivated; deletion goes from each existing state to Boundary, not to a fake stored Erased state. `terminal: []` is then honest because all states have a declared end. Erasure and applying retention are separate real causes. Merge's account transfer remains a relation/identity change, not an invented state change.
- **Person:** a tagged state projection is Identifiable, Anonymised or Merged. Merged takes precedence because a tombstone also has `anonymised_at`. Anonymised and Merged have no transition back to Identifiable. Erasure is an Identifiable→Anonymised transition with not-last-admin and no-blocking-hold guards; repeated erasure is a successful no-op, not resurrection. Merge is Identifiable→Merged for the source, conditional on a distinct identifiable survivor and the existing merge rules. The implicit applicant-verification merge is declared too. Applying retention declares anonymisation only when the catalog says the core is due; report-only mode has no state change. Creation paths that create Person rows are inventoried and referenced, so the diagram does not begin in an unreachable Identifiable state.
- **Team:** Active→Inactive on `deactivateTeam`; creation starts Active. Read/update behavior and repeated deactivation remain as the existing command contract permits; there is no state-changing edge out of Inactive. Team state does not replace the independent semester-derived Membership state.
- **Membership admission:** per the requested contract, all membership-mutating commands (`createMembership`, `changeMembership`, `extendMembership`, `endEarlyMembership`, `deleteMembership`) refuse Inactive teams. Moves check both the existing team and the target. This deliberately closes the uncovered extend/end/delete paths identified above; it is not described as already enforced on main. The check reads the declared Team lifecycle rather than a second activity rule. Tests pin the decision under deactivation races; any needed serialization uses an existing row-lock/conditional-write pattern, not a new advisory lock.

### D3. Store-enforced direct mutual-merge exclusion

A direct reciprocal tombstone pair is invalid independently of the caller: it has no surviving identity to follow. A store-enforced guarantee is warranted under the repository's invariant policy. Normal domain guards alone cannot protect importers, migrations and raw writers.

Use the smallest store constraint: unique unordered endpoint pairs for non-null merge edges, implemented by a partial unique expression index over `least(id, merged_into)` and `greatest(id, merged_into)`. A→B and B→A claim the same key, including concurrent writers; existing not-self, FK and anonymised-source constraints remain. The new domain guarantee states the property, not this PostgreSQL mechanism.

This guarantee is specifically **no direct mutual merge**. It does not claim arbitrary graph acyclicity; it preserves legitimate chains and existing `Follow` behavior. The normal merge port still refuses any anonymised source or destination. No recursive trigger, new merge graph store or silent flattening is introduced. Existing data is checked before the migration; it must not be silently repaired or deleted.

### D4. Honest formal export

Inspect the pinned effx contract during implementation before choosing export fields. Do not add unsupported JSON fields or copy foreign commands/grants into another domain. A typed cross-domain-transition gap names the causing domain/command, target machine and from/to states, with a closure requiring effx to represent composed cross-domain effects. Add a typed relation/identity-change gap if account transfer cannot be stated. Unsupported Boolean/identity/hold/catalog decision guards retain explicit guard gaps with their own closures.

If the per-domain format cannot represent a machine in full, omit that machine with an explicit `MachineDropped` reason as well as the precise semantic gap; never export a seemingly complete machine with its end removed. Supported local machines still receive normal conformance vectors. A passing vector suite proves only its exported subset, not the gap's runtime semantics; scoped command and PostgreSQL falsifiers cover those facts here.

### D5. Scope and derivation consumers

Implementation owns `apps/web/src`, focused tests under `apps/web/test`, the schema migration under `apps/web/drizzle`, current conformance artifacts under `apps/web/conformance`, spec 0032, generated doc regions and one spec-specific STATE/GLOSSARY entry if needed. Generic contribution support also requires narrowly updating its existing docgen/conformance consumers and their tests under `tools/`; this is part of the design submitted for lead approval, not permission to restructure those tools. Do not edit the sibling's hand-written admission/recruitment/placement/economy sections or formal job-run files.

## Falsifiers and negative controls

Every row requires an executed negative control after approval. A control is an intentional mutation of the defended mechanism run against the same assertion, then restored; an unchanged test that passes alongside a fake demonstration is not evidence. Record exact commands, failure observations and restoration in the evidence section. Lock-removal controls run five times as required by AGENTS.md; concurrent guards use fresh state and print full loser Causes.

| ID | Observable falsifier | Required negative control |
| --- | --- | --- |
| F1 | Each Account state has an erasure end; real erasure commits an anonymised person and no account, retaining audit/history and durable provider-erasure intent. Repeat erasure is a no-op. | Remove the Account contribution: declaration/export/reference completeness fails. Disable catalog account deletion: the real DB journey fails. |
| F2 | Last Active admin and blocking hold each refuse erasure with typed Conflict and no lifecycle/storage/outbox change; nonblocking holds retain their stated behavior. | Bypass each guard separately; its corresponding refusal test fails. A defect/interruption during the transaction still rolls back rather than becoming success. |
| F3 | Person projection distinguishes Identifiable, Anonymised and Merged; all creating/erasing/retention/implicit-verification-merge paths match the resolved declaration. ReportOnly changes nothing and terminal states never return to Identifiable. | Swap the projection precedence or remove each distinct causing edge; the matching projection/completeness journey test fails. Make report-only retention apply and its test fails. |
| F4 | Merge leaves the source Merged, the destination identifiable and a single permitted account on the survivor. Opposing domain merges cannot commit a mutual pair. | Remove anonymised/tombstone refusal under controlled sequencing; the normal merge/refusal assertion fails. Account transfer replaced by deletion fails its survivor assertion. |
| F5 | The real migrated DB rejects a raw A→B/B→A pair, sequentially and in concurrent transactions, while accepting legitimate one-way edges and chains. The guarantee names the same property. | Drop only the new index in a disposable DB; the same raw mutual pair commits and the invariant assertion fails. Concurrent guard: 300 fresh rounds with loser Causes retained on failure. |
| F6 | Team projection and declaration match create/deactivate; every listed membership write refuses inactive source/target as applicable without mutation. A deactivation/write interleaving cannot admit a post-deactivation membership write. | Remove each shared admission check or its serialization predicate; the matching inactive/race assertion fails. A held-row-lock witness distinguishes waiting from invisible uncommitted writes. |
| F7 | Contribution target states/commands are typed; whole-system completeness rejects dangling/mismatched references. Kernel imports remain generic and ordinary local command inference remains narrow. | Malformed contribution fixture and feature-import fixture fail the real validators; negative type assertions fail if the command bound is widened. |
| F8 | Generated diagrams, descriptions, typed gaps, closures and committed vector provenance derive from the declarations. Each supported machine answers the committed vectors. | Delete/rename one contributed edge, omit its gap, alter a generated artifact and widen one local transition in turn; the corresponding drift/conformance assertion fails. |

## Verification after approval

- Establish installed Effect and companion versions, overrides and patches in this worktree; read installed `effect/AGENTS.md` and matching examples/source before TypeScript edits. The manifest currently pins Effect/cohort 4.0.6 and `@effect/tsgo` 0.53.1; this is not yet an installed-version observation. No `effect-house` overlay exists here.
- Use the current `apps/web/README.md`, Vite+ project declarations and existing test entry points to select scoped domain/DB/kernel/docgen/conformance tests. Run them inside `devenv shell -- ...`, including every negative control above.
- Run `devenv shell -- bun run description` (or the current equivalent native `bunx vp run description` task), regenerate docs through their existing task, and run `EFFX_DIR=/srv/share/projects/effx devenv shell -- bunx vp run description:regenerate` against the pin. Commit generated artifacts with code, never hand-edit them.
- Run `devenv shell -- bunx vp check` for format, lint, types and Effect diagnostics; run the touched membership-writes formal check when covered paths change, using its skill and `--touched` support.
- Before each heavy job, record MemAvailable, swap use/rate, memory/CPU/I/O PSI, CPU idle, device utilization and disk free. Admit only with at least 20% remaining headroom after conservative expected demand, keep one owned heavy job at a time and coordinate shared-machine admission. Preserve supervisor custody and observe headroom while it runs.
- Report exact checks and negative controls run, their results, all omitted checks, branch and commits. Never claim the unsupported cross-domain semantics were model-checked merely because supported vectors passed.

## Evidence and approval checkpoint

Design-stage evidence is the source inspection listed above and a clean isolated branch at the stated base. No implementation, schema migration, regeneration, falsifier, negative control, type/lint suite or formal job has run. Only this spec is to be committed before the requested approval stop. No push or PR is authorised by this checkpoint.

## Open operator-owned questions (unchanged)

- Does the legacy info meeting return, potentially as an ADR 0013 Activity type?
- Should applicants see “invited to interview” now that scheduling moved to Calendar (spec 0008)?

Neither question is decided by this lifecycle work.

## Revisions

- **2026-11-12 — R1, design for approval:** recorded base-source findings, selected typed transition contributions at the causing domain, rejected owner-end shorthand for a Person that is anonymised rather than deleted, proposed direct mutual-merge exclusion as a store guarantee, exposed the uncovered inactive-team membership paths and defined falsifiers with required negative controls. Implementation is held at the explicit lead-approval gate.
