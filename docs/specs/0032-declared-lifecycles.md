# Spec 0032: Declare the Account, Person and Team lifecycles

**Status:** implemented; scoped verification complete (2026-11-12), frozen when its PR opens. **Branch:** `feat/declared-lifecycles`, isolated worktree `worktrees/reimagined-lifecycles`, from `origin/main` `3f1d716875aad456f11476a4e6e6c25dc6d42b92`. This spec is revised through dated entries below.

## Goal

The declarations must describe the Account, Person and Team lifecycles that the application executes. Generated reference diagrams must include ends caused by another domain. The effx export must either represent each declared fact faithfully or name its omission as a typed `Effx.Gap`, with a closure. A drawing that silently omits an account's deletion or a person's tombstone is not an acceptable model.

## Journey

1. Staff create a person and invite them to an account. Account invitation, activation, deactivation and reactivation retain their current guards.
2. A person requests erasure. Under the admin-list lock and then the Person lock, the command refuses to remove the last Active administrator or to proceed through a blocking legal hold. Otherwise the person becomes anonymised and any account is deleted in the same domain transaction. Repeating erasure changes nothing. Provider deletion remains post-commit outbox work, not a claim that the provider has already erased anything.
3. Staff merge two identifiable records. The source becomes an anonymised merged tombstone; references and any single account follow the survivor according to the existing catalog. A merge is not account deletion merely because the source becomes a tombstone. Verification of an applicant's email can cause the same merge. Applying retention can anonymise an eligible person and end their account; report-only retention changes neither lifecycle.
4. Staff deactivate a Team: Active becomes Inactive, with no reactivation command. Inactive teams refuse creation, extension and moves into them, but permit ending, cancellation and moves away. Existing memberships remain independently semester-derived.
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
- **Membership admission (R2):** Inactive teams refuse `createMembership`, `extendMembership` and `changeMembership` targeting them. They permit `endEarlyMembership`, cancellation of a Planned membership and a move away to an Active team. Deactivation does not end existing memberships; prohibiting those exits would strand people in a dead team. Serialize extend versus deactivation through an existing row-lock pattern and test both outcomes.

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
| F6 | Team projection and declaration match create/deactivate. Creation, extension and moves into Inactive teams refuse without mutation; early end, planned cancellation and moves away succeed. A deactivate/extend interleaving cannot prolong presence after deactivation. | Remove the extension admission check or its serialization; refusal/race assertions fail. Wrongly apply that refusal to endEarly; its successful-exit assertion fails. A held-row-lock witness distinguishes waiting from invisible uncommitted writes. |
| F7 | Contribution target states/commands are typed; whole-system completeness rejects dangling/mismatched references. Kernel imports remain generic and ordinary local command inference remains narrow. | Malformed contribution fixture and feature-import fixture fail the real validators; negative type assertions fail if the command bound is widened. |
| F8 | Generated diagrams, descriptions, typed gaps, closures and committed vector provenance derive from the declarations. Each supported machine answers the committed vectors. | Delete/rename one contributed edge, omit its gap, alter a generated artifact and widen one local transition in turn; the corresponding drift/conformance assertion fails. |

## Verification after approval

- Work against the installed Effect/cohort and toolchain versions recorded in Evidence; installed guidance/source outranks memory. No `effect-house` overlay exists here.
- Use the current `apps/web/README.md`, Vite+ project declarations and existing test entry points to select scoped domain/DB/kernel/docgen/conformance tests. Run them inside `devenv shell -- ...`, including every negative control above.
- Run `devenv shell -- bun run description` (or the current equivalent native `bunx vp run description` task), regenerate docs through their existing task, and run `EFFX_DIR=/srv/share/projects/effx devenv shell -- bunx vp run description:regenerate` against the pin. Commit generated artifacts with code, never hand-edit them.
- Run `devenv shell -- bunx vp check` for format, lint, types and Effect diagnostics; run the touched membership-writes formal check when covered paths change, using its skill and `--touched` support.
- Before each heavy job, record MemAvailable, swap use/rate, memory/CPU/I/O PSI, CPU idle, device utilization and disk free. Admit only with at least 20% remaining headroom after conservative expected demand, keep one owned heavy job at a time and coordinate shared-machine admission. Preserve supervisor custody and observe headroom while it runs.
- Report exact checks and negative controls run, their results, all omitted checks, branch and commits. Never claim the unsupported cross-domain semantics were model-checked merely because supported vectors passed.

