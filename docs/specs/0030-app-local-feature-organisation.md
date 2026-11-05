# 0030 — App-local feature organisation

**Status at c95ce8d:** Implemented and verified locally; organisation decisions then awaited operator approval. No hosted release.

## Goal

A contributor can find a feature's rules, server functions, forms and components together without crossing artificial domain and database package boundaries. Shared infrastructure remains explicit and tooling stays under `tools/`.

## Boundaries proposed for approval

- Put feature-owned domain code in `apps/web/src/features/<feature>/domain`, including `personal-data` in kebab case. Separate CMS content from events; each has its own feature domain.
- Keep the kernel, outbox, jobs and declaration assembly in `apps/web/src/domain`. Transaction, aggregate and integration-guard contracts live in `domain/transactions`; store guarantees, modes and platform contracts in `domain/store`; the shared outbox contract in `domain/outbox/outbox.ts`. IDs, errors, validation, clock and site origin live at the domain root, with no `domain/shared` catchall. Use direct concrete-module imports, not package barrels or compatibility shims.
- Put the database implementation in `apps/web/src/adapters/db`, migrations in `apps/web/drizzle`, and database tests in `apps/web/test/db`. Domain tests live in `apps/web/test/domain`; conformance artefacts live in `apps/web/conformance`.
- Put Supabase clients and storage, messaging, Turnstile, Cloudflare rate limiting, Workspace and Web Crypto behind app adapters. Keep identity in the server where provider verification is combined with current domain account authority.
- Colocate feature functions, forms and components. TanStack routes remain in the route tree. Replace the generic `lib` grouping with adapters and utilities according to responsibility.
- Put the shared client/server HTTP outcome in `apps/web/src/http/outcome.ts`, not generic utilities. Put synthetic local people in `apps/web/test/fixtures`.
- Feature `formState.ts` modules own form-state contracts without importing handlers. Shared `src/http/requestError.ts` owns request-error schema and types; shared outcome code does not depend on the server error table. Consumers import success outcomes directly from the outcome module. These moves do not change schema, status or wire behavior.
- Exclude only the type-only `routeTree.gen.ts` → `router.tsx` registration edge from cycle checks. Other cycles through the generated route tree and ordinary source remain checked, with a negative control.
- Keep every tool under `tools/`. The operator explicitly rejected moving tools into apps.
- Apply the former domain and database compiler strictness to the app: `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` and `noImplicitOverride`. Correct exposed web optional-property and cardinality contracts rather than weakening moved code.
- The formal model `--code` run uses `--maxWorkers=1` to preserve the former database test-file concurrency.
- Run root `test:all` workspace tasks serially (`--concurrency-limit 1`): quality tests write probe modules in app source, so app scanners must not race those fixtures. This does not change Vitest's internal worker limits.
- The duplication check ignores static import declarations, including multiline imports, so repeated dependency lists do not count as executable duplication. Its zero threshold remains; an executable-duplicate negative control must still be detected.

## Constraints

This is an organisation change, not a runtime, API, schema or provider change. Contract extraction and stricter UI preconditions change types, not domain algorithms. Preserve transaction and lock discipline, Effect service identities, request authority and due-aware outbox behavior. Preserve unknown CMS codex fields. Do not change credentials, publish, deploy or make hosted external changes as part of the cutover. Verification may use owned local synthetic Supabase services. Existing historical evidence remains evidence of its original revision only.

## Falsifiers and acceptance

- A feature's domain or presentation code remains in the old shared packages, or a caller still relies on their barrel or shim.
- A shared construct, database adapter, migration, test, conformance artefact or tool is placed outside its boundary above.
- Existing behavior, transaction and lock semantics, service identities, authorization, CMS unknown fields or provider boundaries change.
- The workspace's maintained static, test and build gates fail after the move; local provider and browser journeys must be evaluated separately on an owned synthetic target.
- Contributor instructions still direct current work to removed paths or present old infrastructure as current.

## Evidence and decisions

Operator approval of the proposed boundaries is pending. The following local verification ran at source checkpoint `c95ce8d0c95f535fb84b0f1afcc13a4ecd7cd245`. Subsequent documentation/provenance-only edits do not change that source; the full tests were not rerun for them. Earlier evidence remains in `STATE.md` and specs 0028–0029, with its original scope and limits.

