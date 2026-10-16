# State

**Lifecycle:** build (Phase 1 scaffolded; slice 0001 spec not frozen until slice 0000 passes)

## Done

- Phase 1 architecture approved at Checkpoint 2 (2026-10-15).
- Scaffolded and verified: `packages/domain` (98 tests), `packages/db` (36, 23 on real PostgreSQL), `tools/import` (19, real MySQL → PostgreSQL round trip), `apps/web` (53 tests, build, dev-server journeys). 206 tests executed, 206 passing, 0 pending.
- Slice 0000 ran on a deployed Worker → Hyperdrive (cache off) → Neon `dev` → `@effect/sql-pg` → Drizzle `effect-postgres`: 12 of 12 checks pass (`docs/specs/0000-results.md`). The first run failed check 3b because the Worker lacked `enable_request_signal`; the flag is now in the shared Worker config. `tools/db-path-spike` has 39 tests.

## Next

1. Freeze `docs/specs/0001-departments-and-semesters.md` and build it to its falsifiers. Slice 0000 no longer blocks it, on one condition: `enable_request_signal` stays in `apps/web/worker.config.ts` (`docs/specs/0000-results.md`).
2. Phase 1 exit: page-by-page diff against legacy, CI on pull requests.

## Blocked on the operator

- Whether the slice 0000 spike stays deployed as the preview smoke test or is torn down (`tools/db-path-spike/README.md`). It stays until the operator decides.
- Authority to copy the production upload directories (file migration).