## Evidence

The design-only commit was `722c42b`; it contained only this spec and stopped for the requested approval. The lead approved it with R2 before implementation.

Installed authority: Effect, `@effect/vitest` and `@effect/sql-pg` are 4.0.6; the installed toolchain reports `@effect/tsgo` 0.53.1. The manifest pins the remaining Effect cohort to 4.0.6, overrides the two SQLite drivers to that cohort and declares no Effect package patch. Prepare patches the TypeScript/Oxlint tooling. The house overlay is absent. Installed Effect AGENTS, schema/testing/basic examples and the Schema, SchemaRepresentation, RpcGroup, Ref, Cause and Effect sources informed the change; APIs without a dedicated ai-docs example were resolved against that installed source, not another release. No new substitute or suppression was introduced.

### Executed positive checks

| Command | Observed result |
| --- | --- |
| `devenv shell -- bun install --frozen-lockfile` | Passed; pinned app tooling and normal Git hooks installed. |
| `devenv shell -- bun run --cwd apps/web db:generate --name person_merge_pair` | Generated migration and snapshot for the partial unordered-pair index. No hosted migration was applied. |
| `devenv shell -- bunx vp -C apps/web test --project domain --maxWorkers 2` | 48 files, 425 tests passed. |
| `devenv shell -- bunx vp -C apps/web test --project db test/db/declaredLifecycles.postgres.test.ts test/db/personalDataErasure.postgres.test.ts test/db/personalDataMerge.postgres.test.ts test/db/retentionGate.postgres.test.ts test/db/admissionIdentity.postgres.test.ts test/db/liveProof.postgres.test.ts` | 6 files, 104 tests passed. Includes 300 opposing raw merge rounds, 300 deactivate/extend rounds, real shared-lock compatibility/order witnesses, erasure rollback on defect/interruption and implicit applicant merge. |
| `devenv shell -- bunx vp run description` and `devenv shell -- bunx vp run docs` | 11 descriptions and typed gap register generated; marked documentation regions regenerated. |
| `EFFX_DIR=/tmp/effx-ce9c164d taskset -c 0-3 devenv shell -- bunx vp run description:regenerate` | Passed for all 11 exported domains at ce9c164d07909cfd99fbbb439f0f3ac26054e5c7, 162.89 s. Descriptions/vectors/provenance remain byte-identical where the export is unchanged; the expanded gap register changes. |
| `devenv shell -- bunx vp -C tools/effx-conformance test` | 14 tests passed, including vector counts, declaration drift, provenance and negative controls. |
| `devenv shell -- bunx vp -C tools/docgen test` | 3 files, 33 tests passed, including generated-text and declaration controls. |
| `devenv shell -- bunx vp -C tools/quality test test/kernelGeneric.test.ts test/moduleGraph.test.ts test/storePorts.test.ts` | 3 files, 38 tests passed. |

The temporary pinned effx checkout was installed using `devenv shell -- bash /tmp/effx-ce9c164d/scripts/install-public.sh /tmp/effx-ce9c164d --frozen-lockfile --ignore-scripts` (four-CPU affinity). A clean-status check preceded `git -C /srv/share/projects/effx worktree remove /tmp/effx-ce9c164d`, which succeeded after regeneration. The shared checkout received no dependency install or tracked source edit.

### Executed negative controls

Every command below uses the prefix `devenv shell -- bunx vp -C apps/web test`. Mutations were restored in a finally path before subsequent normal checks. Pure declaration/gap controls use the same validators/assertions against changed values inside the maintained tests.