- Root `test:all` passed seven workspace tasks and nine test groups: domain 419, database 449, web 272, spike 39, quality 93, import 54, docgen 33, Oxlint 114 and conformance 14; total 1,487 tests. An earlier concurrent import timeout was followed by an isolated pass of 14 import tests and the final full run.
- Format, lint and type checks passed (894 formatted files, 681 code files), as did exceptions, store and module-graph checks (20 modules, no tolerated violations), seven generated-document checks, Knip and duplicate detection (zero clones). Frozen Bun install made no changes; Drizzle `db:check` and a fresh production Worker build passed.
- The formal model `--code` run exited zero: 30 maintained cases matched expectations, 1,712,396 current-code states and 53 PostgreSQL probes. The source coverage digest was `7e1d51b0c40a43c60c4f64f26ec9a9110978c98e`. Model predicates and bounds were unchanged; this result covers membership concurrency only.
- On an owned local synthetic stack, a compiled Worker browser journey signed in as Ada, created a team, person and membership, and observed the membership after reload. Runtime-role SQL showed one membership, one welcome claim, one `membership.added` audit entry, two outbox intents, two deliveries and two captured messages. A CMS fixture's title and rich text were edited and published; exact future root, block and span projections were preserved in draft and publication. An anonymous team GET returned 403 and the public home returned 200.
- An emitted-artifact scan covered 377 JS, MJS, JSON and map files and found no literal bootstrap or runtime database URL or SDK secret; manifest secret bindings were empty. Two credential no-JavaScript Playwright cases passed; the full browser suite was not run.
- Unused export surfaces and dead pure helpers were removed. The declared Audit read was retained with a permission regression test. All work and verification were local: no PR, push, deployment or Terraform external operation was performed.
- The owned browser, compiled preview, Supabase project and devenv services were stopped after verification. Supabase volumes and matching private credentials were retained. The original interactive prototype was left running and returned HTTP 200 after cleanup.

The local journey and model do not establish hosted provider lifecycle, deployment privileges or full-browser coverage. Initial browser selector/navigation attempts and an SQL audit-action guess were corrected against the actual DOM and source; the membership committed and was observed after reload, not rolled back. Earlier static, probe and mock-test failures were corrected before the final reports.

## Revisions

- 2026-11-05: Recorded the requested app-local organisation and the explicit decision to retain tooling under `tools/`.
- 2026-11-05: Recorded form-state and HTTP error ownership and the generated-route cycle exclusion discovered during consolidation.
- 2026-11-05: Recorded the precise generated registration-edge exception, app-wide compiler strictness and formal test concurrency.
- 2026-11-05: Recorded serial workspace test tasks to prevent quality probes racing app scanners.
- 2026-11-05: Recorded the lead's local verification at the named source checkpoint; approval remains pending.

## Follow-up: core and native Vite+ workflow (2026-11-05)

The operator’s proceed authorizes this cutover. The prior proposal and the evidence at `c95ce8d0c95f535fb84b0f1afcc13a4ecd7cd245` remain historical records, not evidence for this new tree.

The app-shared foundation now lives in `apps/web/src/core`. It is not a reusable package. Portable assembly registries remain in core, not server. Feature-owned rules remain in `features/<feature>/domain`; domain tests and the domain test project retain their names. All tools remain in `tools/`. This relocation does not authorize changes to behavior, SQL, service identities, modeled predicates or unknown CMS codex fields.

Native Vite+ tasks replace duplicated root scripts. Bun retains root lifecycle `prepare` and `commitlint`. `vp run ready` runs static dependencies, then serial `test:all` and a fresh build. `vp run @vektorprogrammet/web#test` gates domain, db and web tasks in order. `vp test --project <name>` runs a direct scope; bare `vp test` can continue later groups after failure. Live, probe, generator and security tasks disable caching. The cached app build fingerprints `SITE_URL`, `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`; release uses the built-in fresh build.

The existing formal digest and confirmed commit remain historical until the lead reviews and confirms a new committed tree. No cutover verification is asserted by this follow-up.

### Cutover evidence

- Native CLI discovery found 137 app test files: 47 domain, 52 db and 38 web. The groups were disjoint and exhaustive. An injected domain failure ran 419 passing tests and one intentional failure, and prevented the db and web tasks. The probe was removed.
- An outside-repository graph with the exact ready → serial test-all recipe showed no workspace overlap at outer concurrency 2. Its final build-stage probe ran after both workspaces.
- Native build cache testing exposed a deploy-pointer read/write issue and parent-directory tracking. The configuration now excludes generated `.wrangler/**` inputs and explicitly preserves `.wrangler/deploy/config.json` as output. A warmed hit restored deleted client JS and the deploy pointer byte-for-byte. Changing `SITE_URL` missed and produced the new binding; restoring it hit the baseline. A fake private environment change caused a conservative miss, not a hit; manifest private bindings stayed empty. A cache database literal audit found no actual SDK secret or runtime URL.
- The first full ready run passed seven of eight static dependencies and failed lint on key ordering. No tests or build ran in that attempt. The ordering was corrected with native suggestions. A new full ready run has not yet completed; this is not full acceptance.
