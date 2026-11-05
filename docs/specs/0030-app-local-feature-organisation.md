# 0030 — App-local feature organisation

**Status:** Proposed; organisation decisions await operator approval. This spec records the requested cutover, not acceptance or verification of the resulting tree.

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

Operator approval of the proposed boundaries is pending. The integrating lead owns verification after all writers finish; no result for this cutover is asserted here. Earlier prototype and regrouping evidence is recorded in `STATE.md` and specs 0028–0029, with its original scope and limits.

## Revisions

- 2026-11-05: Recorded the requested app-local organisation and the explicit decision to retain tooling under `tools/`.
- 2026-11-05: Recorded form-state and HTTP error ownership and the generated-route cycle exclusion discovered during consolidation.
- 2026-11-05: Recorded the precise generated registration-edge exception, app-wide compiler strictness and formal test concurrency.
- 2026-11-05: Recorded serial workspace test tasks to prevent quality probes racing app scanners.