| Falsifier | Mutation and exact scoped suffix | Observed failure |
| --- | --- | --- |
| F1 | Account erase relation changed to Kept; `--project db test/db/personalDataErasure.postgres.test.ts -t "erasePerson anonymises"` | The erased person still had one account; the unchanged rows-left assertion failed. Removing the Account contribution is also caught by the declaration test. |
| F2 | Omit last-admin guard; `--project db test/db/personalDataErasure.postgres.test.ts -t "last Active administrator"` | The required last-admin refusal disappeared. |
| F2 | Omit blocking-hold guard; `--project db test/db/personalDataErasure.postgres.test.ts -t "a blocking hold"` | Erasure succeeded instead of returning the hold refusal. An earlier isolated attempt was NOT counted as evidence because its fixture had only one administrator; the fixture and refusal-text assertion were corrected, its normal case passed, then this control failed for the intended reason. |
| F3 | Give the anonymised marker precedence over the merge projection; `--project domain test/domain/kernel/lifecycle.test.ts -t "F3:"` | Merged/Anonymised projection assertion failed. Every creating/ending cause has a removed-contribution control; applying/report-only retention has the existing reversed-mode controls in retentionGate. |
| F4 | Change account merge Single to Drop; `--project db test/db/personalDataMerge.postgres.test.ts -t "moves every row"` | Survivor had no account instead of one. |
| F4 | Omit identifiable-source/target guards; `--project db test/db/declaredLifecycles.postgres.test.ts -t "an anonymised record cannot"` | The real merge was allowed instead of typed Conflict. |
| F5 | Drop only the new index in a disposable transaction (maintained SQL control) | The forbidden mutual pair succeeded past all older constraints. Rebuilding the index over that pair failed without repairing either row; outer rollback restored the real index, which refused the pair again. |
| F6 | Remove `FOR SHARE`; `--project db test/db/declaredLifecycles.postgres.test.ts -t "extension waits behind"`, five executions | All five failed with zero waiting backends instead of one. This is a catalog-observed waiting witness, not an invisible-row assertion. |
| F6 | Omit inactive admission, then omit the final declared-admission call; `--project db test/db/declaredLifecycles.postgres.test.ts -t "inactive teams refuse extension"` | Each mutation allowed the extension instead of returning ValidationFailed. |
| F6 | Incorrectly refuse inactive early exits in beginTransition; same suffix | The early-end half failed with Conflict: the test detects stranding as well as unlawful extension. |
| F7 | Clone target identity, name an unknown command/state, leave a terminal state, duplicate independent contributions or make a requirement change state (maintained declaration controls) | The real allProblems validator rejected each. Type assertions defend narrow local command and target-state types without suppressions. |
| F8 | Remove a contributed edge/gap, change a generated character, mutate local guards or vectors/provenance (maintained domain/docgen/conformance controls) | The same equality/drift/conformance checks rejected the changed values. All those suites passed after restoration. |

There were 14 intentional source-mutation test failures counted as evidence, including the five lock-removal runs; the invalid first isolated hold attempt is excluded. No mutant or throwaway script remains.

### Resource and coverage limits

Headroom was sampled with free, vmstat, PSI and two /proc/diskstats samples, plus filesystem free space, before heavy admissions and during long jobs. Representative admissions: privacy regression 21,758 MiB available, 40,075 MiB swap free, 89% CPU idle, NVMe busy 0/0.3%, expected demand 3,072 MiB/two CPUs; corrected effx regeneration 22,664 MiB available, 39,292 MiB swap free, 88% CPU idle, NVMe busy 0/0.05%, expected demand 8,192 MiB/four CPUs. CPU/memory PSI was near zero at those admissions; I/O PSI was high (some around 52–59%) despite idle devices and was reported rather than mistaken for device utilization. Disk free was about 378 GiB in the application filesystem and 256 GiB for /tmp, far above the expected writes. In-flight privacy observation retained 20,794 MiB and 85% CPU idle; corrected effx observations retained over 22,000 MiB. The one below-threshold exploratory job and its attributed cancellation are recorded in R4. No further heavy job was launched while one owned heavy job was running.

Alloy conformance covers the supported exported subset only. Privacy transitions/transfers and Team prerequisites are explicit typed gaps, not Alloy proofs. The maintained membership and TeamPresence TLC models have their own bounds and SQL witnesses; their confirmation is recorded separately below. Workspace ready/test:all, production build, full browser E2E and an unpinned effx drift run were not run for this scoped slice. No push, PR, deployment, real-provider write or production migration was performed.

### Maintained formal confirmation

The checked product source is `7d68cb1a43370a622bce6cf8f808e4a3717447d1`. The formal coverage digest is `5d6ac3ed1bbf1d5f18bb86abffdb3bd930d808c1`; it covers the new lifecycle projection and machine helper as well as the previously covered code.

- `TLC_WORKERS=4 TLC_HEAP=2g devenv shell --profile formal -- .agents/skills/verify-membership-writes/run.sh --code`: all **37** cases were as expected; **62** PostgreSQL probes passed in 86 s. The initial command exited **3 only because its coverage digest was deliberately stale**, not because a model or SQL check failed. Outputs/configs: `/tmp/verify-membership-writes.zO43nj`. Only after these results were inspected were sync-digest and confirmed-at refreshed.
- `TLC_WORKERS=4 TLC_HEAP=2g devenv shell --profile formal -- .agents/skills/verify-membership-writes/run.sh`: full confirmation exited **0**, all **37** cases as expected, in 209.15 s, with matching covered-source digest. Outputs/configs: `/tmp/verify-membership-writes.MghP0X`.
- `devenv shell -- .agents/skills/verify-membership-writes/run.sh --touched origin/main`: `touched`, exit 0. This reports applicability, not a model proof.

Current-code visited **2,468,125** states for the existing membership safety properties. TeamPresence visited **272,464** states for Person-before-Team order, no wait cycle, no presence commit after deactivation, and no refusal of an otherwise admissible exit solely because the Team is inactive. The new missing-share variant violates NoPostDeactivatePresence (the inspected trace commits deactivate then create); taking Team before Person violates PresenceOrder; blocking exits violates ExitsNeverRefused (the inspected trace refuses an early end after deactivation). The three reachability goals found waiting, a presence commit and an inactive-Team exit. No goal or broken variant was skipped or weakened.

Bounds: the membership model retains three commands, one Person, two Teams and semesters 1–4; its added Team step projects away Team waits/refusals. The companion checks up to three transactions, two Persons and one Team with cancellation, assuming authority and term admissibility. They are separate models, not an automatically checked product construction. Person/Account erasure and merge, raw mutual-merge exclusion, provider effects and whole-system deployment are not proved by these models: their stated evidence is the domain/SQL tests, 300-round races and typed effx gaps.

Formal admission measurements were 20,138/20,442 MiB available, 39,620/38,279 MiB swap free, 83% CPU idle, and NVMe busy 0/0.75% and 0/0.65%, against expected demand 3,072 MiB/eight CPUs and a 2 GiB TLC heap/four workers. CPU and memory PSI avg10 were zero at those admissions; I/O PSI some avg10 was 38.86/36.35%. In-flight observations retained at least 19,205 MiB and 66% idle CPU; the post-refresh observation retained 20,567 MiB and 84% idle CPU. Owned PostgreSQL was stopped with `devenv down` after SQL verification. The stronger per-edge controls were then exercised by another full domain run: 48 files, 425 tests passed, and were committed separately as `ee2c91d` without changing covered product source.

## Open operator-owned questions (unchanged)

- Does the legacy info meeting return, potentially as an ADR 0013 Activity type?
- Should applicants see “invited to interview” now that scheduling moved to Calendar (spec 0008)?

Neither question is decided by this lifecycle work.

## Revisions

- **2026-11-12 — R1, design for approval:** recorded base-source findings, selected typed transition contributions at the causing domain, rejected owner-end shorthand for a Person that is anonymised rather than deleted, proposed direct mutual-merge exclusion as a store guarantee, exposed the uncovered inactive-team membership paths and defined falsifiers with required negative controls. Implementation is held at the explicit lead-approval gate.
- **2026-11-12 — R2, lead approval:** D1/D3/D4/D5 approved. Corrected D2/F6: inactive teams prohibit new or prolonged presence, not exits. Deactivation leaves existing memberships Active, so refusing early end, planned cancellation or change-away would strand memberships. Implementation proceeds with creation/extend/move-to refusal and end/delete/move-away allowed.
- **2026-11-12 — R3, implementation refinements and formal scope:** the lead authorised narrow membership-model maintenance in addition to the initial slice. Team admission is a state-only `requires` contribution for create/extend/move-to, not an unregistered Boolean helper or a fake Team-creation transition. Runtime checks read that contribution; early exits have no such prerequisite. effx cannot state the inter-machine requirement, so `StateRequirement` records it and Team is explicitly omitted from the per-domain Alloy export; Membership retains its existing vectors with that limitation disclosed. `Effx.describe` now requires the whole assembly explicitly, so callers cannot silently omit incoming contributions. Local and incoming unsupported guard gaps are retained. A verified-address holder is an explicit guard of the implicit merge branch. The legal-hold test was made independent of earlier tests by seeding another active administrator and checking the hold's own refusal text.
- **2026-11-12 — R4, isolated tooling and resource custody:** the shared pinned effx checkout had no dependencies and its first regeneration failed EFFX2701. Per lead authority, the pin was checked out in disposable `/tmp/effx-ce9c164d` and installed using its public frozen installer with scripts disabled; shared source was untouched. An exploratory export with the extra standalone Team machine exceeded the admitted memory demand: its owned Alloy Java process reached 10,221,208 KiB RSS and MemAvailable fell to 12,011 MiB of 64,220 MiB (below 20%). The owned supervisor job was cancelled; no partial vector publication occurred. The corrected declaration includes the previously missing inter-machine Team prerequisite and reports its unsupported semantics explicitly, independently of this resource failure. Regeneration uses four-CPU affinity, one heavy job at a time, and observed remaining headroom.
- **2026-11-12 — R5, scoped verification:** the final domain suite passed 425 tests; the six-file SQL/privacy/proof run passed 104 tests; conformance passed 14, docgen 33 and selected quality gates 38. The pinned effx regeneration completed all 11 domains in 162.89 seconds and its disposable tool worktree was removed after a clean-status check. `devenv shell -- bunx vp check` passed with 885 formatted files and 684 clean lint/type files. The draft version-lookup wording now points to observed installed versions. Fourteen valid source-mutation controls failed for the intended defended behavior; the first invalid isolated hold attempt is excluded. The maintained formal-model confirmation is separate from these results.
- **2026-11-12 — R6, formal closure and cleanup:** all 37 maintained formal cases and 62 SQL probes passed their semantic checks before the coverage digest was refreshed; the subsequent full formal confirmation exited 0 with the matching digest. The new Team variants and reachability traces were inspected and the exact bounds/abstractions are recorded above. The six Person causes now each have an independent removed-edge control; the full domain suite passed 425 tests again. The disposable effx checkout and owned PostgreSQL were cleaned up. No publication or provider write was performed.
- **2026-11-12 — R7, cross-slice comment alignment:** the docs lane confirmed that ADR 0016 is a proposal, not an accepted operator decision. Removed the admission machine comment's obsolete promise that later specs add stored Application.Placed (and its other future-state promises). The code comment now describes only implemented Submitted/Withdrawn behavior. No planned state or operator-owned decision was implemented by this cleanup.
